-- Aplicar depois de hardening-2.sql. Fecha leitura publica de anexos:
-- atualizar os clientes para a versao que resolve URLs assinadas antes de aplicar.
-- Nao altera a senha. Rotacoes futuras revogam as associacoes existentes.
begin;

create or replace function public.can_read_profile(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() = target or exists (
    select 1 from public.room_members mine join public.room_members theirs using (room_id)
    where mine.user_id = auth.uid() and theirs.user_id = target
  );
$$;
revoke all on function public.can_read_profile(uuid) from public, anon;
grant execute on function public.can_read_profile(uuid) to authenticated;
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
using (public.can_read_profile(id));

create or replace function public.join_guild(p_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare last_attempt timestamptz; accepted boolean;
begin
  if auth.uid() is null or p_token is null or length(p_token) > 4096 then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text, 1));
  select last_try into last_attempt from public.join_attempts where user_id = auth.uid();
  if last_attempt > clock_timestamp() - interval '1 second' then return false; end if;
  select hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') into accepted from public.guild_secret where id = 1;
  if not coalesce(accepted, false) then
    insert into public.join_attempts (user_id, last_try) values (auth.uid(), clock_timestamp())
    on conflict (user_id) do update set last_try = excluded.last_try;
    return false;
  end if;
  insert into public.room_members (room_id, user_id) select id, auth.uid() from public.rooms
  on conflict (room_id, user_id) do nothing;
  return true;
end;
$$;
revoke all on function public.join_guild(text) from public, anon;
grant execute on function public.join_guild(text) to authenticated;

create or replace function public.revoke_rotated_memberships()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.hash is distinct from new.hash then delete from public.room_members; end if;
  return new;
end;
$$;
revoke all on function public.revoke_rotated_memberships() from public, anon, authenticated;
drop trigger if exists guild_rotation on public.guild_secret;
create trigger guild_rotation after update of hash on public.guild_secret
for each row execute function public.revoke_rotated_memberships();

create or replace function public.enforce_message_rate()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.author_id::text, 2));
  if (select count(*) from public.messages where author_id = new.author_id and created_at > clock_timestamp() - interval '10 seconds') >= 15 then
    raise exception 'limite de mensagens excedido';
  end if;
  -- O relogio do cliente nunca controla a janela de flood.
  new.created_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.enforce_message_rate() from public, anon, authenticated;
create index if not exists messages_room_cursor_idx on public.messages (room_id, created_at desc, id desc);

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
