# plumb-ai

Bring context from your other AI tools into the one you're using. Plumb saves a short summary of every Claude Code and Cursor session (and your Claude chats, from an export), keeps track of what's still true, and lets any tool find a past session from a description:

```
/plumb gym plan from Claude last week
```

## Get started

```
npx plumb-ai init
```

This signs you in through your browser, connects Claude Code and Cursor (MCP server, `/plumb` command, and hooks that save new sessions), and offers to bring in your past sessions from this computer. You see the counts and say yes first. Restart Claude Code and Cursor afterwards.

Other commands:

- `npx plumb-ai backfill`: bring in past Claude Code and Cursor sessions (`--dry-run` to only count).
- `npx plumb-ai import <export.zip>`: bring in Claude chats. Get the zip from claude.ai > Settings > Privacy > Export data.
- `npx plumb-ai status`: when Plumb last saved each tool.

## What leaves your computer

- Secrets are stripped first (API keys, tokens, passwords, private keys).
- Plumb reads each session to write down what it decided and planned, a title, a short summary and whether it's personal or work. It never stores the transcript itself.
- Your settings files are merged, never replaced, and backed up once as `*.plumb-backup`.
- Your token is in `~/.plumb/config.json`, readable only by you.

Requires Node.js 22.13 or later.
