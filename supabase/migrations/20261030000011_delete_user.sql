-- Delete my account (Oct 30, Usman OK'd): the one exception to "nothing is ever
-- deleted". A tester can remove everything saved for them. One transaction, only
-- this user's rows, children before parents. Server only, like plumb_apply.
-- The no_delete triggers stay on: they let a row go only inside this function,
-- which sets plumb.deleting for its own transaction.
create or replace function plumb_block_delete() returns trigger
language plpgsql as $$
begin
  if current_setting('plumb.deleting', true) = 'on' then
    return old;
  end if;
  raise exception 'plumb: rows in % are never deleted', tg_table_name;
end;
$$;

create or replace function plumb_delete_user(p_user uuid) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_projects uuid[];
  v_sources uuid[];
  v_claims uuid[];
  v_counts jsonb;
begin
  select coalesce(array_agg(id), '{}') into v_projects from projects where user_id = p_user;
  select coalesce(array_agg(id), '{}') into v_sources from sources where user_id = p_user;
  select coalesce(array_agg(id), '{}') into v_claims from claims where project_id = any (v_projects) or source_id = any (v_sources);

  perform set_config('plumb.deleting', 'on', true); -- this transaction only

  v_counts := jsonb_build_object('projects', cardinality(v_projects), 'sources', cardinality(v_sources), 'claims', cardinality(v_claims));

  delete from link_suggestions where project_id = any (v_projects) or claim_id = any (v_claims) or depends_on = any (v_claims);
  delete from transitions where claim_id = any (v_claims) or cause_claim_id = any (v_claims);
  delete from reasons where claim_id = any (v_claims);
  delete from claims where id = any (v_claims);
  delete from events where source_id = any (v_sources);
  delete from sources where id = any (v_sources);
  delete from projects where id = any (v_projects);
  delete from api_tokens where user_id = p_user;
  delete from device_logins where user_id = p_user;
  perform set_config('plumb.deleting', 'off', true);
  return v_counts;
end;
$$;

revoke all on function plumb_delete_user(uuid) from public, anon, authenticated;
