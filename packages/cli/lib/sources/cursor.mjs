// Cursor keeps every chat in one local SQLite database (state.vscdb), table
// cursorDiskKV: composerData:<chatId> is a chat, bubbleId:<chatId>:<msgId> a
// message (type 1 user, 2 assistant). Read-only; Cursor can stay open. The chat
// id is the conversation_id Cursor's hooks send. Most chats there are empty
// drafts; a chat counts once it has a message with text.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { join, sep } from "node:path";

export function cursorDbPath() {
  if (process.env.PLUMB_CURSOR_DB) return process.env.PLUMB_CURSOR_DB;
  const p = platform();
  const base =
    p === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : p === "win32"
        ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
        : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "Cursor", "User", "globalStorage", "state.vscdb");
}

/**
 * Which folder each chat belongs to. Newer Cursor keeps a composerHeaders table
 * (workspaceIdentifier.uri.fsPath per chat); older workspaces list their chats
 * in workspaceStorage/<id>/state.vscdb (allComposers).
 */
async function chatFolders(db) {
  const map = new Map();
  try {
    for (const row of db.prepare("select composerId, value from composerHeaders").all()) {
      const path = parse(row.value)?.workspaceIdentifier?.uri?.fsPath;
      if (typeof path === "string" && path) map.set(row.composerId, path);
    }
  } catch {
    /* older Cursor: no composerHeaders table */
  }
  const dir = join(cursorDbPath(), "..", "..", "workspaceStorage");
  if (!existsSync(dir)) return map;
  const { DatabaseSync } = await import("node:sqlite");
  for (const ws of readdirSync(dir)) {
    try {
      const folder = JSON.parse(readFileSync(join(dir, ws, "workspace.json"), "utf8")).folder;
      if (typeof folder !== "string" || !folder.startsWith("file://")) continue;
      const db = new DatabaseSync(join(dir, ws, "state.vscdb"), { readOnly: true });
      const row = db.prepare("select value from ItemTable where key = 'composer.composerData'").get();
      db.close();
      for (const c of parse(row?.value)?.allComposers ?? []) if (c?.composerId && !map.has(c.composerId)) map.set(c.composerId, fileURLToPath(folder));
    } catch {
      /* a workspace Cursor is writing to, or an old format: skip it */
    }
  }
  return map;
}

async function open() {
  const path = cursorDbPath();
  if (!existsSync(path)) return undefined;
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path, { readOnly: true });
}

const parse = (v) => {
  try {
    return JSON.parse(typeof v === "string" ? v : Buffer.from(v).toString("utf8"));
  } catch {
    return undefined;
  }
};
const iso = (v) => (typeof v === "number" ? new Date(v).toISOString() : typeof v === "string" ? v : undefined);

function messages(db, chatId) {
  // A key range, so SQLite uses the primary key instead of scanning 100k rows.
  const rows = db.prepare("select value from cursorDiskKV where key >= ? and key < ?").all(`bubbleId:${chatId}:`, `bubbleId:${chatId};`);
  return rows
    .map((r) => parse(r.value))
    .filter((b) => b && (b.type === 1 || b.type === 2) && typeof b.text === "string" && b.text.trim())
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
}

export function readCursorChat(db, chatId) {
  const msgs = messages(db, chatId);
  const turns = msgs.map((b) => `${b.type === 1 ? "User" : "Cursor"}:\n${b.text.trim()}`);
  return { text: turns.join("\n\n"), list: turns, turns: turns.length, first_at: iso(msgs[0]?.createdAt), last_at: iso(msgs.at(-1)?.createdAt) };
}

// Current Cursor (seen Oct 29) no longer writes chats to state.vscdb: each
// agent chat is a transcript at ~/.cursor/projects/<folder slug>/agent-transcripts/<chat id>/<chat id>.jsonl.
const transcriptsRoot = () => process.env.PLUMB_CURSOR_PROJECTS || join(homedir(), ".cursor", "projects");

/** "Users-me-Documents-core-extract-landing" -> /Users/me/Documents/core-extract-landing, checked against the disk. */
export function folderFromSlug(slug) {
  const parts = slug.split("-").filter(Boolean);
  const walk = (dir, i) => {
    if (i === parts.length) return dir;
    // Try the longest name first: folder names can hold dashes themselves.
    for (let j = parts.length; j > i; j--) {
      const next = join(dir, parts.slice(i, j).join("-"));
      if (existsSync(next) && statSync(next).isDirectory()) {
        const found = walk(next, j);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(sep, 0);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

/** User text arrives as <timestamp>...</timestamp><user_query>...</user_query>. */
const cleanUser = (t) => {
  const q = /<user_query>([\s\S]*?)<\/user_query>/.exec(t);
  return (q ? q[1] : t.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "")).trim();
};

export function readCursorTranscript(path) {
  const turns = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const role = row.role ?? row.message?.role;
    const raw = textOf(row.message?.content ?? row.content).trim();
    const text = role === "user" ? cleanUser(raw) : raw;
    if (!text || (role !== "user" && role !== "assistant")) continue;
    turns.push(`${role === "user" ? "User" : "Cursor"}:\n${text}`);
  }
  const mtime = statSync(path).mtime.toISOString();
  return { text: turns.join("\n\n"), list: turns, turns: turns.length, last_at: mtime };
}

export function listCursorTranscripts() {
  const root = transcriptsRoot();
  if (!existsSync(root)) return [];
  const out = [];
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug, "agent-transcripts");
    if (!existsSync(dir)) continue;
    const workspace = folderFromSlug(slug) ?? "chats";
    for (const id of readdirSync(dir)) {
      const file = join(dir, id, `${id}.jsonl`);
      if (!existsSync(file)) continue;
      out.push({ tool: "Cursor", kind: "cursor", external_id: id, workspace, modified_at: statSync(file).mtime.toISOString(), read: () => ({ ...readCursorTranscript(file), workspace }) });
    }
  }
  return out;
}

/** Every Cursor chat: the old database and the newer transcripts, one entry per chat (the newer copy wins). */
export async function listCursorChats() {
  const byId = new Map();
  for (const c of await listCursorDbChats()) byId.set(c.external_id, c);
  for (const t of listCursorTranscripts()) {
    const old = byId.get(t.external_id);
    if (!old || Date.parse(t.modified_at) >= Date.parse(old.modified_at ?? 0)) byId.set(t.external_id, { ...t, ...(old?.title && { title: old.title }) });
  }
  return [...byId.values()];
}

async function listCursorDbChats() {
  const db = await open();
  if (!db) return [];
  const folders = await chatFolders(db);
  const chats = [];
  for (const row of db.prepare("select key, value from cursorDiskKV where key >= 'composerData:' and key < 'composerData;'").all()) {
    const c = parse(row.value);
    if (!c) continue;
    const id = c.composerId || String(row.key).slice("composerData:".length);
    if (c.isDraft) continue;
    const read = () => readCursorChat(db, id);
    const peek = db.prepare("select 1 from cursorDiskKV where key >= ? and key < ? limit 1").get(`bubbleId:${id}:`, `bubbleId:${id};`);
    if (!peek) continue;
    chats.push({
      tool: "Cursor",
      kind: "cursor",
      external_id: id,
      title: typeof c.name === "string" && c.name.trim() ? c.name.trim() : undefined,
      workspace: folders.get(id) ?? "chats",
      modified_at: iso(c.lastUpdatedAt) ?? iso(c.createdAt),
      read,
    });
  }
  return chats;
}
