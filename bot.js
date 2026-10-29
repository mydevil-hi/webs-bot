import { Bot, InlineKeyboard, Keyboard, InputFile } from "grammy";
import { createClient } from "@supabase/supabase-js";
import JSZip from "jszip";
import http from "node:http";

// ---------- env ----------
const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing env: ${k}`); process.exit(1); }
  return v;
};
const BOT_TOKEN = need("TELEGRAM_BOT_TOKEN");
const GEMINI_KEY = need("GEMINI_API_KEY");
const SB_URL = need("SUPABASE_URL");
const SB_KEY = need("SUPABASE_KEY"); // anon/public key
const VERCEL_TOKEN = need("VERCEL_TOKEN");
const VERCEL_TEAM = process.env.VERCEL_TEAM_ID || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ALLOWED = (process.env.ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);
const HISTORY_LIMIT = 20;

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const bot = new Bot(BOT_TOKEN);

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 6);
const slugify = (s) =>
  (String(s || "site").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "site");

function cleanFiles(files) {
  const out = [];
  for (const f of files || []) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") continue;
    const p = f.path.replace(/^\/+/, "").replace(/\\/g, "/");
    if (!p || p.includes("..")) continue;
    out.push({ path: p, content: f.content });
  }
  return out;
}
function mergeFiles(current, changed, removed) {
  const map = new Map(current.map((f) => [f.path, f.content]));
  for (const f of changed) map.set(f.path, f.content);
  for (const p of removed || []) map.delete(p);
  return [...map].map(([path, content]) => ({ path, content }));
}

// ---------- gemini ----------
const SYSTEM = `You are a senior web developer inside a Telegram bot. The user describes a website; you produce its complete files.
Rules:
- Static site only: HTML/CSS/vanilla JS (no build step, no npm). index.html is mandatory.
- Modern, responsive, polished design. RTL + proper fonts if the user writes Arabic.
- External APIs may be called from the browser with fetch(). Use CDN links only when really needed.
- When editing: you receive the current files. Return ONLY new or changed files in "files" (full content of each, never diffs) and paths to remove in "delete".
- Reply ONLY with JSON: {"name":"short english site name","message":"short summary for the user in the user's language","files":[{"path":"index.html","content":"..."}],"delete":[]}`;

async function gemini(history, userText) {
  const contents = [
    ...history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: userText }] },
  ];
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents,
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 65536,
      temperature: 0.7,
      thinkingConfig: { thinkingBudget: 2048 },
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  let lastErr;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(body),
    });
    if (r.status === 429 || r.status >= 500) {
      lastErr = new Error(`gemini ${r.status}`);
      await sleep(4000 * (i + 1));
      continue;
    }
    const j = await r.json();
    if (!r.ok) throw new Error(`gemini ${r.status}: ${j?.error?.message || "unknown"}`);
    const cand = j.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
    if (!text) throw new Error(`gemini empty (${cand?.finishReason || j.promptFeedback?.blockReason || "?"})`);
    try {
      return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    } catch {
      throw new Error(cand?.finishReason === "MAX_TOKENS" ? "الموقع طلع كبير ونقطع، قله يبسطه" : "gemini رجع رد مو صالح، جرب مرة ثانية");
    }
  }
  throw lastErr || new Error("gemini failed");
}

// ---------- vercel ----------
const vq = (extra = {}) => {
  const q = new URLSearchParams(extra);
  if (VERCEL_TEAM) q.set("teamId", VERCEL_TEAM);
  const s = q.toString();
  return s ? `?${s}` : "";
};
const vfetch = (path, opts = {}) =>
  fetch(`https://api.vercel.com${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });

