#!/usr/bin/env node
// plumb: connect Claude Code and Cursor to Plumb and bring in past chats.
//   plumb init              sign in, connect your tools, offer to bring in past sessions
//   plumb backfill          bring in past Claude Code and Cursor sessions (asks first)
//   plumb import <zip>      bring in Claude chats from a claude.ai data export
//   plumb status            when Plumb last saved each tool
// Every text is stripped of secrets before it leaves this machine, and sent in
// index mode: Plumb keeps a title and a short summary, never the transcript.
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
import { indexSession, post, PlumbError } from "../lib/api.mjs";
import { DEFAULT_API, home, loadConfig, loadState, saveConfig, saveState } from "../lib/config.mjs";
import { copyApp, hasClaudeCode, hasCursor, installClaudeCode, installCursor, refreshApp } from "../lib/install.mjs";
import { scrub } from "../lib/scrub.mjs";
import { listClaudeCodeSessions, readClaudeCodeTranscript } from "../lib/sources/claude-code.mjs";
import { listCursorChats } from "../lib/sources/cursor.mjs";
import { readExport } from "../lib/sources/claude-export.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => args.includes(name);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const MID_SESSION_MS = 15 * 60 * 1000; // a running session is saved at most every 15 minutes
const PARALLEL = 3;

function need() {
  const c = loadConfig();
  if (!c?.token) {
    console.error("Not signed in. Run: npx plumb-ai init");
    process.exit(1);
  }
  return c;
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

async function init() {
  const api = opt("--api") || process.env.PLUMB_API_URL || loadConfig()?.api || DEFAULT_API;
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

  copyApp();
  const config = loadConfig();
  for (const [name, present, install] of [
    ["Claude Code", hasClaudeCode(), installClaudeCode],
    ["Cursor", hasCursor(), installCursor],
  ]) {
    if (!present) {
      console.log(`${name}: not found on this computer, skipped.`);
      continue;
    }
    console.log(`${name}: ${install(config).join("; ")}.`);
  }
  console.log("\nNew sessions now save on their own. Restart Claude Code and Cursor to load the changes.\n");

  if (!flag("--no-backfill")) await backfill();
  console.log("Claude chats (claude.ai and the desktop app) live on Anthropic's servers. To bring them in:");
  console.log("  1. claude.ai > Settings > Privacy > Export data. You get an email with a link.");
  console.log("  2. Download the zip while signed in, then run: npx plumb-ai import <the zip>\n");
}

// ---- sending ----

async function send(config, sessions) {
  const state = loadState();
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let stop;
  const queue = [...sessions];
  async function worker() {
    while (queue.length && !stop) {
      const s = queue.shift();
      const read = s.read();
      const text = scrub(read.text);
      const h = hash(text);
      if (!read.turns || state.sent[key(s)]?.hash === h) {
        skipped++;
        continue;
      }
      try {
        await indexSession(config, { kind: s.kind, external_id: s.external_id, title: s.title, text, at: read.last_at ?? s.modified_at });
        state.sent[key(s)] = { hash: h, at: new Date().toISOString() };
        sent++;
        if (sent % 5 === 0) saveState(state);
        process.stdout.write(`\r  saved ${sent}, unchanged ${skipped}, failed ${failed}`);
      } catch (err) {
        failed++;
        if (err.status === 401) stop = "Your token isn't valid any more. Run plumb init again.";
        else if (err.status === 503) stop = "Plumb's model is busy right now. Run the same command later; it picks up where it stopped.";
        else console.error(`\n  ${s.tool} ${s.external_id}: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  saveState(state);
  console.log(`\r  saved ${sent}, unchanged or empty ${skipped}, failed ${failed}`);
  if (stop) console.log(`  ${stop}`);
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
  console.log("\nPlumb keeps a title and a short summary of each, and marks personal ones. Secrets are stripped first. Sessions already saved are skipped.");
  if (flag("--dry-run") || !(await ask(`Bring in ${all.length} sessions now?`))) {
    console.log(`Nothing sent. Run \`npx plumb-ai backfill\` when you're ready${process.stdin.isTTY ? "" : " (add --yes to skip the question)"}.\n`);
    return;
  }
  await send(config, all);
  console.log();
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
  await send(config, chats);
}

async function status() {
  const config = need();
  const { projects } = await post(config.api, "/tools/list_projects", {}, config.token);
  if (!projects.length) return console.log("Signed in, no projects yet.");
  const state = await post(config.api, "/tools/get_project_state", { project_id: projects[0].id }, config.token);
  const md = state.markdown ?? "";
  console.log(md.includes("## Saving from your tools") ? md.slice(md.indexOf("## Saving from your tools")) : "No coverage yet.");
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
  const final = input.hook_event_name === "SessionEnd";
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
    if (path) session = { kind, external_id: id, read: () => readClaudeCodeTranscript(path) };
  }
  if (!session) return hookLog(`${tool} ${id}: session not found`);
  const read = session.read();
  const text = scrub(read.text);
  if (!read.turns || last?.hash === hash(text)) return;
  try {
    await indexSession(config, { kind, external_id: id, title: session.title, text, at: read.last_at });
    state.sent[`${kind}:${id}`] = { hash: hash(text), at: new Date().toISOString() };
    saveState(state);
    hookLog(`${tool} ${id}: saved`);
  } catch (err) {
    hookLog(`${tool} ${id}: ${err.message}`);
  }
}

const commands = { init, backfill, import: importExport, status, hook, "hook-send": hookSend };
const run = commands[cmd];
if (run && !cmd.startsWith("hook")) {
  try {
    refreshApp();
  } catch {
    /* an old copy still works; never block a command on this */
  }
}
if (!run) {
  console.log("Usage: plumb init | backfill [--tool claude-code|cursor] [--dry-run] [--yes] | import <zip> | status");
  process.exit(cmd ? 1 : 0);
}
run().catch((err) => {
  if (cmd?.startsWith("hook")) return hookLog(`error: ${err.message}`);
  console.error(err.message);
  process.exit(1);
});
