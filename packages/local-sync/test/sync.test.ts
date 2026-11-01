import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyState, loadState, sha256, stateKey } from "../src/state.js";
import { planSessions, runSync } from "../src/sync.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fx = (...parts: string[]) => resolve(testDir, "fixtures", ...parts);
const REPO = "/fake/plumb";

const ENV_KEYS = [
  "PLUMB_CLAUDE_HISTORY",
  "PLUMB_CURSOR_HISTORY",
  "PLUMB_MUSE_HISTORY",
  "PLUMB_TOKEN_CLAUDE_CODE",
  "PLUMB_TOKEN_CURSOR",
  "PLUMB_TOKEN_MUSE_CODE",
  "PLUMB_INGEST_TOKEN",
] as const;
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.PLUMB_CLAUDE_HISTORY = fx("claude");
  process.env.PLUMB_CURSOR_HISTORY = fx("cursor");
  process.env.PLUMB_MUSE_HISTORY = fx("muse");
  delete process.env.PLUMB_TOKEN_CLAUDE_CODE;
  delete process.env.PLUMB_TOKEN_CURSOR;
  delete process.env.PLUMB_TOKEN_MUSE_CODE;
  delete process.env.PLUMB_INGEST_TOKEN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe("planSessions", () => {
  it("sends everything on first run, plumb sessions full and the rest index", () => {
    const entries = planSessions(["claude_code", "cursor", "muse_code"], emptyState(), REPO);
    expect(entries).toHaveLength(6);
    expect(entries.every((e) => e.action === "send")).toBe(true);
    const byId = Object.fromEntries(entries.map((e) => [e.session.externalId.slice(0, 4), e.mode]));
    expect(byId).toEqual({ aaaa: "full", bbbb: "index", cccc: "full", dddd: "index", ffff: "full", gggg: "index" });
  });

  it("marks unchanged sessions when the hash matches", () => {
    const first = planSessions(["cursor"], emptyState(), REPO);
    const state = emptyState();
    for (const e of first) {
      state.sessions[stateKey(e.session.tool, e.session.externalId)] = {
        hash: e.hash,
        sentAt: "2026-10-28T00:00:00Z",
        mode: e.mode,
      };
    }
    const second = planSessions(["cursor"], state, REPO);
    expect(second.every((e) => e.action === "unchanged")).toBe(true);
  });

  it("sends everything index when the repo root is unknown", () => {
    const entries = planSessions(["claude_code"], emptyState(), undefined);
    expect(entries.every((e) => e.mode === "index")).toBe(true);
  });
});

describe("runSync", () => {
  it("dry run sends nothing", async () => {
    const send = vi.fn();
    const dir = mkdtempSync(join(tmpdir(), "local-sync-"));
    const { coverage } = await runSync({
      tools: ["cursor"],
      dryRun: true,
      statePath: join(dir, "state.json"),
      repoRoot: REPO,
      send: send as never,
    });
    expect(send).not.toHaveBeenCalled();
    expect(coverage[0]).toMatchObject({ tool: "cursor", found: 2, sent: 0 });
  });

  it("sends and advances state only for successes", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const dir = mkdtempSync(join(tmpdir(), "local-sync-"));
    const statePath = join(dir, "state.json");
    const { coverage, stopped503 } = await runSync({
      tools: ["muse_code"],
      dryRun: false,
      statePath,
      repoRoot: REPO,
      send: send as never,
      tokens: { muse_code: "tok" },
    });
    expect(stopped503).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toMatchObject({ sourceKind: "muse_code", indexOnly: false });
    expect(send.mock.calls[1]![0]).toMatchObject({ sourceKind: "muse_code", indexOnly: true });
    expect(coverage[0]).toMatchObject({ sent: 2, failed: 0 });
    expect(Object.keys(loadState(statePath).sessions)).toHaveLength(2);
  });

  it("stops on 503 without advancing the failed session", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("ingest HTTP 503: busy"));
    const dir = mkdtempSync(join(tmpdir(), "local-sync-"));
    const statePath = join(dir, "state.json");
    const { stopped503 } = await runSync({
      tools: ["cursor"],
      dryRun: false,
      statePath,
      repoRoot: REPO,
      send: send as never,
      tokens: { cursor: "tok" },
    });
    expect(stopped503).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(loadState(statePath)).toEqual(emptyState());
  });

  it("keeps going on other errors and only advances successes", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("ingest HTTP 400: bad"))
      .mockResolvedValueOnce({ ok: true });
    const dir = mkdtempSync(join(tmpdir(), "local-sync-"));
    const statePath = join(dir, "state.json");
    const { coverage, stopped503 } = await runSync({
      tools: ["cursor"],
      dryRun: false,
      statePath,
      repoRoot: REPO,
      send: send as never,
      tokens: { cursor: "tok" },
    });
    expect(stopped503).toBe(false);
    expect(coverage[0]).toMatchObject({ sent: 1, failed: 1 });
    const sessions = loadState(statePath).sessions;
    expect(Object.keys(sessions)).toHaveLength(1);
    expect(Object.keys(sessions)[0]).toContain("dddd4444");
  });

  it("refuses a real send without the tool token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-sync-"));
    await expect(
      runSync({ tools: ["cursor"], dryRun: false, statePath: join(dir, "s.json"), repoRoot: REPO, tokens: {} }),
    ).rejects.toThrow(/PLUMB_TOKEN_CURSOR/);
  });

  it("hashes the redacted text", () => {
    expect(sha256("x")).toHaveLength(64);
  });
});
