-- =============================================================================
-- VOXA — Hardening 2: vazamento de perfis e RLS por linha
--
-- Rode DEPOIS de schema.sql, attachments.sql, hardening.sql e
-- fechar-historico.sql. Idempotente.
--
-- Nao muda comportamento nenhum do app. Fecha um vazamento e tira um custo
-- de CPU que cresce junto com o historico.
-- =============================================================================

-- ---- 1. `auth.uid()` avaliado UMA vez, e nao por linha ----------------------
--
-- Dentro de uma policy, `auth.uid()` solto e reavaliado a CADA LINHA
-- examinada. Envolvido num sub-select, o Postgres o trata como constante da
-- consulta (InitPlan) e chama uma vez so.
--
-- Com 60 mensagens por pagina a diferenca nao aparece; o problema e que o
-- custo cresce junto com o historico, e RLS lenta nao da erro — ela so vai
-- deixando o chat mais devagar sem ninguem saber por que.
--
-- E o mesmo teste, escrito de outro jeito: nada muda em quem pode ler o que.

drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages
  for select using (public.can_read_room(room_id));

drop policy if exists messages_insert_self on public.messages;
create policy messages_insert_self on public.messages
  for insert with check (
    author_id = (select auth.uid()) and public.can_read_room(room_id)
  );

drop policy if exists room_members_read_own on public.room_members;
create policy room_members_read_own on public.room_members
  for select using (user_id = (select auth.uid()));

drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms
  for select using (
    is_private = false
    or exists (
      select 1 from public.room_members m
      where m.room_id = rooms.id and m.user_id = (select auth.uid())
    )
  );

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert with check (id = (select auth.uid()));

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ---- 2. perfil nao e mais publico ------------------------------------------
--
-- `profiles_read` era `using (true)`: QUALQUER sessao autenticada lia o
-- perfil de todo mundo — nome e cor — mesmo sem nunca ter provado que sabe a
-- senha da sala. Como a `anon key` vai dentro do instalador e o sign-in
-- anonimo e livre, bastava extrair a chave para listar quem usa o servidor.
--
-- Era a ultima sobra do modelo antigo, quando as salas eram publicas: o
-- `fechar-historico.sql` fechou salas e mensagens e esqueceu os perfis.
--
-- Agora so se le o proprio perfil, ou o de quem divide uma sala com voce.
-- Na pratica nada muda para quem usa o app: `join_guild` inscreve todo mundo
-- em todas as salas, entao membro continua enxergando membro — a diferenca e
-- que quem NAO e membro deixa de enxergar qualquer um.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select using (
    id = (select auth.uid())
    or exists (
      select 1
      from public.room_members meu
      join public.room_members outro on outro.room_id = meu.room_id
      where meu.user_id = (select auth.uid())
        and outro.user_id = profiles.id
    )
  );

-- ---- 3. indice para o teste acima nao virar varredura -----------------------
-- `room_members` passa a ser consultada por `user_id` em toda leitura de
-- perfil. A PK e (room_id, user_id), que nao serve para filtrar so por
-- user_id.
create index if not exists room_members_user_idx on public.room_members (user_id);
