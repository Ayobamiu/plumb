/**
 * Helpers for Claude Code JSONL transcripts. Hooks send text to /ingest, never paths.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (part?.type === "text" && part.text) parts.push(part.text);
  }
  return parts.join("\n").trim();
}

/**
 * Ordered labeled turns from a Claude Code JSONL transcript.
 * User → "User:", assistant → "Claude Code:". Improves extraction of decisions.
 */
export function labeledTurnsFromTranscript(path) {
  if (!path || !existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const turns = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const msg = row.message ?? row;
      const role = msg?.role;
      const text = textFromContent(msg?.content);
      if (!text) continue;
      if (role === "user") turns.push(`User:\n${text}`);
      else if (role === "assistant") turns.push(`Claude Code:\n${text}`);
    } catch {
      /* skip bad line */
    }
  }
  return turns;
}

/** @deprecated Prefer labeledTurnsFromTranscript (includes Usman turns). */
export function assistantTextsFromTranscript(path) {
  return labeledTurnsFromTranscript(path)
    .filter((t) => t.startsWith("Claude Code:"))
    .map((t) => t.replace(/^Claude Code:\n?/, ""));
}

function stateDir() {
  const dir = resolve(process.env.TMPDIR || "/tmp", "plumb-claude");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath(sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return resolve(stateDir(), `${safe || "unknown"}.json`);
}

export function loadSessionSaveState(sessionId) {
  const path = statePath(sessionId);
  if (!existsSync(path)) return { lastSaveAt: 0, savedCount: 0 };
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return {
      lastSaveAt: typeof j.lastSaveAt === "number" ? j.lastSaveAt : 0,
      savedCount: typeof j.savedCount === "number" ? j.savedCount : 0,
    };
  } catch {
    return { lastSaveAt: 0, savedCount: 0 };
  }
}

export function writeSessionSaveState(sessionId, state) {
  writeFileSync(statePath(sessionId), JSON.stringify(state), "utf8");
}

/** Real conversation title from a hook payload, if the tool provides one. */
export function nativeTitle(input) {
  const candidates = [
    input?.conversation_title,
    input?.session_title,
    input?.title,
    input?.chat_title,
    input?.thread_title,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 200);
  }
  return undefined;
}

/**
 * Stable Cursor conversation id from a hook payload.
 * Never invents a shared fallback like "cursor-session" (that merges chats).
 */
export function cursorConversationId(input) {
  const candidates = [
    input?.conversation_id,
    input?.session_id,
    input?.conversationId,
    input?.sessionId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 120);
  }
  const path = input?.transcript_path;
  if (typeof path === "string" && path.trim()) {
    const base = path.replace(/\\/g, "/").split("/").pop() || "";
    const id = base.replace(/\.jsonl$/i, "").trim();
    if (id) return id.slice(0, 120);
  }
  return undefined;
}

/**
 * Labeled turns from a Cursor agent-transcripts JSONL file.
 * User → "User:", assistant text → "Cursor:". Skips tool-only blocks.
 */
export function labeledTurnsFromCursorTranscript(path) {
  if (!path || !existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const turns = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const msg = row.message ?? row;
      const role = row.role ?? msg?.role;
      const text = textFromContent(msg?.content ?? row.content);
      if (!text) continue;
      if (role === "user") turns.push(`User:\n${text}`);
      else if (role === "assistant") turns.push(`Cursor:\n${text}`);
    } catch {
      /* skip bad line */
    }
  }
  return turns;
}
