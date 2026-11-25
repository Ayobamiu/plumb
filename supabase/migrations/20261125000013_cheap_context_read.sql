-- Cheap cross-tool read (Nov 25, Usman OK'd: "summary + recent turns", claims suspended).
-- Each source carries what a reader needs, so find_context / get_context /
-- recent_work read one table instead of joining claims, reasons and events:
--   summary  the latest event summary (kept by a trigger on events)
--   last_at  when it last happened (kept by the same trigger)
--   digest   the last turns of a session, secrets already stripped by the client
--   fts      full-text search over title, summary and digest (no model call)

alter table public.sources
  add column if not exists summary text,
  add column if not exists digest text,
  add column if not exists last_at timestamptz;

alter table public.sources
  add column if not exists fts tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', left(coalesce(digest, ''), 100000)), 'C')
  ) stored;

create index if not exists sources_fts_idx on public.sources using gin (fts);
create index if not exists sources_user_last_at_idx on public.sources (user_id, last_at desc);

-- Keep summary and last_at current from events. Clock ticks and raw-text
-- fallbacks ("..." summaries from failed extractions) never count.
create or replace function public.plumb_source_from_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'clock' then
    return new;
  end if;
  update public.sources s
     set last_at = greatest(coalesce(s.last_at, new.occurred_at), new.occurred_at),
         summary = case
           when new.summary like '...%' then s.summary
           when s.last_at is null or new.occurred_at >= s.last_at then new.summary
           else s.summary
         end
   where s.id = new.source_id;
  return new;
end $$;
revoke all on function public.plumb_source_from_event() from public, anon, authenticated;

drop trigger if exists events_update_source on public.events;
create trigger events_update_source after insert on public.events
  for each row execute function public.plumb_source_from_event();

-- Backfill from the events already stored.
update public.sources s
   set last_at = e.last_at, summary = coalesce(e.summary, s.summary)
  from (
    select source_id,
           max(occurred_at) as last_at,
           (array_agg(summary order by occurred_at desc) filter (where summary not like '...%'))[1] as summary
      from public.events
     where kind <> 'clock'
     group by source_id
  ) e
 where e.source_id = s.id;

-- Ranked search for one user. Sessions with every word come first; then any
-- word may match (OR, so a paraphrase still finds something). Within each,
-- title hits and more matches rank higher, newer wins ties. Hidden plumbing
-- sources never show.
create or replace function public.plumb_search_sources(
  p_user uuid,
  p_words text,
  p_kinds text[] default null,
  p_since timestamptz default null,
  p_project uuid default null,
  p_limit int default 10
) returns table (
  id uuid, kind text, external_id text, uri text, title text, label text,
  project_id uuid, user_id uuid, summary text, last_at timestamptz, rank real
)
language sql stable security definer set search_path = '' as $$
  with q as (
    select plainto_tsquery('english', coalesce(p_words, '')) as tand,
           nullif(replace(plainto_tsquery('english', coalesce(p_words, ''))::text, ' & ', ' | '), '')::tsquery as tsq
  )
  select s.id, s.kind::text, s.external_id, s.uri, s.title, s.label,
         s.project_id, s.user_id, s.summary, s.last_at,
         (case when s.fts @@ q.tand then 1 else 0 end + ts_rank_cd(s.fts, q.tsq))::real as rank
    from public.sources s, q
   where s.user_id = p_user
     and q.tsq is not null
     and s.fts @@ q.tsq
     and s.external_id not in ('clock', 'usman-links')
     and s.external_id not like 'smoke-%'
     and (p_kinds is null or s.kind::text = any (p_kinds))
     and (p_since is null or s.last_at >= p_since)
     and (p_project is null or s.project_id = p_project or s.kind::text = 'doc')
   order by rank desc, s.last_at desc nulls last
   limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;
revoke all on function public.plumb_search_sources(uuid, text, text[], timestamptz, uuid, int) from public, anon, authenticated;
grant execute on function public.plumb_search_sources(uuid, text, text[], timestamptz, uuid, int) to service_role;
