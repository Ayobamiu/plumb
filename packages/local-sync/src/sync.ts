#!/usr/bin/env node
/**
 * local-sync: every laptop AI session becomes findable in Plumb, even when a
 * tool's hooks didn't fire. Sessions from the plumb repo go full mode (claims);
 * everything else goes index_only (title plus summary, cheap).
 *
 * Usage: pnpm --filter @plumb/local-sync sync [--dry-run] [--tool cursor]
 * Dry run sends nothing and prints titles and sizes only, never the text.
 */
import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestText } from "../../../integrations/lib/ingest.mjs";
import { listClaudeSessions, readClaudeSession } from "./readers/claude-code.js";
import { isPlumbSlug, listCursorSessions, readCursorSession } from "./readers/cursor.js";
import { listMuseSessions, readMuseSession } from "./readers/muse.js";
import { joinTurns, type LocalSession, type ToolName } from "./readers/types.js";
import { redactSecrets } from "./secrets.js";
import { defaultStatePath, loadState, saveState, sha256, stateKey, type SyncState } from "./state.js";

const TOOL_ENV: Record<ToolName, string> = {
  claude_code: "PLUMB_TOKEN_CLAUDE_CODE",
  cursor: "PLUMB_TOKEN_CURSOR",
  muse_code: "PLUMB_TOKEN_MUSE_CODE",
};

const TOOL_HISTORY_ENV: Record<ToolName, string> = {
  claude_code: "PLUMB_CLAUDE_HISTORY",
  cursor: "PLUMB_CURSOR_HISTORY",
  muse_code: "PLUMB_MUSE_HISTORY",
};

function defaultHistoryRoot(tool: ToolName): string {
  const home = homedir();
  switch (tool) {
    case "claude_code":
      return join(home, ".claude", "projects");
    case "cursor":
      return join(home, ".cursor", "projects");
    case "muse_code":
      return join(home, ".local", "share", "muse", "sessions");
  }
}

function historyRoot(tool: ToolName): string {
  return process.env[TOOL_HISTORY_ENV[tool]]?.trim() || defaultHistoryRoot(tool);
}

/** The plumb repo root, for full vs index mode. Env wins, else git top-level. */
export function resolveRepoRoot(): string | undefined {
  const env = process.env.PLUMB_REPO_ROOT?.trim();
  if (env) return resolve(env);
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top ? resolve(top) : undefined;
  } catch {
    return undefined;
  }
}

export interface PlanEntry {
  session: LocalSession;
  text: string;
  turns: number;
  hash: string;
  mode: "full" | "index";
  action: "send" | "unchanged" | "empty";
  /** When the session last changed, so an old session isn't saved as new. */
  at: string;
}

function readSession(session: LocalSession): { text: string; turns: number; title?: string; workdir?: string } {
  const read =
    session.tool === "claude_code"
      ? readClaudeSession
      : session.tool === "cursor"
        ? readCursorSession
        : readMuseSession;
  const { turns, title, workdir } = read(session.file);
  return {
    text: redactSecrets(joinTurns(turns)),
    turns: turns.length,
    ...(title && { title }),
    ...(workdir && { workdir }),
  };
}

function isPlumbSession(session: LocalSession, workdir: string | undefined, repoRoot: string | undefined): boolean {
  if (!repoRoot) return false;
  if (session.tool === "cursor") {
    return !!session.slug && isPlumbSlug(session.slug, repoRoot);
  }
  return !!workdir && resolve(workdir) === repoRoot;
}

export function planSessions(
  tools: ToolName[],
  state: SyncState,
  repoRoot: string | undefined,
): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const tool of tools) {
    const list =
      tool === "claude_code"
        ? listClaudeSessions
        : tool === "cursor"
          ? listCursorSessions
          : listMuseSessions;
    for (const session of list(historyRoot(tool))) {
      const { text, turns, title, workdir } = readSession(session);
      const hash = sha256(text);
      const prev = state.sessions[stateKey(tool, session.externalId)];
      const action = !text ? "empty" : prev?.hash === hash ? "unchanged" : "send";
      entries.push({
        session: { ...session, ...(title && { title }) },
        text,
        turns,
        hash,
        mode: isPlumbSession(session, workdir, repoRoot) ? "full" : "index",
        action,
        at: statSync(session.file).mtime.toISOString(),
      });
    }
  }
  return entries;
}

export interface RunOptions {
  tools: ToolName[];
  dryRun: boolean;
  statePath: string;
  repoRoot: string | undefined;
  send?: typeof ingestText;
  tokens?: Partial<Record<ToolName, string>>;
}

export interface ToolCoverage {
  tool: ToolName;
  found: number;
  sent: number;
  unchanged: number;
  empty: number;
  failed: number;
  lastSaved: string | null;
}

