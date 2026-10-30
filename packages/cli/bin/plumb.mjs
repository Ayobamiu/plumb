#!/usr/bin/env node
// plumb: connect Claude Code and Cursor to Plumb and bring in past chats.
//   plumb init              sign in, connect your tools, offer to bring in past sessions
//   plumb backfill          bring in past Claude Code and Cursor sessions (asks first)
//   plumb import <zip>      bring in Claude chats from a claude.ai data export
//   plumb status            when Plumb last saved each tool
//   plumb uninstall         remove Plumb from this computer
//   plumb delete-account    delete your account and everything saved in it
// Every text is stripped of secrets before it leaves this machine. Plumb reads
// it to write down what the session decided and planned (claims with reasons),
// a title and a summary; it never stores the transcript itself.
// Node's built-in SQLite (used read-only for Cursor's history) prints an
// "experimental" warning on first use; it's noise for someone running a CLI.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (String(warning).includes("SQLite") ? undefined : emitWarning(warning, ...rest));

import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { post, PlumbError, saveSession } from "../lib/api.mjs";
import { DEFAULT_API, home, loadConfig, loadState, saveConfig, saveState } from "../lib/config.mjs";
import { copyApp, hasClaudeCode, hasClaudeDesktop, hasCursor, installClaudeCode, installClaudeDesktop, installCursor, installSync, refreshApp, uninstall } from "../lib/install.mjs";
import { changeNote } from "../lib/note.mjs";
import { scrub } from "../lib/scrub.mjs";
import { listClaudeCodeSessions, readClaudeCodeTranscript, repoRoot } from "../lib/sources/claude-code.mjs";
import { listCursorChats } from "../lib/sources/cursor.mjs";
import { readExport } from "../lib/sources/claude-export.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => args.includes(name);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const MID_SESSION_MS = 15 * 60 * 1000; // a running session is saved at most every 15 minutes
const PARALLEL = 3;
const RECENT_DAYS = 30;

function need() {
  const c = loadConfig();
  if (!c?.token) {
    console.error("Not signed in. Run: npx plumb-ai init");
    process.exit(1);
  }
  // PLUMB_API_URL points one run at another server (for example a local one) with the same token.
  return process.env.PLUMB_API_URL ? { ...c, api: process.env.PLUMB_API_URL } : c;
}

async function ask(question) {
  if (flag("--yes")) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

const hash = (text) => createHash("sha256").update(text).digest("hex");
const key = (s) => `${s.kind}:${s.external_id}`;

function openUrl(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(opener, [url], () => {});
}

// ---- init ----

async function signedIn(config) {
  try {
    await post(config.api, "/tools/list_projects", {}, config.token, 10_000);
    return true;
  } catch {
    return false;
  }
}

async function init() {
  const api = opt("--api") || process.env.PLUMB_API_URL || loadConfig()?.api || DEFAULT_API;
  // Running init again (after an update) keeps a token that still works.
  const existing = loadConfig();
  if (existing?.token && existing.api === api && !flag("--relogin") && (await signedIn(existing))) {
    console.log("\nAlready signed in (use --relogin to sign in again).\n");
    return setUp();
  }
  const start = await post(api, "/auth/device", { tool: "cli" });
  console.log(`\nSign in to Plumb in your browser. Your code: ${start.user_code}\n${start.verification_url}\n`);
  openUrl(start.verification_url);

  let token;
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, start.interval * 1000));
    try {
      const got = await post(api, "/auth/device/token", { device_code: start.device_code });
      token = got.access_token;
      saveConfig({ api, token, user_id: got.user_id, signed_in_at: new Date().toISOString() });
      break;
    } catch (err) {
      if (err instanceof PlumbError && err.message === "authorization_pending") continue;
      throw err;
    }
  }
  if (!token) throw new Error("The code expired. Run plumb init again.");
  console.log("Signed in.\n");
  return setUp();
}

