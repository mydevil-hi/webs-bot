-- supabase > SQL editor > paste > run
create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null,
  title text not null,
  slug text not null unique,
  url text,
  files jsonb not null default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists sites_user_idx on sites(user_id);

create table if not exists messages (
  id bigint generated always as identity primary key,
  site_id uuid not null references sites(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz default now()
);
create index if not exists messages_site_idx on messages(site_id, id);

create table if not exists user_state (
  user_id bigint primary key,
  current_site uuid references sites(id) on delete set null
);

-- bot uses the anon key, so RLS must allow it. access control is ALLOWED_USERS in the bot.
alter table sites disable row level security;
alter table messages disable row level security;
alter table user_state disable row level security;
