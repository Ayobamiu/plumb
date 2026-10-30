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
  assert.equal(h.hooks.sessionEnd.length, 1);
});

test("an update refreshes the hooks' copy; nothing happens if hooks were never installed", async () => {
  const { copyApp, refreshApp, appDir } = await import("../lib/install.mjs");
  const pkgPath = join(appDir(), "package.json");
  refreshApp(); // no copy yet: stays absent
  assert.ok(!existsSync(pkgPath));
  copyApp();
  writeFileSync(pkgPath, JSON.stringify({ version: "0.0.1" }));
  refreshApp();
  assert.notEqual(JSON.parse(readFileSync(pkgPath, "utf8")).version, "0.0.1");
});

test("the hourly sync job is written to run plumb sync from the stable copy", async () => {
  process.env.PLUMB_SKIP_LAUNCHCTL = "1";
  const { installSync } = await import("../lib/install.mjs");
  const out = installSync();
  if (process.platform === "darwin") {
    const plist = readFileSync(join(tmp, "Library", "LaunchAgents", "ai.plumb.sync.plist"), "utf8");
    assert.match(plist, /<integer>3600<\/integer>/);
    assert.match(plist, /\.plumb\/app\/bin\/plumb\.mjs<\/string><string>sync<\/string>/);
  } else assert.match(out[0], /crontab/);
});

test("the session-start note: at most 5 plain lines, nothing when nothing changed; hooks registered", async () => {
  const { changeNote } = await import("../lib/note.mjs");
  assert.equal(changeNote([]), "");
  const row = (text, to, why) => ({ claim: { text }, transition: { to_status: to, explanation: why } });
  const note = changeNote([row("Deploy Friday", "OUT", "Went OUT because CI failed."), row("No reply from Priya", "REVIEW", "Priya may have replied."), ...Array(5).fill(row("x", "OUT", "y"))]);
  assert.match(note, /^Plumb: since your last session in this folder, these changed:\n- No longer true: Deploy Friday\. Went OUT because CI failed\.\n- May be out of date: No reply from Priya\. Priya may have replied\./);
  assert.equal(note.split("\n").filter((l) => l.startsWith("- ")).length, 5);
  assert.match(note, /\(2 more: ask with \/plumb\)$/);
  const s = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf8"));
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /plumb\.mjs" hook-start claude-code$/);
  const h = JSON.parse(readFileSync(join(tmp, ".cursor", "hooks.json"), "utf8"));
  assert.match(h.hooks.sessionStart[0].command, /hook-start cursor$/);
});

test("reads current Cursor's agent transcripts, finds the folder from the slug, and merges with the old database", async () => {
  const projects = join(tmp, "cursor-projects");
  const folder = join(tmp, "Documents", "core-extract-landing");
  mkdirSync(folder, { recursive: true });
  const slug = folder.slice(1).split("/").join("-");
  const dir = join(projects, slug, "agent-transcripts", "chat-new");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chat-new.jsonl"), [
    { role: "user", message: { content: [{ type: "text", text: "<timestamp>Thu, Oct 29</timestamp>\n<user_query>\nWhy did the self-serve signup fail?\n</user_query>" }] } },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "Read" }, { type: "text", text: "The webhook secret was missing." }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.env.PLUMB_CURSOR_PROJECTS = projects;
  const { listCursorChats, folderFromSlug } = await import("../lib/sources/cursor.mjs");
  assert.equal(folderFromSlug(slug), folder);
  const chats = await listCursorChats();
  assert.deepEqual(chats.map((c) => c.external_id).sort(), ["c1", "chat-new"]); // c1 from the old database test
  const r = chats.find((c) => c.external_id === "chat-new").read();
  assert.equal(r.workspace, folder);
  assert.equal(r.text, "User:\nWhy did the self-serve signup fail?\n\nCursor:\nThe webhook secret was missing.");
});

test("uninstall removes only Plumb's entries and leaves everything else", async () => {
  const { installClaudeCode, installCursor, installSync, copyApp, uninstall } = await import("../lib/install.mjs");
  const cfg = { api: "https://plumb.example", token: "plumb_test" };
  installClaudeCode(cfg);
  installCursor(cfg);
  installSync();
  copyApp();
  uninstall();
  const s = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf8"));
  assert.equal(s.theme, "dark");
  assert.deepEqual(Object.keys(s.hooks), ["Stop"]); // their hook stays, ours are gone
  assert.equal(s.hooks.Stop[0].hooks[0].command, "echo mine");
  assert.equal(s.hooks.Stop.length, 1);
  const m = JSON.parse(readFileSync(join(tmp, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(m.mcpServers), ["other"]);
  const h = JSON.parse(readFileSync(join(tmp, ".cursor", "hooks.json"), "utf8"));
  assert.deepEqual(h.hooks, {});
  assert.ok(!existsSync(join(tmp, ".claude", "commands", "plumb.md")));
  assert.ok(!existsSync(join(tmp, ".cursor", "commands", "plumb.md")));
  assert.ok(!existsSync(process.env.PLUMB_HOME));
  if (process.platform === "darwin") assert.ok(!existsSync(join(tmp, "Library", "LaunchAgents", "ai.plumb.sync.plist")));
});
