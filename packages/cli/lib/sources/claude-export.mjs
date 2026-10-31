// Claude chats (claude.ai and the Claude desktop app) live on Anthropic's
// servers; the official way out is Settings > Privacy > Export data, which
// emails a zip. This reads that zip (or its conversations.json).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // Only what was said: exports also hold thinking, tool calls and injected prompts.
  return content.map((p) => (typeof p === "string" ? p : p?.type === "text" && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
}

function find(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      const hit = find(p, name);
      if (hit) return hit;
    } else if (entry === name) return p;
  }
  return undefined;
}

export function readExport(path) {
  let jsonPath = path;
  let tmp;
  if (extname(path).toLowerCase() === ".zip") {
    tmp = mkdtempSync(join(tmpdir(), "plumb-export-"));
    execFileSync("unzip", ["-qo", path, "-d", tmp], { stdio: "pipe" });
    jsonPath = find(tmp, "conversations.json");
    if (!jsonPath) throw new Error("no conversations.json in that zip");
  }
  try {
    const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
    const list = Array.isArray(raw) ? raw : raw.conversations || [];
    return list
      .map((c) => {
        const turns = (c.chat_messages || c.messages || [])
          .map((m) => {
            const who = String(m.sender || m.role || "").toLowerCase();
            const text = (textOf(m.content) || (typeof m.text === "string" ? m.text : "")).trim();
            if (!text) return undefined;
            return who === "human" || who === "user" ? `User:\n${text}` : `Claude:\n${text}`;
          })
          .filter(Boolean);
        return {
          tool: "Claude chat",
          kind: "claude_chat",
          external_id: c.uuid || c.id,
          title: typeof c.name === "string" && c.name.trim() ? c.name.trim() : undefined,
          modified_at: c.updated_at || c.created_at,
          workspace: "chats",
          read: () => ({ text: turns.join("\n\n"), list: turns, turns: turns.length, last_at: c.updated_at || c.created_at }),
        };
      })
      .filter((c) => c.external_id);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
