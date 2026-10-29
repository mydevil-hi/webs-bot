# webbot

1. supabase: SQL editor -> run schema.sql
2. github: git init && git add . && git commit -m init && git remote add origin <repo> && git push -u origin main
3. fly:
   fly launch --no-deploy --copy-config --name <app-name>
   fly secrets set TELEGRAM_BOT_TOKEN=... GEMINI_API_KEY=... SUPABASE_URL=... SUPABASE_KEY=... VERCEL_TOKEN=... ALLOWED_USERS=<your_tg_id>
   fly deploy
4. open https://<app-name>.fly.dev -> "البوت شغال"
