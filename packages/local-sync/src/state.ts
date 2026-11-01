// Sync state lives outside the repo (~/.plumb/local-sync.json): one hash per
// session plus when it was last sent. Advance only after a 2xx.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ToolName } from "./readers/types.js";

export interface SessionRecord {
  hash: string;
  sentAt: string;
  mode: "full" | "index";
}

export interface SyncState {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

export function emptyState(): SyncState {
  return { version: 1, sessions: {} };
}

export function defaultStatePath(): string {
  return join(homedir(), ".plumb", "local-sync.json");
}

export function stateKey(tool: ToolName, externalId: string): string {
  return `${tool}:${externalId}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function loadState(path: string): SyncState {
  if (!existsSync(path)) return emptyState();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SyncState>;
  if (raw.version !== 1 || !raw.sessions || typeof raw.sessions !== "object") {
    throw new Error(`bad sync state at ${path}: expected { version: 1, sessions: {} }`);
  }
  return { version: 1, sessions: raw.sessions };
}

export function saveState(path: string, state: SyncState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}
