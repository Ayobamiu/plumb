-- ts_rank_cd can exceed 1, so "rank >= 1 means every word matched" (what
-- find_context reads) misfired on live data. Normalize the score into [0, 1)
-- (flag 32: rank / (rank + 1)); the +1 for an all-words match stays the only
-- way to reach 1.
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
         (case when s.fts @@ q.tand then 1 else 0 end + ts_rank_cd(s.fts, q.tsq, 32))::real as rank
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
