-- Missing depends_on links the sleep-time sweep suggests (tab 2). Suggestions
-- are never applied silently: Usman accepts or dismisses each one. Accepting
-- adds the link through record_claims (same_as plus a depends_on reason), so
-- the six Contract tables are unchanged. Plumbing, like watcher_cursors.
-- Rows are never deleted; a dismissed pair stays so it isn't suggested again.

create table link_suggestions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id),
  claim_id uuid not null references claims (id),    -- would depend on ...
  depends_on uuid not null references claims (id),  -- ... this claim
  why text not null check (length(why) > 0),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (claim_id, depends_on),
  check (claim_id <> depends_on)
);
create index link_suggestions_project_status on link_suggestions (project_id, status);

alter table link_suggestions enable row level security;
create trigger no_delete before delete on link_suggestions for each row execute function plumb_block_delete();
