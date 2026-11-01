// Claude Code history: ~/.claude/projects/<folder>/<session-id>.jsonl.
// Rows with a message carry role user/assistant; rows also carry cwd, and
// custom-title rows carry the user's own title.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { type LocalSession, type SessionText, joinTurns, textFromContent } from "./types.js";

export const TOOL = "claude_code" as const;

export function listClaudeSessions(historyRoot: string): LocalSession[] {
  if (!existsSync(historyRoot)) return [];
  const out: LocalSession[] = [];
  for (const folder of readdirSync(historyRoot)) {
    const dir = resolve(historyRoot, folder);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      out.push({ tool: TOOL, externalId: basename(name, ".jsonl"), file: resolve(dir, name) });
    }
  }
  return out.sort((a, b) => a.externalId.localeCompare(b.externalId));
}

interface ClaudeRow {
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
  role?: unknown;
  content?: unknown;
  cwd?: unknown;
  customTitle?: unknown;
  sessionId?: unknown;
}

export function readClaudeSession(file: string): SessionText {
  const turns: string[] = [];
  let title: string | undefined;
  let workdir: string | undefined;
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return { turns };
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: ClaudeRow;
    try {
      row = JSON.parse(line) as ClaudeRow;
    } catch {
      continue;
    }
    if (!workdir && typeof row.cwd === "string" && row.cwd.trim()) workdir = row.cwd.trim();
    if (row.type === "custom-title" && typeof row.customTitle === "string" && row.customTitle.trim()) {
      title = row.customTitle.trim().slice(0, 200);
    }
    const msg = row.message ?? row;
    const role = (msg as ClaudeRow).role;
    const text = textFromContent((msg as ClaudeRow).content);
    if (!text) continue;
    if (role === "user") turns.push(`Usman:\n${text}`);
    else if (role === "assistant") turns.push(`Claude Code:\n${text}`);
  }
  return { turns, ...(title && { title }), ...(workdir && { workdir }) };
}

export function claudeSessionText(file: string): string {
  return joinTurns(readClaudeSession(file).turns);
}
