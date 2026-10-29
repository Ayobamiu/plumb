-- Per user (Oct 28, Usman OK'd). A user is a Supabase Auth account. Projects
-- and sources belong to a user; claims, reasons, events and transitions belong
-- through them. Every server read is scoped to the user behind the bearer token.
-- Existing rows go to Usman's account. Nothing is deleted.
--
-- Phase A (additive, safe with the server already deployed): the default sends
-- rows from the old server to Usman, and both unique keys exist. Phase B
-- (20261029000009, after the new server deploys) drops the old key and the default.

alter table projects add column user_id uuid not null default 'f80190d1-89a8-41bc-8f38-a01ce47fbb2e' references auth.users (id);
alter table sources add column user_id uuid not null default 'f80190d1-89a8-41bc-8f38-a01ce47fbb2e' references auth.users (id);
create index projects_user_id on projects (user_id);

-- The same thread or session id can exist for two users.
alter table sources add constraint sources_user_kind_external_id_key unique (user_id, kind, external_id);

-- One token per user and tool. Only a hash is stored; the token is shown once.
-- Revoked tokens stay, with revoked_at set.
create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  tool text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_tokens_user_id on api_tokens (user_id);

-- `npx plumb init` sign-in: the CLI shows user_code, the user approves it on
-- the homepage, and the CLI trades device_code (only its hash is kept) for a
-- token once.
create table device_logins (
  id uuid primary key default gen_random_uuid(),
  device_code_hash text not null unique,
  user_code text not null unique,
  tool text not null default 'cli',
  user_id uuid references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  token_issued_at timestamptz
);

-- Server only, like every other table: RLS on, no policies.
alter table api_tokens enable row level security;
alter table device_logins enable row level security;
