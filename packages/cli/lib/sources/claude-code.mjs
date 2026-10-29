// Claude Code keeps every session as JSONL under ~/.claude/projects/<folder>/<session-id>.jsonl
// (Claude desktop's Code tab writes there too). The session id is what the hooks send.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const root = () => process.env.PLUMB_CLAUDE_DIR || join(homedir(), ".claude", "projects");

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text" && p.text).map((p) => p.text).join("\n");
}

// Harness text the user never typed.
const NOISE = /<(system-reminder|local-command-stdout|local-command-caveat|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

/** Labeled turns (User: / Claude Code:) from one transcript; tool calls and results are left out. */
export function readClaudeCodeTranscript(path) {
  const turns = [];
  let cwd;
  let first;
  let last;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.isSidechain) continue;
    cwd ??= row.cwd;
    if (row.timestamp) {
      first ??= row.timestamp;
      last = row.timestamp;
    }
    const msg = row.message;
    const role = msg?.role;
    const text = textOf(msg?.content).replace(NOISE, "").trim();
    if (!text || (role !== "user" && role !== "assistant")) continue;
    turns.push(`${role === "user" ? "User" : "Claude Code"}:\n${text}`);
  }
  return { text: turns.join("\n\n"), turns: turns.length, cwd, first_at: first, last_at: last };
}

export function listClaudeCodeSessions() {
  const dir = root();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const folder of readdirSync(dir)) {
    const full = join(dir, folder);
    if (!statSync(full).isDirectory()) continue;
    for (const name of readdirSync(full)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(full, name);
      out.push({
        tool: "Claude Code",
        kind: "claude_code",
        external_id: basename(name, ".jsonl"),
        path,
        modified_at: statSync(path).mtime.toISOString(),
        read: () => readClaudeCodeTranscript(path),
      });
    }
  }
  return out;
}
