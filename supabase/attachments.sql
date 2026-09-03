-- =============================================================================
-- VOXA — Anexos de imagem/arquivo no chat
--
-- Rode DEPOIS do schema.sql, no mesmo Supabase Dashboard > SQL Editor.
-- Idempotente: pode rodar de novo sem duplicar nada.
--
-- O que isso adiciona:
--   1. Quatro colunas em `messages` pra guardar o anexo (url, nome, mime, tamanho)
--   2. A view `messages_with_author` recriada incluindo essas colunas
--   3. Um bucket de Storage `chat-attachments` — publico pra LEITURA (a URL
--      da imagem precisa carregar direto no <img>, sem round-trip de signed
--      URL), mas so `authenticated` consegue fazer UPLOAD, e so dentro da
--      propria pasta (auth.uid()/arquivo) — ninguem sobrescreve anexo alheio.
--   4. Limite de 8 MB por arquivo e uma lista de tipos aceitos — plano free
--      do Supabase da 1 GB de Storage no total, um teto por arquivo evita um
--      upload sozinho estourar isso.
-- =============================================================================

-- ---- 1. colunas novas em messages --------------------------------------------
alter table public.messages
  add column if not exists attachment_url  text,
  add column if not exists attachment_name text,
  add column if not exists attachment_mime text,
  add column if not exists attachment_size bigint;

-- Ou tem os quatro campos preenchidos, ou nenhum — nunca um anexo pela metade.
do $$ begin
  alter table public.messages add constraint messages_attachment_all_or_nothing
    check (
      (attachment_url is null and attachment_name is null and attachment_mime is null and attachment_size is null)
      or
      (attachment_url is not null and attachment_name is not null and attachment_mime is not null and attachment_size is not null)
    );
exception when duplicate_object then null; end $$;

-- ---- 2. view recriada com as colunas novas no final --------------------------
-- Mesma definicao do schema.sql, so acrescentando os quatro campos no final —
-- Postgres permite CREATE OR REPLACE VIEW assim sem quebrar quem ja consulta
-- as colunas antigas pela posicao.
create or replace view public.messages_with_author
with (security_invoker = true) as
  select
    m.id,
    m.room_id,
    m.content,
    m.created_at,
    m.author_id,
    coalesce(p.username, 'desconhecido') as author_name,
    coalesce(p.color, '#5865F2')         as author_color,
    m.attachment_url,
    m.attachment_name,
    m.attachment_mime,
    m.attachment_size
  from public.messages m
  left join public.profiles p on p.id = m.author_id;

grant select on public.messages_with_author to authenticated;

-- ---- 3. bucket de storage ------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments',
  'chat-attachments',
  true,
  8388608, -- 8 MB
  array[
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'video/mp4', 'video/webm',
    'audio/mpeg', 'audio/ogg', 'audio/wav',
    'application/pdf', 'text/plain', 'application/zip'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---- 4. politicas do bucket ------------------------------------------------
-- Leitura publica: bucket `public = true` ja libera GET direto via
-- /storage/v1/object/public/chat-attachments/..., sem passar por RLS — mas a
-- politica abaixo cobre tambem quem acessa via SDK (from(...).download()).
drop policy if exists chat_attachments_read on storage.objects;
create policy chat_attachments_read on storage.objects
  for select to public
  using (bucket_id = 'chat-attachments');

-- Upload so autenticado, e so dentro da propria pasta: o primeiro segmento
-- do path precisa ser o proprio auth.uid(), senao a politica recusa.
drop policy if exists chat_attachments_insert_own on storage.objects;
create policy chat_attachments_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Sem UPDATE nem DELETE pelo cliente — mesma regra do historico de texto:
-- anexo enviado nao se apaga pela API, so por service_role (moderacao).
