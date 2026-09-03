-- =============================================================================
-- VOXA — Schema Supabase (Free Tier)
--
-- Rode em: Supabase Dashboard > SQL Editor > New query > Run
--
-- PRE-REQUISITO OBRIGATORIO
--   Authentication > Providers > Anonymous sign-ins  ->  ENABLED
--
--   Sem isso, a chave `anon` que vai dentro do app nao representa NINGUEM:
--   toda requisicao chega ao banco como o mesmo papel `anon`, e nao existe
--   `auth.uid()` para comparar. Qualquer politica escrita sobre "o dono da
--   linha" seria decorativa — quem extraisse a chave do app (ela esta no
--   binario, por definicao) poderia ler e escrever tudo.
--
--   Com sign-in anonimo, cada instalacao recebe um usuario real no
--   `auth.users`, com JWT proprio. Dai `auth.uid()` passa a existir e as
--   politicas abaixo deixam de ser enfeite.
-- =============================================================================

create extension if not exists "pgcrypto";

-- =============================================================================
-- 1. PROFILES — espelho publico do usuario anonimo
-- =============================================================================
create table if not exists public.profiles (
  -- A chave primaria E o id do auth: impossivel um usuario criar perfil de
  -- outro, porque a propria FK impede.
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null check (char_length(username) between 2 and 32),
  color        text not null default '#5865F2' check (color ~ '^#[0-9A-Fa-f]{3,8}$'),
  last_seen    timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists profiles_last_seen_idx on public.profiles (last_seen desc);

-- =============================================================================
-- 2. ROOMS — canais de texto e de voz
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
  -- Sala privada so aparece para quem esta em room_members.
  is_private  boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists rooms_kind_position_idx on public.rooms (kind, position);

-- =============================================================================
-- 3. ROOM_MEMBERS — a base do isolamento entre salas
-- =============================================================================
create table if not exists public.room_members (
  room_id   uuid not null references public.rooms(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists room_members_user_idx on public.room_members (user_id);

-- Funcao usada pelas politicas. SECURITY DEFINER para poder consultar
-- room_members sem cair na propria politica de room_members (recursao).
create or replace function public.can_read_room(p_room uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.rooms r
    where r.id = p_room
      and (
        r.is_private = false
        or exists (
          select 1 from public.room_members m
          where m.room_id = r.id and m.user_id = auth.uid()
        )
      )
  );
$$;

revoke all on function public.can_read_room(uuid) from public;
grant execute on function public.can_read_room(uuid) to authenticated;

-- =============================================================================
-- 4. MESSAGES
-- =============================================================================
create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms(id) on delete cascade,
  -- NOT NULL de proposito: mensagem sem autor rastreavel nao entra.
  author_id    uuid not null references auth.users(id) on delete cascade,
  content      text not null check (char_length(content) between 1 and 2000),
  created_at   timestamptz not null default now()
);

-- Paginacao "ultimas N do canal" vira index-only scan.
create index if not exists messages_room_created_idx
  on public.messages (room_id, created_at desc);
create index if not exists messages_author_created_idx
  on public.messages (author_id, created_at desc);

-- Freio de flood no proprio banco: mesmo que alguem fale direto com a API,
-- ignorando o app e o servidor de sinalizacao, o teto continua valendo.
create or replace function public.enforce_message_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recentes int;
begin
  select count(*) into recentes
  from public.messages
  where author_id = new.author_id
    and created_at > now() - interval '10 seconds';

  if recentes >= 15 then
    raise exception 'limite de mensagens excedido' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists messages_rate_limit on public.messages;
create trigger messages_rate_limit
  before insert on public.messages
  for each row execute function public.enforce_message_rate();

-- =============================================================================
-- 5. RLS
--
-- Regra geral: o papel `anon` (chave que vai dentro do app) NAO le e NAO
-- escreve nada. Tudo exige `authenticated`, que so existe apos o sign-in
-- anonimo. E dentro de `authenticated`, cada um so alcanca o que e seu.
-- =============================================================================
alter table public.profiles     enable row level security;
alter table public.rooms        enable row level security;
alter table public.room_members enable row level security;
alter table public.messages     enable row level security;

-- Fecha o acesso por privilegio, alem do RLS. Cinto e suspensorio: se uma
-- politica futura for escrita errada, o GRANT ausente ainda barra.
revoke all on public.profiles, public.rooms, public.room_members, public.messages from anon;
grant select on public.rooms to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.room_members to authenticated;
grant select, insert on public.messages to authenticated;

-- ---- profiles ---------------------------------------------------------------
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---- rooms ------------------------------------------------------------------
drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms
  for select to authenticated
  using (is_private = false or exists (
    select 1 from public.room_members m
    where m.room_id = rooms.id and m.user_id = auth.uid()
  ));

-- Criacao de sala e operacao administrativa (service_role), nao do cliente.

-- ---- room_members -----------------------------------------------------------
drop policy if exists room_members_read_own on public.room_members;
create policy room_members_read_own on public.room_members
  for select to authenticated using (user_id = auth.uid());

-- ---- messages ---------------------------------------------------------------
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages
  for select to authenticated
  using (public.can_read_room(room_id));

drop policy if exists messages_insert_self on public.messages;
create policy messages_insert_self on public.messages
  for insert to authenticated
  with check (author_id = auth.uid() and public.can_read_room(room_id));

-- Sem UPDATE e sem DELETE para ninguem: historico de conversa nao se reescreve
-- pelo cliente. Moderacao, se um dia existir, passa por service_role.

-- =============================================================================
-- 6. VIEW de leitura — junta autor sem expor a tabela auth.users
-- =============================================================================
create or replace view public.messages_with_author
with (security_invoker = true) as
  select
    m.id,
    m.room_id,
    m.content,
    m.created_at,
    m.author_id,
    coalesce(p.username, 'desconhecido') as author_name,
    coalesce(p.color, '#5865F2')         as author_color
  from public.messages m
  left join public.profiles p on p.id = m.author_id;

grant select on public.messages_with_author to authenticated;

-- =============================================================================
-- 7. SEED — canais padrao
-- =============================================================================
insert into public.rooms (slug, name, kind, position, topic) values
  ('geral',        'geral',        'text',  0, 'Papo geral da tropa'),
  ('links',        'links',        'text',  1, 'Cola aqui o que achar'),
  ('clipes',       'clipes',       'text',  2, 'Jogadas e bugs engracados'),
  ('lounge',       'Lounge',       'voice', 0, null),
  ('sala-de-jogo', 'Sala de Jogo', 'voice', 1, null),
  ('afk',          'AFK',          'voice', 2, null)
on conflict (slug) do nothing;
