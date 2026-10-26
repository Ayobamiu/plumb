-- Where watchers keep their place, so it survives restarts. One row per cursor:
--   gmail          the last Gmail historyId processed
--   doc:<doc id>   the last revision seen for a doc (doc watcher, later)
-- Service role only, like everything else. Rows are updated, never deleted.

create table watcher_cursors (
  name text primary key check (length(name) > 0),
  value text not null,
  updated_at timestamptz not null default now()
);

alter table watcher_cursors enable row level security;
create trigger no_delete before delete on watcher_cursors for each row execute function plumb_block_delete();

-- Read: select value from watcher_cursors where name = 'gmail' (null row means first run).
-- Write: plumb_set_cursor('gmail', '<historyId>'), after the events for that page are recorded.
create function public.plumb_set_cursor(p_name text, p_value text) returns void
language sql set search_path = '' as $$
  insert into public.watcher_cursors (name, value) values (p_name, p_value)
  on conflict (name) do update set value = excluded.value, updated_at = now();
$$;

revoke all on function public.plumb_set_cursor(text, text) from public, anon, authenticated;
grant execute on function public.plumb_set_cursor(text, text) to service_role;