async function vercelDeploy(slug, files) {
  const r = await vfetch(`/v13/deployments${vq({ skipAutoDetectionConfirmation: "1" })}`, {
    method: "POST",
    body: JSON.stringify({
      name: slug,
      files: files.map((f) => ({ file: f.path, data: f.content })),
      target: "production",
      projectSettings: { framework: null },
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`vercel ${r.status}: ${d?.error?.message || "deploy failed"}`);
  let cur = d;
  for (let i = 0; i < 30 && cur.readyState !== "READY"; i++) {
    if (cur.readyState === "ERROR" || cur.readyState === "CANCELED") throw new Error(`vercel build ${cur.readyState}`);
    await sleep(2000);
    const p = await vfetch(`/v13/deployments/${d.id}${vq()}`);
    cur = await p.json();
  }
  const aliases = (cur.alias || []).filter((a) => a.endsWith(".vercel.app")).sort((a, b) => a.length - b.length);
  return `https://${aliases[0] || cur.url}`;
}
async function vercelDeleteProject(slug) {
  const r = await vfetch(`/v9/projects/${encodeURIComponent(slug)}${vq()}`, { method: "DELETE" });
  if (!r.ok && r.status !== 404) throw new Error(`vercel delete ${r.status}`);
}

// ---------- db ----------
const must = ({ data, error }) => { if (error) throw new Error(`supabase: ${error.message}`); return data; };
const getCurrent = async (uid) =>
  must(await sb.from("user_state").select("current_site").eq("user_id", uid).maybeSingle())?.current_site ?? null;
const setCurrent = async (uid, siteId) =>
  must(await sb.from("user_state").upsert({ user_id: uid, current_site: siteId }));
const getSite = async (id, uid) =>
  must(await sb.from("sites").select("*").eq("id", id).eq("user_id", uid).maybeSingle());
const listSites = async (uid) =>
  must(await sb.from("sites").select("id,title,url").eq("user_id", uid).order("updated_at", { ascending: false }).limit(50));
const getHistory = async (siteId) => {
  const rows = must(await sb.from("messages").select("role,content").eq("site_id", siteId).order("id", { ascending: false }).limit(HISTORY_LIMIT));
  return rows.reverse();
};
const addMessages = async (siteId, userText, assistantText) =>
  must(await sb.from("messages").insert([
    { site_id: siteId, role: "user", content: userText },
    { site_id: siteId, role: "assistant", content: assistantText },
  ]));

// ---------- ui ----------
const BTN_SITES = "🌐 مواقعي";
const BTN_NEW = "➕ موقع جديد";
const menu = new Keyboard().text(BTN_SITES).text(BTN_NEW).resized().persistent();
const siteKb = (id, url) =>
  new InlineKeyboard().url("🔗 فتح", url).text("✏️ تعديل", `edit:${id}`).row().text("📦 الملفات", `files:${id}`).text("🗑 حذف", `del:${id}`);

async function showSites(ctx) {
  const sites = await listSites(ctx.from.id);
  if (!sites.length) return ctx.reply("ماكو مواقع بعد. اكتب وصف الموقع وأبدأ.", { reply_markup: menu });
  const kb = new InlineKeyboard();
  for (const s of sites) kb.text(s.title, `open:${s.id}`).row();
  return ctx.reply(`مواقعك (${sites.length}):`, { reply_markup: kb });
}
async function sendZip(ctx, slug, files) {
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.content);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await ctx.replyWithDocument(new InputFile(buf, `${slug}.zip`));
}

// ---------- core ----------
const busy = new Set();

async function runBuild(ctx, site, text) {
  const uid = ctx.from.id;
  const status = await ctx.reply(site ? "⏳ أعدل الموقع..." : "⏳ أسوي الموقع...");
  const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);
  try {
    const history = site ? await getHistory(site.id) : [];
    const prompt = site
      ? `CURRENT FILES:\n${JSON.stringify(site.files)}\n\nUSER REQUEST:\n${text}`
      : text;
    const out = await gemini(history, prompt);
    const changed = cleanFiles(out.files);
    if (!changed.length) throw new Error("ما طلعت ملفات، وضح طلبك أكثر");
    const files = mergeFiles(site?.files || [], changed, out.delete);
    if (!files.some((f) => f.path === "index.html")) throw new Error("index.html مفقود، جرب مرة ثانية");

    const slug = site?.slug || `${slugify(out.name)}-${rand()}`;
    const url = await vercelDeploy(slug, files);

    let id = site?.id;
    if (site) {
      must(await sb.from("sites").update({ files, url, updated_at: new Date().toISOString() }).eq("id", id));
    } else {
      const row = must(await sb.from("sites").insert({ user_id: uid, title: String(out.name || slug).slice(0, 60), slug, url, files }).select("id").single());
      id = row.id;
      await setCurrent(uid, id);
    }
    await addMessages(id, text, String(out.message || "تم"));

    await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    await ctx.reply(`${out.message || "تم"}\n\n${url}`, { reply_markup: siteKb(id, url) });
    await sendZip(ctx, slug, files);
  } catch (e) {
    console.error(e);
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, `❌ ${e.message}`).catch(() => ctx.reply(`❌ ${e.message}`));
  } finally {
    clearInterval(typing);
  }
}

