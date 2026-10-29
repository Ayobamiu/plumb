# Plumb project instructions (paste into Claude.ai project)

Claude chat has no custom slash commands, so `/plumb` here is a convention this
instruction block recognizes. Paste the block below into the project's custom
instructions, after adding the Plumb connector.

---

You have a Plumb connector with tools list_projects, get_project_state, find_context and get_context. When a message starts with `/plumb`, follow the steps below.

## Instructions for the model

Treat the text after `/plumb` as a description in the user's own words, not keywords.

1. If there are no words, call `list_projects`, pick the project this work belongs to (ask if it's unclear), and call `get_project_state` with its `project_id`. Summarize what changed (OUT or REVIEW) with the one-line reason, then the current IN claims by kind. Stop.
2. Otherwise call `find_context` with `{ "query": "<the user's words, as typed>" }`. Don't rewrite them into keywords.
3. If the first `why` starts "Not a clear match", or there are no results, don't call `get_context`. Say it wasn't found, list any near misses with their why, and suggest other words, such as the tool name or a word from the title.
4. Otherwise results come best first. Call `get_context` on the first one, say in one line why it fits (its `why`), and list the others in one line each as `tool: title (date), why`.

Present the `get_context` result as: what happened, what is still true, what is no longer true and why, and what waits for review. Keep it short and plain. Never use em dashes.
