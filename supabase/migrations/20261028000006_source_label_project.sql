-- Oct 28, Usman OK'd: personal chats carry a label instead of their own project
-- (null means work), and a source can name its project, so a session indexed
-- without claims (index_only /ingest) still shows in that project's @ list.
alter table sources add column label text check (label in ('personal'));
alter table sources add column project_id uuid references projects (id);
create index sources_project_id on sources (project_id);
