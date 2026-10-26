-- Six tables from tab 1 (Contract). Field names match the TypeScript shapes in
-- packages/core/src/contract.ts. Nothing is ever deleted: a trigger blocks
-- DELETE on every table, and events and transitions are append-only.

create type claim_status as enum ('IN', 'OUT', 'REVIEW');
create type claim_kind as enum ('status', 'decision', 'fact', 'next_step', 'open_question', 'goal');
create type source_kind as enum ('gmail_thread', 'doc', 'claude_code', 'cursor', 'claude_chat', 'manual');
create type event_kind as enum ('email_received', 'email_sent', 'doc_edited', 'session_note', 'clock');
create type reason_type as enum ('depends_on', 'evidence', 'absence', 'until');

create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table sources (
  id uuid primary key default gen_random_uuid(),
  kind source_kind not null,
  external_id text not null,
  uri text,
  title text,
  unique (kind, external_id)
);

create table claims (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id),
  text text not null check (length(text) > 0),
  kind claim_kind not null,
  status claim_status not null default 'IN',
  source_id uuid not null references sources (id),
  valid_from timestamptz not null,
  valid_to timestamptz,
  recorded_at timestamptz not null default now(),
  retracted_at timestamptz,
  extracted_by text not null,
  confidence real check (confidence between 0 and 1)
);
create index claims_project_status on claims (project_id, status);

create table events (
  id uuid primary key default gen_random_uuid(),
  kind event_kind not null,
  source_id uuid not null references sources (id),
  occurred_at timestamptz not null,
  observed_at timestamptz not null default now(),
  "from" text,
  thread_id text,
  summary text not null check (length(summary) <= 1000)
);
create index events_kind_from_thread on events (kind, "from", thread_id);
create index events_occurred_at on events (occurred_at);

-- Type-specific fields live in data:
--   depends_on: { "claim": uuid }
--   evidence:   { "event_id": uuid }
--   absence:    { "pattern": AbsencePattern, "since": timestamptz }
--   until:      { "at": timestamptz }
create table reasons (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references claims (id),
  type reason_type not null,
  data jsonb not null,
  check (
    (type = 'depends_on' and data ? 'claim')
    or (type = 'evidence' and data ? 'event_id')
    or (type = 'absence' and data ? 'pattern' and data ? 'since' and data -> 'pattern' ? 'event_kind')
    or (type = 'until' and data ? 'at')
  )
);
create index reasons_type on reasons (type);
create index reasons_claim_id on reasons (claim_id);
-- Reverse lookup for the chain: which claims depend on claim X.
create index reasons_depends_on_target on reasons ((data ->> 'claim')) where type = 'depends_on';

create table transitions (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references claims (id),
  from_status claim_status not null,
  to_status claim_status not null,
  event_id uuid references events (id),
  reason_id uuid references reasons (id),
  cause_claim_id uuid references claims (id),
  depth integer not null default 0 check (depth >= 0),
  explanation text not null check (length(explanation) > 0),
  at timestamptz not null default now()
);
create index transitions_claim on transitions (claim_id, at);
create index transitions_at on transitions (at);

-- Nothing is ever deleted.
create function plumb_block_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'plumb: rows in % are never deleted', tg_table_name;
end;
$$;

-- Events and transitions are a log: no edits either.
create function plumb_block_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'plumb: rows in % are append-only', tg_table_name;
end;
$$;

create trigger no_delete before delete on projects for each row execute function plumb_block_delete();
create trigger no_delete before delete on sources for each row execute function plumb_block_delete();
create trigger no_delete before delete on claims for each row execute function plumb_block_delete();
create trigger no_delete before delete on reasons for each row execute function plumb_block_delete();
create trigger no_delete before delete on events for each row execute function plumb_block_delete();
create trigger no_delete before delete on transitions for each row execute function plumb_block_delete();
create trigger no_update before update on events for each row execute function plumb_block_update();
create trigger no_update before update on transitions for each row execute function plumb_block_update();

-- RLS on, no policies yet: only the service role (server side) can read or
-- write. Cursor adds read policies for the homepage once auth is in.
alter table projects enable row level security;
alter table sources enable row level security;
alter table claims enable row level security;
alter table reasons enable row level security;
alter table events enable row level security;
alter table transitions enable row level security;

-- Homepage live feed.
alter publication supabase_realtime add table transitions;