async function setUp() {
  copyApp();
  const config = loadConfig();
  for (const [name, present, install] of [
    ["Claude Code", hasClaudeCode(), installClaudeCode],
    ["Cursor", hasCursor(), installCursor],
    ["Claude Desktop", hasClaudeDesktop(), installClaudeDesktop],
  ]) {
    if (!present) {
      console.log(`${name}: not found on this computer, skipped.`);
      continue;
    }
    console.log(`${name}: ${install(config).join("; ")}.`);
  }
  console.log(`Safety net: ${installSync().join("; ")}.`);
  console.log("\nNew sessions now save on their own. Restart Claude Code, Cursor and Claude Desktop to load the changes.\n");

  if (!flag("--no-backfill")) await backfill();
  console.log("Claude chats (claude.ai and the desktop app) live on Anthropic's servers. To bring them in:");
  console.log("  1. claude.ai > Settings > Privacy > Export data. You get an email with a link.");
  console.log("  2. Download the zip while signed in, then run: npx plumb-ai import <the zip>\n");
}

// ---- sending ----

const CONTINUES = "(This continues a session already saved; earlier turns are not shown.)";

/**
 * Save what's new in one session. Full mode sends only the turns added since
 * the last full save, so a long session isn't extracted again every time.
 * Returns false when there was nothing new to send.
 */
async function saveOne(config, state, s, read, { index = false } = {}) {
  const k = key(s);
  const prev = state.sent[k];
  const all = scrub(read.text);
  const h = hash(all);
  if (!read.turns) return false;
  const sameMode = index ? prev?.mode !== "full" : prev?.mode === "full";
  if (sameMode && prev?.hash === h) return false;
  let text = all;
  if (!index) {
    const done = prev?.mode === "full" ? Math.min(prev.turns ?? 0, read.turns) : 0;
    const fresh = read.list.slice(done);
    if (!fresh.length) return false;
    text = (done ? `${CONTINUES}\n\n` : "") + scrub(fresh.join("\n\n"));
  }
  await saveSession(config, { kind: s.kind, external_id: s.external_id, title: s.title, text, at: read.last_at ?? s.modified_at, workspace: read.workspace ?? s.workspace, index });
  state.sent[k] = { hash: h, at: new Date().toISOString(), turns: read.turns, mode: index ? "index" : "full" };
  return true;
}

