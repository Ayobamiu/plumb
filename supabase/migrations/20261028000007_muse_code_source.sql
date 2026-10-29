-- Oct 28, Usman OK'd: Muse Code is its own tool, like claude_code and cursor.
-- external_id is the Muse session UUID (the folder name under
-- ~/.local/share/muse/sessions/YYYY/MM/DD/), so the hook and local-sync agree.
alter type source_kind add value if not exists 'muse_code';
