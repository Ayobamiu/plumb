-- Workspaces (Oct 29, Usman OK'd): users never pick projects. A project can
-- stand for a folder (a repo path) or "chats"; sessions from that folder land
-- in it. One project per user and folder. Additive: older servers ignore it.
alter table projects add column workspace text;
alter table projects add constraint projects_user_workspace_key unique (user_id, workspace);

-- Usman's existing project is this repo, so its sessions keep landing there.
update projects set workspace = '/Users/usmanayobami/Documents/plumb'
where id = 'b22fab5f-d621-47d0-88e2-a16da13bf42e' and workspace is null;