function tokenFor(tool: ToolName, overrides?: Partial<Record<ToolName, string>>): string | undefined {
  return overrides?.[tool] ?? process.env[TOOL_ENV[tool]]?.trim() ?? process.env.PLUMB_INGEST_TOKEN?.trim() ?? undefined;
}

export async function runSync(opts: RunOptions): Promise<{ coverage: ToolCoverage[]; stopped503: boolean }> {
  const state = loadState(opts.statePath);
  const send = opts.send ?? ingestText;
  const entries = planSessions(opts.tools, state, opts.repoRoot);

  if (!opts.dryRun) {
    const needTokens = new Set(entries.filter((e) => e.action === "send").map((e) => e.session.tool));
    for (const tool of needTokens) {
      if (!tokenFor(tool, opts.tokens)) {
        throw new Error(`${TOOL_ENV[tool]} is not set (needed to send ${tool} sessions)`);
      }
    }
  }

  const coverage = new Map<ToolName, ToolCoverage>();
  for (const tool of opts.tools) {
    coverage.set(tool, { tool, found: 0, sent: 0, unchanged: 0, empty: 0, failed: 0, lastSaved: null });
  }
  const savedAt = (tool: ToolName): void => {
    const prev = state.sessions;
    let latest: string | null = null;
    for (const [key, rec] of Object.entries(prev)) {
      if (key.startsWith(`${tool}:`) && (!latest || rec.sentAt > latest)) latest = rec.sentAt;
    }
    coverage.get(tool)!.lastSaved = latest;
  };

  let stopped503 = false;
  for (const entry of entries) {
    const cov = coverage.get(entry.session.tool)!;
    cov.found += 1;
    const short = entry.session.externalId.slice(0, 8);
    if (entry.action === "unchanged") {
      cov.unchanged += 1;
      continue;
    }
    if (entry.action === "empty") {
      cov.empty += 1;
      continue;
    }
    if (opts.dryRun) {
      console.log(
        `[dry-run] ${entry.session.tool} ${short} mode=${entry.mode} turns=${entry.turns} chars=${entry.text.length} title=${entry.session.title ?? "-"}`,
      );
      continue;
    }
    try {
      await send({
        text: entry.text,
        sourceKind: entry.session.tool,
        externalId: entry.session.externalId,
        ...(entry.session.title && { title: entry.session.title }),
        token: tokenFor(entry.session.tool, opts.tokens)!,
        indexOnly: entry.mode === "index",
        at: entry.at,
      });
      cov.sent += 1;
      // Advance only after a 2xx.
      state.sessions[stateKey(entry.session.tool, entry.session.externalId)] = {
        hash: entry.hash,
        sentAt: new Date().toISOString(),
        mode: entry.mode,
      };
      saveState(opts.statePath, state);
      console.log(`[sent] ${entry.session.tool} ${short} mode=${entry.mode} chars=${entry.text.length}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP 503\b/.test(msg)) {
        console.error(`[stop] ${entry.session.tool} ${short}: ${msg}; retry next run`);
        stopped503 = true;
        break;
      }
      cov.failed += 1;
      console.error(`[fail] ${entry.session.tool} ${short}: ${msg}`);
    }
  }

  for (const tool of opts.tools) savedAt(tool);
  for (const cov of coverage.values()) {
    console.log(
      `[coverage] ${cov.tool} found=${cov.found} sent=${cov.sent} unchanged=${cov.unchanged} empty=${cov.empty} failed=${cov.failed} last_saved=${cov.lastSaved ?? "-"}`,
    );
  }
  return { coverage: [...coverage.values()], stopped503 };
}

const ALL_TOOLS: ToolName[] = ["claude_code", "cursor", "muse_code"];

function parseArgs(argv: string[]): { dryRun: boolean; tools: ToolName[]; statePath: string } {
  let dryRun = false;
  let tools: ToolName[] = [...ALL_TOOLS];
  let statePath = process.env.PLUMB_SYNC_STATE?.trim() || defaultStatePath();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--tool") {
      const name = argv[++i]?.toLowerCase().replace(/-/g, "_");
      if (name !== "claude_code" && name !== "cursor" && name !== "muse_code") {
        throw new Error(`--tool must be claude-code, cursor or muse-code (got ${argv[i]})`);
      }
      tools = [name];
    } else if (arg === "--state") {
      statePath = argv[++i] ?? statePath;
    } else {
      throw new Error(`unknown arg ${arg}`);
    }
  }
  return { dryRun, tools, statePath };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  (async () => {
    try {
      const args = parseArgs(process.argv.slice(2));
      const { coverage, stopped503 } = await runSync({
        tools: args.tools,
        dryRun: args.dryRun,
        statePath: args.statePath,
        repoRoot: resolveRepoRoot(),
      });
      const failed = coverage.reduce((n, c) => n + c.failed, 0);
      process.exit(stopped503 || failed > 0 ? 1 : 0);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  })();
}
