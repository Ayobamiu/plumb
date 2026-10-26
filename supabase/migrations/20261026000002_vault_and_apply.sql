-- Two server-side helpers. Both are callable by the service role only: Supabase
-- grants EXECUTE on new public functions to anon and authenticated by default,
-- so each function revokes that explicitly.

-- 1. Gmail refresh token in Vault (asked for by Cursor's OAuth callback).
-- One secret, named plumb_gmail_refresh_token. A new grant replaces the old one.
create function public.plumb_store_gmail_refresh_token(token text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  sid uuid;
begin
  if token is null or length(token) = 0 then
    raise exception 'plumb: empty refresh token';
  end if;
  select id into sid from vault.secrets where name = 'plumb_gmail_refresh_token';
  if sid is null then
    perform vault.create_secret(token, 'plumb_gmail_refresh_token', 'Gmail refresh token, gmail.readonly');
  else
    perform vault.update_secret(sid, token);
  end if;
end;
$$;

-- Read path for the Gmail watcher. Returns null until Gmail is connected.
create function public.plumb_get_gmail_refresh_token() returns text
language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'plumb_gmail_refresh_token';
$$;

-- 2. Write one brain run atomically: the new event, new claims and reasons,
-- status changes, and their transitions. The brain runs in TypeScript, so each
-- status change carries the status it was computed from; if another run moved
-- the claim first, nothing is written and the caller retries (SQLSTATE 40001).
--
-- p_updates items: { id, expected_status, status, valid_to, retracted_at, text? }
-- valid_to and retracted_at are written as given (null clears them on restore).
create function public.plumb_apply(
  p_event jsonb,
  p_claims jsonb,
  p_reasons jsonb,
  p_updates jsonb,
  p_transitions jsonb
) returns void
language plpgsql set search_path = '' as $$
declare
  u jsonb;
  n integer;
begin
  if p_event is not null then
    insert into public.events select * from jsonb_populate_record(null::public.events, p_event);
  end if;
  insert into public.claims select * from jsonb_populate_recordset(null::public.claims, coalesce(p_claims, '[]'));
  insert into public.reasons select * from jsonb_populate_recordset(null::public.reasons, coalesce(p_reasons, '[]'));
  for u in select * from jsonb_array_elements(coalesce(p_updates, '[]')) loop
    update public.claims set
      status = (u ->> 'status')::public.claim_status,
      valid_to = (u ->> 'valid_to')::timestamptz,
      retracted_at = (u ->> 'retracted_at')::timestamptz,
      text = coalesce(u ->> 'text', text)
    where id = (u ->> 'id')::uuid and status = (u ->> 'expected_status')::public.claim_status;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'plumb: claim % changed during this run, retry', u ->> 'id' using errcode = '40001';
    end if;
  end loop;
  insert into public.transitions
    select * from jsonb_populate_recordset(null::public.transitions, coalesce(p_transitions, '[]'));
end;
$$;

revoke all on function public.plumb_store_gmail_refresh_token(text) from public, anon, authenticated;
revoke all on function public.plumb_get_gmail_refresh_token() from public, anon, authenticated;
revoke all on function public.plumb_apply(jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.plumb_store_gmail_refresh_token(text) to service_role;
grant execute on function public.plumb_get_gmail_refresh_token() to service_role;
grant execute on function public.plumb_apply(jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;
