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
commit;
