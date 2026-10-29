import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "plumb-ai-test-"));
process.env.HOME = tmp; // os.homedir() follows HOME
process.env.PLUMB_HOME = join(tmp, ".plumb");

test("reads Claude Code transcripts: user and assistant text only, no harness noise or tool calls", async () => {
  const dir = join(tmp, ".claude", "projects", "-Users-x-repo");
  mkdirSync(dir, { recursive: true });
  const rows = [
    { cwd: "/Users/x/repo", timestamp: "2026-10-01T10:00:00Z", message: { role: "user", content: "<system-reminder>ignore me</system-reminder>Plan my gym week" } },
    { timestamp: "2026-10-01T10:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "Push pull legs." }, { type: "tool_use", name: "Bash" }] } },
    { timestamp: "2026-10-01T10:00:06Z", message: { role: "user", content: [{ type: "tool_result", content: "secret output" }] } },
    { isSidechain: true, message: { role: "assistant", content: "subagent chatter" } },
  ];
  writeFileSync(join(dir, "sess-1.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n");
  const { listClaudeCodeSessions } = await import("../lib/sources/claude-code.mjs");
  const [s] = listClaudeCodeSessions();
  assert.equal(s.external_id, "sess-1");
  const r = s.read();
  assert.equal(r.text, "User:\nPlan my gym week\n\nClaude Code:\nPush pull legs.");
  assert.equal(r.cwd, "/Users/x/repo");
  assert.equal(r.last_at, "2026-10-01T10:00:06Z");
});

test("reads Cursor chats from its database, skipping drafts and chats with no text", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(tmp, "state.vscdb");
  const db = new DatabaseSync(path);
  db.exec("create table cursorDiskKV (key text unique on conflict replace, value blob)");
  const put = db.prepare("insert into cursorDiskKV (key, value) values (?, ?)");
  put.run("composerData:c1", JSON.stringify({ composerId: "c1", name: "Auth refactor", createdAt: 1761954573186, lastUpdatedAt: 1761954600000 }));
  put.run("composerData:c2", JSON.stringify({ composerId: "c2", isDraft: true }));
  put.run("composerData:c3", JSON.stringify({ composerId: "c3" }));
  put.run("bubbleId:c1:b2", JSON.stringify({ type: 2, text: "Done, tokens per tool.", createdAt: "2025-11-01T02:30:00Z" }));
  put.run("bubbleId:c1:b1", JSON.stringify({ type: 1, text: "Refactor auth", createdAt: "2025-11-01T02:29:32Z" }));
  put.run("bubbleId:c1:b3", JSON.stringify({ type: 2, text: "", createdAt: "2025-11-01T02:31:00Z" }));
  put.run("bubbleId:c2:b1", JSON.stringify({ type: 1, text: "draft text" }));
  db.close();
  process.env.PLUMB_CURSOR_DB = path;
  const { listCursorChats } = await import("../lib/sources/cursor.mjs");
  const chats = await listCursorChats();
  assert.deepEqual(chats.map((c) => [c.external_id, c.title]), [["c1", "Auth refactor"]]);
  assert.equal(chats[0].read().text, "User:\nRefactor auth\n\nCursor:\nDone, tokens per tool.");
});

test("install merges into existing settings, keeps a backup, and is idempotent", async () => {
  const claudeDir = join(tmp, ".claude");
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
  mkdirSync(join(tmp, ".cursor"), { recursive: true });
  writeFileSync(join(tmp, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { url: "https://x" } } }));
  const { installClaudeCode, installCursor } = await import("../lib/install.mjs");
  const cfg = { api: "https://plumb.example", token: "plumb_test" };
  for (let i = 0; i < 2; i++) {
    process.env.PATH = "/nonexistent"; // no claude CLI here: MCP step prints the command instead
    installClaudeCode(cfg);
    installCursor(cfg);
  }
  const s = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  assert.equal(s.theme, "dark");
  assert.equal(s.hooks.Stop.length, 2); // theirs plus ours, once
  assert.equal(s.hooks.Stop[0].hooks[0].command, "echo mine");
  assert.match(s.hooks.SessionEnd[0].hooks[0].command, /plumb\.mjs" hook claude-code$/);
  assert.ok(existsSync(join(claudeDir, "settings.json.plumb-backup")));
  assert.ok(existsSync(join(claudeDir, "commands", "plumb.md")));
  const m = JSON.parse(readFileSync(join(tmp, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(m.mcpServers).sort(), ["other", "plumb"]);
  assert.equal(m.mcpServers.plumb.headers.Authorization, "Bearer plumb_test");
  const h = JSON.parse(readFileSync(join(tmp, ".cursor", "hooks.json"), "utf8"));
  assert.equal(h.hooks.stop.length, 1);
});
