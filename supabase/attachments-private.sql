-- Aplicar somente depois de distribuir o cliente com URLs assinadas.
-- Requer audit-online.sql ja aplicado. Nao reaplica politicas do chat/identidade.
-- Mantem objetos existentes; nao apaga arquivos nem modifica mensagens.
begin;
do $$ begin
  if not exists (select 1 from storage.buckets where id = 'chat-attachments') then
    raise exception 'Bucket chat-attachments ausente';
  end if;
  if to_regprocedure('public.can_read_profile(uuid)') is null
    or to_regprocedure('public.can_read_room(uuid)') is null then
    raise exception 'Aplicar previamente as politicas de acesso do Voxa';
  end if;
end $$;

create or replace function public.can_read_attachment(object_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare parts text[] := string_to_array(object_name, '/');
begin
  if auth.uid() is null then return false; end if;
  if array_length(parts, 1) = 3 and parts[2] ~ '^[0-9a-fA-F-]{36}$' then
    return public.can_read_room(parts[2]::uuid);
  end if;
  -- Anexos anteriores usam uid/arquivo. Mantem acesso apenas entre membros.
  if array_length(parts, 1) = 2 and parts[1] ~ '^[0-9a-fA-F-]{36}$' then
    return exists (select 1 from public.room_members m where m.user_id = auth.uid())
      and public.can_read_profile(parts[1]::uuid);
  end if;
  return false;
exception when invalid_text_representation then return false;
end;
$$;
revoke all on function public.can_read_attachment(text) from public, anon;
grant execute on function public.can_read_attachment(text) to authenticated;
update storage.buckets set public = false where id = 'chat-attachments';
drop policy if exists chat_attachments_read on storage.objects;
create policy chat_attachments_read on storage.objects for select to authenticated
using (bucket_id = 'chat-attachments' and public.can_read_attachment(name));
drop policy if exists chat_attachments_insert_own on storage.objects;
create policy chat_attachments_insert_own on storage.objects for insert to authenticated
with check (bucket_id = 'chat-attachments' and split_part(name, '/', 1) = (select auth.uid())::text
  and array_length(string_to_array(name, '/'), 1) = 3 and public.can_read_attachment(name));

-- Reserva conservadora: cada objeto pode ocupar ate 8 MiB. A contagem
-- independe de metadata.size (que ainda pode estar vazio durante o upload).
create or replace function public.limit_attachment_objects()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.bucket_id <> 'chat-attachments' then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('voxa:attachments', 3));
  if (select count(*) from storage.objects where bucket_id = new.bucket_id) >= 100
    or (select count(*) from storage.objects where bucket_id = new.bucket_id
        and split_part(name, '/', 1) = split_part(new.name, '/', 1)) >= 25 then
    raise exception 'Limite de anexos atingido. Solicite limpeza ao administrador.';
  end if;
  return new;
end;
$$;
revoke all on function public.limit_attachment_objects() from public, anon, authenticated;
drop trigger if exists voxa_attachment_quota on storage.objects;
create trigger voxa_attachment_quota before insert on storage.objects
for each row execute function public.limit_attachment_objects();

commit;