async function send(config, sessions, opts = {}) {
  const state = loadState();
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let stop;
  const queue = sessions.map((s) => ({ s, tries: 0 }));
  let busyInARow = 0;
  const progress = () => !opts.quiet && process.stdout.write(`\r  saved ${sent}, unchanged ${skipped}, failed ${failed}`);
  async function worker() {
    while (queue.length && !stop) {
      const item = queue.shift();
      const s = item.s;
      try {
        if (await saveOne(config, state, s, s.read(), opts)) {
          sent++;
          if (sent % 5 === 0) saveState(state);
        } else skipped++;
        busyInARow = 0;
        progress();
      } catch (err) {
        if (err.status === 401) {
          failed++;
          stop = "Your token isn't valid any more. Run plumb init again.";
        } else if (err.status === 503) {
          // Meta's model API comes and goes (Oct 29): try this session again
          // later in the run, and give up only if it stays down.
          busyInARow++;
          if (++item.tries < 3) queue.push(item);
          else failed++;
          if (busyInARow >= 6) stop = "Plumb's model is busy right now. Run the same command later; it picks up where it stopped.";
          else await new Promise((r) => setTimeout(r, 5000));
        } else {
          failed++;
          if (!opts.quiet) console.error(`\n  ${s.tool} ${s.external_id}: ${err.message}`);
        }
        progress();
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  saveState(state);
  if (!opts.quiet) console.log(`\r  saved ${sent}, unchanged or empty ${skipped}, failed ${failed}`);
  if (stop && !opts.quiet) console.log(`  ${stop}`);
  return { sent, skipped, failed, stop };
}

function summarize(groups) {
  for (const [tool, list] of groups) {
    const dates = list.map((s) => s.modified_at).filter(Boolean).sort();
    console.log(`  ${tool}: ${list.length} sessions${dates.length ? `, ${dates[0].slice(0, 10)} to ${dates.at(-1).slice(0, 10)}` : ""}`);
  }
}

async function backfill() {
  const config = need();
  const tool = opt("--tool");
  const groups = [];
  if (!tool || tool === "claude-code") groups.push(["Claude Code", listClaudeCodeSessions()]);
  if (!tool || tool === "cursor") groups.push(["Cursor", await listCursorChats()]);
  const all = groups.flatMap(([, l]) => l);
  console.log("Past sessions on this computer:");
  summarize(groups);
  if (!all.length) return;
  console.log(`\nFor sessions from the last ${RECENT_DAYS} days, Plumb writes down what each decided and planned, so it can tell you later what stopped being true. Older ones get a title and a summary, so you can still find them. Personal ones are marked, secrets are stripped first, and sessions already saved are skipped.`);
  if (flag("--dry-run") || !(await ask(`Bring in ${all.length} sessions now?`))) {
    console.log(`Nothing sent. Run \`npx plumb-ai backfill\` when you're ready${process.stdin.isTTY ? "" : " (add --yes to skip the question)"}.\n`);
    return;
  }
  // Claims only matter while work is current: sessions from the last 30 days are
  // read in full; older ones are indexed (title and summary), still findable by
  // description. --full-all reads everything in full, --index nothing.
  const cutoff = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
  const recent = all.filter((s) => !flag("--index") && (flag("--full-all") || Date.parse(s.modified_at ?? 0) >= cutoff));
  const older = all.filter((s) => !recent.includes(s));
  if (recent.length) await send(config, recent);
  if (older.length) {
    if (recent.length) console.log(`  Older than ${RECENT_DAYS} days, indexed only:`);
    await send(config, older, { index: true });
  }
  console.log();
}

/** The hourly safety net: save whatever changed in local history, without asking. */
async function sync() {
  const config = loadConfig();
  if (!config?.token) return;
  const sessions = [...listClaudeCodeSessions(), ...(await listCursorChats())];
  const r = await send(config, sessions, { quiet: true });
  if (r.sent || r.failed) hookLog(`sync: saved ${r.sent}, failed ${r.failed}${r.stop ? ` (${r.stop})` : ""}`);
}

async function importExport() {
  const config = need();
  const path = args[1];
  if (!path || !existsSync(path)) {
    console.error("Usage: plumb import <claude.ai export zip or conversations.json>");
    process.exit(1);
  }
  const chats = readExport(path);
  console.log("In this export:");
  summarize([["Claude chat", chats]]);
  if (!chats.length || flag("--dry-run") || !(await ask(`Bring in ${chats.length} chats now?`))) return;
  await send(config, chats, { index: flag("--index") });
}

async function status() {
  const config = need();
  const { projects } = await post(config.api, "/tools/list_projects", {}, config.token);
  if (!projects.length) return console.log("Signed in, no projects yet.");
  const state = await post(config.api, "/tools/get_project_state", { project_id: projects[0].id }, config.token);
  const md = state.markdown ?? "";
  console.log(md.includes("## Saving from your tools") ? md.slice(md.indexOf("## Saving from your tools")) : "No coverage yet.");
}

async function removeFromComputer() {
  if (!(await ask("Remove Plumb from this computer? Your saved data stays until you run delete-account."))) {
    console.log("Nothing removed.");
    return;
  }
  console.log(`Removed: ${uninstall().join("; ")}.`);
  console.log("Restart Claude Code and Cursor. Your settings backups (*.plumb-backup) are still there.");
}

async function deleteAccount() {
  const config = need();
  console.log("This deletes your Plumb account and everything saved in it, for good, and removes Plumb from this computer.");
  let confirmed = flag("--confirm");
  if (!confirmed && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    confirmed = (await rl.question('Type "delete" to confirm: ')).trim() === "delete";
    rl.close();
  }
  if (!confirmed) {
    console.log("Nothing deleted.");
    return;
  }
  const { deleted } = await post(config.api, "/auth/delete-account", { confirm: "delete" }, config.token);
  console.log(`Deleted ${deleted.sources} sessions, ${deleted.claims} claims and ${deleted.projects} projects.`);
  console.log(`Removed: ${uninstall().join("; ")}.`);
}

// The bridge Claude Desktop launches: MCP over stdin and stdout on one side,
// the Plumb server on the other. One JSON message per line, answered in order.
async function mcpBridge() {
  const config = need();
  const url = `${config.api.replace(/\/$/, "")}/mcp`;
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let id;
    try {
      id = JSON.parse(line).id;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${config.token}` },
        body: line,
      });
      const text = await res.text();
      if (text.trim()) process.stdout.write(text.replace(/\n/g, " ").trim() + "\n");
      else if (id !== undefined) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: `Plumb: ${err.message}` } }) + "\n");
    }
  }
}

// ---- hooks (run by Claude Code and Cursor; must never block or fail them) ----

function hookLog(line) {
  try {
    appendFileSync(join(home(), "hook.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* never fail the tool */
  }
}

async function hook() {
  const tool = args[1];
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    /* no payload */
  }
  if (tool === "cursor") process.stdout.write("{}\n");
  const id = tool === "cursor" ? input.conversation_id : input.session_id;
  if (!id) return;
  const final = /sessionend/i.test(String(input.hook_event_name ?? ""));
  // Send in the background, so the tool isn't kept waiting on the network.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "hook-send", tool, id, input.transcript_path ?? "", final ? "final" : "mid"], { detached: true, stdio: "ignore" });
  child.unref();
}

async function hookSend() {
  const [, tool, id, transcript, when] = args;
  const config = loadConfig();
  if (!config?.token) return;
  const state = loadState();
  const kind = tool === "cursor" ? "cursor" : "claude_code";
  const last = state.sent[`${kind}:${id}`];
  if (when !== "final" && last && Date.now() - Date.parse(last.at) < MID_SESSION_MS) return;

  let session;
  if (tool === "cursor") {
    session = (await listCursorChats()).find((c) => c.external_id === id);
  } else {
    const path = transcript && existsSync(transcript) ? transcript : listClaudeCodeSessions().find((s) => s.external_id === id)?.path;
    if (path) session = { tool: "Claude Code", kind, external_id: id, read: () => readClaudeCodeTranscript(path) };
  }
  if (!session) return hookLog(`${tool} ${id}: session not found`);
  try {
    const saved = await saveOne(config, state, session, session.read());
    if (!saved) return;
    saveState(state);
    hookLog(`${tool} ${id}: saved`);
  } catch (err) {
    hookLog(`${tool} ${id}: ${err.message}`);
  }
}

// The "what changed" note (Oct 29): at session start, at most 5 lines on what
// in this folder went OUT or may be out of date since the last session here.
// Nothing when nothing changed; never slows the start by more than a few seconds.
const START_TIMEOUT_MS = 4000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function hookStart() {
  const tool = args[1];
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    /* no payload */
  }
  let note = "";
  try {
    const config = loadConfig();
    const folder = input.workspace_roots?.[0] ?? input.cwd ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd();
    const workspace = repoRoot(folder);
    if (config?.token && workspace) {
      const { projects } = await post(config.api, "/tools/list_projects", {}, config.token, START_TIMEOUT_MS);
      const project = projects.find((p) => p.workspace === workspace);
      if (project) {
        const state = loadState();
        state.started ??= {};
        const since = state.started[workspace] ?? new Date(Date.now() - WEEK_MS).toISOString();
        const now = new Date().toISOString();
        const got = await post(config.api, "/tools/get_project_state", { project_id: project.id, since }, config.token, START_TIMEOUT_MS);
        note = changeNote(got.changed_since ?? []);
        state.started[workspace] = now;
        saveState(state);
      }
    }
  } catch (err) {
    hookLog(`start ${tool}: ${err.message}`);
  }
  if (tool === "cursor") process.stdout.write(JSON.stringify(note ? { additional_context: note } : {}) + "\n");
  else if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note } }) + "\n");
}

const commands = { init, backfill, import: importExport, status, sync, uninstall: removeFromComputer, "delete-account": deleteAccount, mcp: mcpBridge, hook, "hook-send": hookSend, "hook-start": hookStart };
const run = commands[cmd];
if (run && !cmd.startsWith("hook") && cmd !== "mcp") {
  try {
    refreshApp();
  } catch {
    /* an old copy still works; never block a command on this */
  }
}
if (!run) {
  console.log("Usage: plumb init | backfill [--tool claude-code|cursor] [--dry-run] [--yes] | import <zip> | status | uninstall | delete-account");
  process.exit(cmd ? 1 : 0);
}
run().catch((err) => {
  if (cmd?.startsWith("hook") || cmd === "sync") return hookLog(`${cmd} error: ${err.message}`);
  console.error(err.message);
  process.exit(1);
});
