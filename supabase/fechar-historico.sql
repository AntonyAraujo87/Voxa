-- =============================================================================
-- VOXA — Fecha o historico do chat
--
-- O PROBLEMA
-- A chave `anon` vai dentro do binario distribuido: ela e publica por
-- definicao, qualquer um extrai do instalador. Com sign-in anonimo livre e
-- salas com `is_private = false`, isso bastava para baixar o historico
-- INTEIRO do chat. O token do servidor de sinalizacao nao protegia nada
-- disso, porque o Supabase nunca o ve.
--
-- A CORRECAO
-- Guarda um HASH da senha (nunca a senha), numa tabela que cliente nenhum le,
-- e so inscreve em `room_members` quem provar que a conhece. As salas viram
-- privadas e a policy que ja existe (`can_read_room`) cuida do resto — sem
-- escrever politica nova.
--
-- ORDEM DE APLICACAO (importante)
--   1. Publique o app >= v0.4.3. Ele ja chama `join_guild` e IGNORA o erro de
--      "funcao nao existe", entao continua funcionando como hoje.
--   2. Espere todo mundo atualizar (o auto-update cuida disso).
--   3. Rode ESTE arquivo, trocando a senha na linha marcada.
--
-- Quem nao tiver atualizado o app quando o passo 3 rodar perde o HISTORICO
-- (o chat em tempo real continua funcionando normalmente) — e volta assim que
-- atualizar. Nada e apagado em momento nenhum.
-- =============================================================================

-- O hash usa `sha256()`, que e do proprio Postgres (pg_catalog) — de proposito,
-- e nao o `digest()` do pgcrypto.
--
-- Motivo: no Supabase o pgcrypto e instalado no schema `extensions`, e
-- `join_guild` declara `set search_path = public`. Dentro dela `digest()`
-- simplesmente NAO EXISTE, e a funcao estoura a cada chamada. O erro diz
-- "function digest(text, unknown) does not exist" — que casa com o filtro que
-- o cliente usa para ignorar "a funcao ainda nao foi criada". Ou seja: a
-- falha seria engolida em silencio, ninguem entraria em `room_members`, e
-- TODO MUNDO ficaria sem historico sem uma unica mensagem de erro.
--
-- `sha256(convert_to(texto, 'UTF8'))` da exatamente o mesmo hexadecimal
-- (verificado, inclusive com acentos) e nao depende de search_path nenhum.

-- ---- 1. onde mora o hash da senha -------------------------------------------
create table if not exists public.guild_secret (
  id   int primary key default 1,
  hash text not null,
  constraint guild_secret_linha_unica check (id = 1)
);

alter table public.guild_secret enable row level security;
revoke all on public.guild_secret from anon, authenticated;
-- Sem nenhuma policy: nem com sessao valida da pra ler o hash pelo cliente.

-- >>>>>>>>>>>>>>>>>>>>>>>>  TROQUE AQUI  <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
-- Use exatamente o mesmo valor de VOXA_TOKEN do servidor de sinalizacao
-- (Render > voxa-signaling > Environment), que e o que o usuario digita.
insert into public.guild_secret (id, hash)
values (1, encode(sha256(convert_to('COLE-AQUI-O-VOXA-TOKEN', 'UTF8')), 'hex'))
on conflict (id) do update set hash = excluded.hash;
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- ---- 2. freio de forca bruta -------------------------------------------------
-- Uma tentativa por segundo por usuario. Sem isto, alguem com a anon key
-- poderia varrer senhas pela API tao rapido quanto a rede aguentasse.
create table if not exists public.join_attempts (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  last_try timestamptz not null default now()
);

alter table public.join_attempts enable row level security;
revoke all on public.join_attempts from anon, authenticated;

-- ---- 3. a funcao que o cliente chama ----------------------------------------
create or replace function public.join_guild(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  confere boolean;
  ultima  timestamptz;
begin
  if auth.uid() is null then
    return false;
  end if;

  -- Freio antes de qualquer comparacao.
  select last_try into ultima from public.join_attempts where user_id = auth.uid();
  if ultima is not null and now() - ultima < interval '1 second' then
    return false;
  end if;

  select (hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')) into confere
  from public.guild_secret
  where id = 1;

  -- A tentativa so e registrada quando a senha esta ERRADA. Assim quem sabe a
  -- senha nunca e penalizado — dois boots seguidos, uma reconexao rapida ou
  -- duas janelas abertas juntas continuam entrando — e quem esta chutando,
  -- que erra por definicao, leva o freio a cada tentativa.
  if not coalesce(confere, false) then
    insert into public.join_attempts (user_id, last_try)
    values (auth.uid(), now())
    on conflict (user_id) do update set last_try = now();
    return false;
  end if;

  -- Idempotente: o app chama isto a cada boot.
  insert into public.room_members (room_id, user_id)
  select r.id, auth.uid() from public.rooms r
  on conflict (room_id, user_id) do nothing;

  return true;
end;
$$;

revoke all on function public.join_guild(text) from public, anon;
grant execute on function public.join_guild(text) to authenticated;

-- O cliente precisa poder inserir a propria linha? NAO — `join_guild` e
-- SECURITY DEFINER e faz o insert como dona. O grant de INSERT em
-- room_members continua inexistente de proposito.

-- ---- 4. fecha as salas -------------------------------------------------------
-- So depois de tudo acima existir. A partir daqui, quem nao for membro nao le
-- mensagem nenhuma — que e exatamente o objetivo.
update public.rooms set is_private = true;
