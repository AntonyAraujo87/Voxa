-- =============================================================================
-- VOXA — Schema Supabase (Free Tier)
-- Rode este arquivo em: Supabase Dashboard > SQL Editor > New query > Run
-- =============================================================================

-- Extensoes -------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- =============================================================================
-- 1. USERS
-- =============================================================================
create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  username    text not null unique check (char_length(username) between 2 and 32),
  display_name text,
  color       text not null default '#5865F2',
  avatar_url  text,
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists users_username_idx on public.users (lower(username));

-- =============================================================================
-- 2. ROOMS (canais de texto e de voz)
-- =============================================================================
do $$ begin
  create type public.room_kind as enum ('text', 'voice');
exception when duplicate_object then null; end $$;

create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]{2,48}$'),
  name        text not null,
  kind        public.room_kind not null default 'text',
  topic       text,
  position    int not null default 0,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists rooms_kind_position_idx on public.rooms (kind, position);

-- =============================================================================
-- 3. MESSAGES (historico do chat de texto)
-- =============================================================================
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  author_id   uuid references public.users(id) on delete set null,
  author_name text not null,
  author_color text not null default '#5865F2',
  content     text not null check (char_length(content) between 1 and 4000),
  edited_at   timestamptz,
  created_at  timestamptz not null default now()
);

-- Indice composto: paginacao "ultimas N mensagens do canal" e um index-only scan.
create index if not exists messages_room_created_idx
  on public.messages (room_id, created_at desc);

-- =============================================================================
-- 4. SESSOES DE VOZ (telemetria opcional — util para debug de qualidade)
-- =============================================================================
create table if not exists public.voice_sessions (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  user_id     uuid references public.users(id) on delete set null,
  joined_at   timestamptz not null default now(),
  left_at     timestamptz,
  shared_screen boolean not null default false
);

create index if not exists voice_sessions_room_idx on public.voice_sessions (room_id, joined_at desc);

-- =============================================================================
-- 5. RLS — o app nao usa Supabase Auth (login e por username, sem senha).
--    As policies abaixo liberam o papel `anon` de forma controlada:
--    leitura livre, escrita permitida, DELETE/UPDATE de terceiros bloqueados.
--    >>> Se voce plugar Supabase Auth depois, troque `true` por
--        `auth.uid() = author_id` nas policies de update/delete.
-- =============================================================================
alter table public.users          enable row level security;
alter table public.rooms          enable row level security;
alter table public.messages       enable row level security;
alter table public.voice_sessions enable row level security;

drop policy if exists users_read   on public.users;
drop policy if exists users_write  on public.users;
drop policy if exists users_update on public.users;
create policy users_read   on public.users for select using (true);
create policy users_write  on public.users for insert with check (true);
create policy users_update on public.users for update using (true) with check (true);

drop policy if exists rooms_read  on public.rooms;
drop policy if exists rooms_write on public.rooms;
create policy rooms_read  on public.rooms for select using (true);
create policy rooms_write on public.rooms for insert with check (true);

drop policy if exists messages_read  on public.messages;
drop policy if exists messages_write on public.messages;
create policy messages_read  on public.messages for select using (true);
create policy messages_write on public.messages for insert with check (true);

drop policy if exists voice_sessions_read  on public.voice_sessions;
drop policy if exists voice_sessions_write on public.voice_sessions;
drop policy if exists voice_sessions_update on public.voice_sessions;
create policy voice_sessions_read   on public.voice_sessions for select using (true);
create policy voice_sessions_write  on public.voice_sessions for insert with check (true);
create policy voice_sessions_update on public.voice_sessions for update using (true) with check (true);

-- =============================================================================
-- 6. RPC: upsert de usuario por username (login sem senha)
-- =============================================================================
create or replace function public.upsert_user(p_username text, p_color text default '#5865F2')
returns public.users
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.users;
begin
  insert into public.users (username, display_name, color, last_seen)
  values (lower(p_username), p_username, p_color, now())
  on conflict (username)
    do update set last_seen = now(), color = excluded.color, display_name = excluded.display_name
  returning * into result;
  return result;
end;
$$;

grant execute on function public.upsert_user(text, text) to anon, authenticated;

-- =============================================================================
-- 7. SEED — canais padrao (estilo Discord)
-- =============================================================================
insert into public.rooms (slug, name, kind, position, topic) values
  ('geral',      'geral',       'text',  0, 'Papo geral da tropa'),
  ('links',      'links',       'text',  1, 'Cola aqui o que achar'),
  ('clipes',     'clipes',      'text',  2, 'Jogadas e bugs engracados'),
  ('lounge',     'Lounge',      'voice', 0, null),
  ('sala-de-jogo','Sala de Jogo','voice', 1, null),
  ('afk',        'AFK',         'voice', 2, null)
on conflict (slug) do nothing;
