// Cursor keeps every chat in one local SQLite database (state.vscdb), table
// cursorDiskKV: composerData:<chatId> is a chat, bubbleId:<chatId>:<msgId> a
// message (type 1 user, 2 assistant). Read-only; Cursor can stay open. The chat
// id is the conversation_id Cursor's hooks send. Most chats there are empty
// drafts; a chat counts once it has a message with text.
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

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
  return { text: turns.join("\n\n"), turns: turns.length, first_at: iso(msgs[0]?.createdAt), last_at: iso(msgs.at(-1)?.createdAt) };
}

export async function listCursorChats() {
  const db = await open();
  if (!db) return [];
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
      modified_at: iso(c.lastUpdatedAt) ?? iso(c.createdAt),
      read,
    });
  }
  return chats;
}