// ---------- middleware ----------
bot.use(async (ctx, next) => {
  if (!ctx.from) return;
  if (ALLOWED.length && !ALLOWED.includes(String(ctx.from.id))) return ctx.reply?.(`🚫 مو مسموح. id مالك: ${ctx.from.id}`);
  return next();
});

// ---------- commands ----------
bot.command("start", (ctx) =>
  ctx.reply("اهلا. اكتب وصف الموقع الي تريده وأسويه وأرفعه.\n\n/newweb موقع جديد\n/mysites مواقعي", { reply_markup: menu })
);
const newWeb = async (ctx) => {
  await setCurrent(ctx.from.id, null);
  return ctx.reply("🆕 موقع جديد. اكتب المواصفات.", { reply_markup: menu });
};
bot.command("newweb", newWeb);
bot.hears(BTN_NEW, newWeb);
bot.command("mysites", showSites);
bot.hears(BTN_SITES, showSites);

// ---------- callbacks ----------
bot.callbackQuery(/^open:(.+)$/, async (ctx) => {
  const s = await getSite(ctx.match[1], ctx.from.id);
  await ctx.answerCallbackQuery();
  if (!s) return ctx.reply("الموقع مو موجود.");
  return ctx.reply(`${s.title}\n${s.url}`, { reply_markup: siteKb(s.id, s.url) });
});
bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
  const s = await getSite(ctx.match[1], ctx.from.id);
  if (!s) return ctx.answerCallbackQuery({ text: "مو موجود" });
  await setCurrent(ctx.from.id, s.id);
  const last = (await getHistory(s.id)).filter((m) => m.role === "assistant").pop();
  await ctx.answerCallbackQuery();
  return ctx.reply(`✏️ فتحت محادثة "${s.title}".${last ? `\n\nآخر شي: ${last.content}` : ""}\n\nاكتب التعديل.`);
});
bot.callbackQuery(/^files:(.+)$/, async (ctx) => {
  const s = await getSite(ctx.match[1], ctx.from.id);
  await ctx.answerCallbackQuery();
  if (!s) return ctx.reply("مو موجود.");
  return sendZip(ctx, s.slug, s.files);
});
bot.callbackQuery(/^del:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  return ctx.reply("متأكد تحذف الموقع نهائياً؟", {
    reply_markup: new InlineKeyboard().text("✅ نعم احذف", `delc:${ctx.match[1]}`).text("إلغاء", "cancel"),
  });
});
bot.callbackQuery("cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});
bot.callbackQuery(/^delc:(.+)$/, async (ctx) => {
  const s = await getSite(ctx.match[1], ctx.from.id);
  await ctx.answerCallbackQuery();
  if (!s) return ctx.editMessageText("مو موجود.");
  try {
    await vercelDeleteProject(s.slug);
    must(await sb.from("sites").delete().eq("id", s.id));
    await ctx.editMessageText(`🗑 انحذف "${s.title}".`);
  } catch (e) {
    await ctx.editMessageText(`❌ ${e.message}`);
  }
});

// ---------- text = brief (new) or edit (current site) ----------
bot.on("message:text", async (ctx) => {
  const uid = ctx.from.id;
  if (busy.has(uid)) return ctx.reply("⏳ استنى لين يخلص الطلب الحالي.");
  busy.add(uid);
  try {
    const cur = await getCurrent(uid);
    const site = cur ? await getSite(cur, uid) : null;
    await runBuild(ctx, site, ctx.message.text);
  } finally {
    busy.delete(uid);
  }
});

bot.catch((e) => console.error("bot error:", e.error || e));

// ---------- health page for fly ----------
http
  .createServer((_, res) => { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end("البوت شغال ✅"); })
  .listen(process.env.PORT || 8080);

bot.start({ onStart: (me) => console.log(`@${me.username} up`) });
