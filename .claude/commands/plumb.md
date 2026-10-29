---
description: Bring in context from your other AI tools. Example: /plumb gym plan from Claude last week
argument-hint: what you're looking for
---

# /plumb

Bring in context from your other AI tools. Type what you're looking for, for example `/plumb gym plan from Claude last week`. Type `/plumb` alone to see what changed since you last looked.

## Instructions for the model

The user's words after `/plumb` are a description, not keywords: $ARGUMENTS

1. If there are no words, call `list_projects`, pick the project this work belongs to (ask if it's unclear), and call `get_project_state` with its `project_id`. Summarize what changed (OUT or REVIEW) with the one-line reason, then the current IN claims by kind. Stop.
2. Otherwise call `find_context` with `{ "query": "<the user's words, as typed>" }`. Don't rewrite them into keywords.
3. If there is one clear hit, call `get_context` with its `uri`.
4. If there are several, pick the best match, call `get_context` on it, and list the others in one line each as `tool: title (date)`.
5. If there are none, say what you searched for and suggest other words, such as the tool name or a word from the title.

Present the `get_context` result as: what happened, what is still true, what is no longer true and why, and what waits for review. Keep it short and plain. Never use em dashes.

The tools are `mcp__plumb__list_projects`, `mcp__plumb__get_project_state`, `mcp__plumb__find_context` and `mcp__plumb__get_context`.
