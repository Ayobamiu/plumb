-- Relevance (Usman, Oct 27): Plumb should retire what no longer deserves
-- attention, not only what became false.
--
-- 1. Link suggestions expire on their own. Two ways, kept apart from Usman's
--    own "dismissed":
--    - claim_left_in: a claim on either side left IN. Set by a trigger here,
--      so it holds whichever tool or path changed the claim. If both claims
--      are IN again later, the sweep may suggest the pair again.
--    - no_longer_relevant: the sweep's relevance pass decided the question is
--      moot (the moment passed, the work is done). Not suggested again.
-- 2. claims.last_mentioned_at: when a text last talked about the claim
--    without changing it. Feeds the "quiet claims" rule in get_project_state.
--    Added to the Contract with Usman's OK.

alter table link_suggestions drop constraint link_suggestions_status_check;
alter table link_suggestions add constraint link_suggestions_status_check
  check (status in ('pending', 'accepted', 'dismissed', 'expired'));
alter table link_suggestions add column expired_because text
  check (expired_because in ('claim_left_in', 'no_longer_relevant'));
alter table link_suggestions add column expired_note text; -- one line, shown on request
alter table link_suggestions add constraint link_suggestions_expired_check
  check ((status = 'expired') = (expired_because is not null));

create function public.plumb_expire_link_suggestions() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'IN' and new.status <> 'IN' then
    update public.link_suggestions set
      status = 'expired',
      expired_because = 'claim_left_in',
      expired_note = format('"%s" went %s.', left(new.text, 120), new.status),
      resolved_at = now()
    where status = 'pending' and (claim_id = new.id or depends_on = new.id);
  end if;
  return new;
end;
$$;
create trigger expire_link_suggestions after update of status on claims
  for each row execute function public.plumb_expire_link_suggestions();

alter table claims add column last_mentioned_at timestamptz;

-- plumb_apply: updates may also set last_mentioned_at (a mention keeps the
-- status the same; expected_status still guards against a racing run).
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
      raise exception 'plumb: claim % changed during this run, retry', u ->> 'id' using errcode = '40001';
    end if;
  end loop;
  insert into public.transitions
    select * from jsonb_populate_recordset(null::public.transitions, coalesce(p_transitions, '[]'));
end;
$$;

revoke all on function public.plumb_expire_link_suggestions() from public, anon, authenticated;
revoke all on function public.plumb_apply(jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.plumb_apply(jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;
