// Claims suspended (PLUMB_CLAIMS=0, Nov 25): tools read each other's sessions
// from the sources table only, with no model call and no claims reads.
import type { JsonModel } from "@plumb/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool, ingest, MEMORY_USER, MemoryStore, ScopedStore } from "../src/tools/index.js";

const CONTINUES = "(This continues a session already saved; earlier turns are not shown.)";

/** Any model call fails the test: the cheap path must never pay for one. */
const noModel = {
  json: async () => {
    throw new Error("model called");
  },
} as unknown as JsonModel;

function setup() {
  const inner = new MemoryStore();
  const project = inner.addProject("plumb", MEMORY_USER, "/Users/u/plumb");
  const store = new ScopedStore(inner, MEMORY_USER);
  const reads = { claims: 0, reasons: 0 };
  const loadClaims = inner.loadClaims.bind(inner);
  const loadReasons = inner.loadReasons.bind(inner);
  inner.loadClaims = async (f) => (reads.claims++, loadClaims(f));
  inner.loadReasons = async (f) => (reads.reasons++, loadReasons(f));
  const call = (name: string, input: unknown) => callTool(store, name, input, { model: noModel }) as Promise<any>;
  const save = (external_id: string, text: string, extra: Record<string, unknown> = {}) =>
    ingest(store, noModel, { source: { kind: "claude_code", external_id }, workspace: "/Users/u/plumb", index_only: true, text, at: "2026-11-25T10:00:00Z", ...extra });
  return { inner, store, project, call, save, reads };
}

describe("claims suspended", () => {
  beforeEach(() => {
    process.env.PLUMB_CLAIMS = "0";
  });
  afterEach(() => {
    delete process.env.PLUMB_CLAIMS;
  });

  it("indexes raw text locally and keeps the recent turns", async () => {
    const { inner, save } = setup();
    await save("s1", "User: fix the polling loop in supabase\n\nAssistant: The clock tick loads every claim. I added a pre-check.");
    const [src] = inner.sources;
    expect(src!.title).toBe("fix the polling loop in supabase");
    expect(src!.digest).toContain("I added a pre-check.");
    expect(src!.summary).toContain("polling loop");
    expect(src!.last_at).toBe("2026-11-25T10:00:00Z");
    expect(inner.claims.size).toBe(0);
  });

  it("appends a continued save to the stored turns", async () => {
    const { inner, save } = setup();
    await save("s1", "User: first part\n\nAssistant: first answer");
    await save("s1", `${CONTINUES}\n\nUser: second part\n\nAssistant: second answer`);
    const digest = inner.sources[0]!.digest!;
    expect(digest).toContain("first answer");
    expect(digest).toContain("second answer");
    expect(digest).not.toContain(CONTINUES);
  });

  it("a client summary still wins (Cursor's host index)", async () => {
    const { inner, save } = setup();
    await save("s1", "User: hi\n\nAssistant: hello", { summary: "Planned the cheap read path for Plumb.", indexed_by: "cursor/test" });
    expect(inner.sources[0]!.summary).toBe("Planned the cheap read path for Plumb.");
  });

  it("find_context ranks word matches, filters by named tool, and never reads claims", async () => {
    const { call, save, reads, inner } = setup();
    await save("s1", "User: gym plan for the week\n\nAssistant: Mon legs, Wed push, Fri pull.");
    await save("s2", "User: supabase request count is high\n\nAssistant: The clock watcher scans claims every minute.");
    inner.sources.push({ id: "c0ffee00-0000-4000-8000-000000000000", kind: "cursor", external_id: "c1", title: "Gym tracker UI", user_id: MEMORY_USER, summary: "Built a gym tracker", last_at: "2026-11-24T09:00:00Z" });
    reads.claims = reads.reasons = 0;

    const out = await call("find_context", { query: "gym plan from Claude Code last week" });
    expect(out.contexts[0].tool).toBe("Claude Code");
    expect(out.contexts[0].title).toBe("gym plan for the week");
    expect(out.contexts.every((c: any) => c.tool === "Claude Code")).toBe(true);
    expect(out.contexts[0].why).toMatch(/^Matches/);

    const any = await call("find_context", { query: "gym" });
    expect(any.contexts.map((c: any) => c.tool).sort()).toEqual(["Claude Code", "Cursor"]);
    expect(reads).toEqual({ claims: 0, reasons: 0 });
  });

  it("find_context marks sessions that share only some words as near misses", async () => {
    const { call, save } = setup();
    await save("s1", "User: borehole log plan\n\nAssistant: phased plan");
    const out = await call("find_context", { query: "gym plan" });
    expect(out.contexts[0].why).toMatch(/^Not a clear match: shares only plan/);
  });

  it("find_context with no matching words returns recent sessions as near misses", async () => {
    const { call, save } = setup();
    await save("s1", "User: gym plan\n\nAssistant: ok");
    const out = await call("find_context", { query: "quantum physics homework" });
    expect(out.contexts).toHaveLength(1);
    expect(out.contexts[0].why).toMatch(/^Not a clear match/);
  });

  it("get_context hands over summary and recent turns, by uri", async () => {
    const { call, save, reads } = setup();
    await save("s1", "User: supabase request count is high\n\nAssistant: The clock watcher scans claims every minute.");
    const found = await call("find_context", { query: "supabase requests" });
    reads.claims = reads.reasons = 0;
    const got = await call("get_context", { uri: found.contexts[0].uri });
    expect(got.markdown).toContain("## Summary");
    expect(got.markdown).toContain("## Recent turns");
    expect(got.markdown).toContain("The clock watcher scans claims every minute.");
    expect(reads).toEqual({ claims: 0, reasons: 0 });
  });

  it("recent_work lists sessions without reading claims", async () => {
    const { call, save, reads } = setup();
    await save("s1", "User: one\n\nAssistant: a");
    await save("s2", "User: two\n\nAssistant: b", { at: new Date().toISOString() });
    reads.claims = reads.reasons = 0;
    const out = await call("recent_work", { days: 7 });
    expect(out.sessions.map((s: any) => s.title)).toContain("two");
    expect(reads).toEqual({ claims: 0, reasons: 0 });
  });

  it("a clock tick writes nothing and get_project_state reads no claims", async () => {
    const { call, inner, project, reads } = setup();
    const tick = await call("record_event", { kind: "clock", source: { kind: "manual", external_id: "clock" }, occurred_at: "2026-11-25T10:00:00Z", summary: "tick" });
    expect(tick.transitions).toEqual([]);
    expect(inner.events).toHaveLength(0);
    expect(inner.sources).toHaveLength(0);
    const state = await call("get_project_state", { project_id: project.id });
    expect(state.changed_since).toEqual([]);
    expect(reads).toEqual({ claims: 0, reasons: 0 });
  });
});
