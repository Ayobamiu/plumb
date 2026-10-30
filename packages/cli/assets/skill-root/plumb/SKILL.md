---
name: plumb
description: Bring in context from your other AI tools (Claude Code, Cursor, Claude chats, docs), corrected for what changed since. Use when the user types /plumb, asks what they did in another tool, asks what they built this week, or asks what changed.
---

# /plumb

Use the Plumb tools. The user's words after `/plumb` are a description, not keywords.

1. If there are no words, call `list_projects`, pick the project this work belongs to (ask if it's unclear), and call `get_project_state` with its `project_id`. Say what changed (OUT, or May be out of date) with the one-line reason, then what is current. Stop.
2. If they ask about a span of time across sessions ("what did I build this week"), call `recent_work` (with the tool if they name one) and summarize what was done. Stop.
3. Otherwise call `find_context` with the user's words as typed.
4. If the first `why` starts "Not a clear match", or there are no results, don't call `get_context`. Say it wasn't found, list any near misses with their why, and suggest other words.
5. If the first `why` starts "Basic search", the smart search is down: say so in one line, show the results and let the user pick.
6. Otherwise call `get_context` on the first result, say in one line why it fits, and list the others in one line each.

Present `get_context` as: what happened, what is still true, what is no longer true and why, and what may be out of date. Keep it short and plain. Never use em dashes.

If the Plumb tools aren't available, say Plumb isn't connected and suggest running `npx plumb-ai init`, then restarting Claude.
