-- plumb_apply raised SQLSTATE 40001 when a claim's status no longer matched.
-- PostgREST 14 treats 40001 as transient and retries the transaction forever
-- on the server, with the same payload, so a stale write can never finish.
-- Two of those looped at about 1,100 retries a second and set off Supabase's
-- high CPU alert (Oct 31). PT409 returns HTTP 409 and is not retried. The
-- retry stays where it belongs: in the handler, which re-reads and is capped.

create or replace function public.plumb_apply(
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
      text = coalesce(u ->> 'text', text),
      last_mentioned_at = coalesce((u ->> 'last_mentioned_at')::timestamptz, last_mentioned_at)
    where id = (u ->> 'id')::uuid and status = (u ->> 'expected_status')::public.claim_status;
    get diagnostics n = row_count;
    if n = 0 then
      raise exception 'plumb: claim % changed during this run, retry', u ->> 'id' using errcode = 'PT409';
    end if;
  end loop;
  insert into public.transitions
    select * from jsonb_populate_recordset(null::public.transitions, coalesce(p_transitions, '[]'));
end;
$$;
