import { describe, expect, it } from "vitest";
import type { JsonModel } from "@plumb/core";
import { callTool, ingest, listContexts, MemoryStore, readContext } from "../src/tools/index.js";

const extraction = (title: string, claims: unknown[] = []) => ({ claims, contradicts: [], summary: `Summary: ${title}.`, mentions: [], title });
const model = (out: unknown): JsonModel => ({
  async json(opts) {
    if (opts.schemaName === "verdict") return opts.parse.parse({ verdict: "no", quote: null, why: "" }) as never;
    return opts.parse.parse(out) as never;
  },
});
const reason = (x: Record<string, unknown>) => ({ type: "until", event_kind: null, from: null, thread_id: null, text_hint: null, since: null, at: "2027-01-01T00:00:00Z", claim_ref: null, ...x });
const newClaim = (ref: string, text: string, extra: Record<string, unknown> = {}) => ({ ref, text, kind: "status", valid_from: null, confidence: 1, same_as: null, reasons: [reason({})], ...extra });

async function setup() {
  const store = new MemoryStore();
  const project = store.addProject("Meta hackathon");
  const other = store.addProject("Other");
  // A Claude Code session: the hook sends a generic title, so the generated one is used.
  await ingest(store, model(extraction("Auth refactor: middleware done", [newClaim("n1", "All tests pass on main")])), {
    project_id: project.id,
    source: { kind: "claude_code", external_id: "cc-1", title: "Claude Code session" },
    text: "Finished the auth middleware; tests pass on main.",
  });
  // A Cursor conversation with its own title: that one wins.
  await ingest(store, model(extraction("Something generated", [newClaim("n1", "Login page ships Friday", { kind: "next_step" })])), {
    project_id: project.id,
    source: { kind: "cursor", external_id: "conv-9", title: "Login page wiring" },
    text: "Wired the login page.",
  });
  // A session from another project.
  await ingest(store, model(extraction("Billing export")), { project_id: other.id, source: { kind: "cursor", external_id: "conv-x" }, text: "Billing." });
  return { store, project, other };
}

describe("contexts", () => {
  it("lists recent sessions with tool-prefixed names and real titles, per project, newest first", async () => {
    const { store, project } = await setup();
    const list = await listContexts(store, { project_id: project.id });
    expect(list.map((c) => c.name.replace(/ \(.*\)$/, ""))).toEqual(["Cursor: Login page wiring", "Claude Code: Auth refactor: middleware done"]);
    expect(list[1]!.uri).toMatch(/^claude-code:\/\/auth-refactor-middleware-done-[0-9a-f]{8}$/);
    expect(list[1]!.description).toBe("Summary: Auth refactor: middleware done.");
    expect((await listContexts(store, { project_id: project.id, query: "claude auth" })).map((c) => c.tool)).toEqual(["Claude Code"]);
  });

  it("reads a session by its @ uri as the current view: a claim that went OUT since shows with why", async () => {
    const { store, project } = await setup();
    const [cc] = await listContexts(store, { project_id: project.id, query: "claude" });
    const testsClaim = [...store.claims.values()].find((c) => c.text === "All tests pass on main")!;
    await callTool(store, "resolve_review", { claim_id: testsClaim.id, action: "confirm_out", note: "CI is red" }, { model: null });

    const out = await readContext(store, { uri: cc!.uri });
    expect(out.name).toMatch(/^Claude Code: Auth refactor: middleware done/);
    expect(out.markdown).toContain("## What happened");
    expect(out.markdown).toContain("## No longer true\n\n- [status] All tests pass on main. Went OUT because you confirmed it is no longer true (note: CI is red).");
    await expect(readContext(store, { uri: "cursor://nothing-deadbeef" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("works through the tools any MCP client calls: find_context then get_context", async () => {
    const { store } = await setup();
    const found: any = await callTool(store, "find_context", { query: "cursor login" }, { model: null });
    expect(found.contexts[0].title).toBe("Login page wiring");
    const got: any = await callTool(store, "get_context", { uri: found.contexts[0].uri }, { model: null });
    expect(got.markdown).toContain("## Still true\n\n- [next step] Login page ships Friday");
    await expect(callTool(store, "get_context", {}, { model: null })).rejects.toMatchObject({ code: "bad_input" });
  });
});

describe("contexts: email threads", () => {
  it("shows a thread only if it matters (a current claim waits on it), never a newsletter", async () => {
    const { store, project } = await setup();
    const email = (thread: string, summary: string) =>
      callTool(store, "record_event", { kind: "email_received", source: { kind: "gmail_thread", external_id: thread, title: summary }, occurred_at: new Date().toISOString(), from: "x@y.com", thread_id: thread, summary }, { model: null });
    await callTool(store, "record_claims", {
      project_id: project.id,
      source: { kind: "claude_code", external_id: "cc-2" },
      extracted_by: "t",
      claims: [{ text: "No reply from Priya on the contract", kind: "status", valid_from: "2026-10-25T00:00:00Z", reasons: [{ type: "absence", since: "2026-10-25T00:00:00Z", pattern: { event_kind: "email_received", from: "priya@x.org", thread_id: "t-contract" } }] }],
    }, { model: null });
    await email("t-contract", "Contract: looping in legal");
    await email("t-news", "This week in AI tooling");
    const titles = (await listContexts(store, { project_id: project.id })).filter((c) => c.tool === "Email").map((c) => c.title);
    expect(titles).toEqual(["Contract: looping in legal"]);
  });
});

describe("contexts: search by description", () => {
  const ranker = (pick: (user: string) => { best: string | null; alternatives: { id: string; why: string }[] }, seen: string[] = []): JsonModel => ({
    async json(opts) {
      if (opts.schemaName !== "search") throw new Error("unexpected call");
      seen.push(opts.user);
      return opts.parse.parse({ ...pick(opts.user), why: "fits" }) as never;
    },
  });
  const idOf = (user: string, title: string) => new RegExp(`\\[([^\\]]+)\\][^\\n]*\\n  title: ${title}`).exec(user)![1]!;

  it("returns the model's best match first, then alternatives, from the user's words as typed", async () => {
    const { store } = await setup();
    const seen: string[] = [];
    const model = ranker((u) => ({ best: idOf(u, "Login page wiring"), alternatives: [{ id: idOf(u, "Auth refactor: middleware done"), why: "same feature" }] }), seen);
    const found: any = await callTool(store, "find_context", { query: "the login work from cursor yesterday" }, { model });
    expect(found.contexts.map((c: any) => [c.title, c.why])).toEqual([["Login page wiring", "fits"], ["Auth refactor: middleware done", "same feature"]]);
    expect(seen[0]).toContain("Request: the login work from cursor yesterday");
    expect(seen[0]).toContain("said: Login page ships Friday");
  });

  it("returns nothing when the model finds no match, and drops ids it made up", async () => {
    const { store } = await setup();
    const none: any = await callTool(store, "find_context", { query: "my tax return" }, { model: ranker(() => ({ best: null, alternatives: [] })) });
    expect(none.contexts).toEqual([]);
    const near: any = await callTool(store, "find_context", { query: "login work in claude code" }, { model: ranker((u) => ({ best: null, alternatives: [{ id: idOf(u, "Login page wiring"), why: "it's in Cursor" }] })) });
    expect(near.contexts.map((c: any) => c.why)).toEqual(["Not a clear match: it's in Cursor"]);
    const madeUp: any = await callTool(store, "find_context", { query: "x" }, { model: ranker(() => ({ best: "not-a-real-id", alternatives: [] })) });
    expect(madeUp.contexts).toEqual([]);
  });

  it("falls back to keyword matching when the model call fails", async () => {
    const { store } = await setup();
    const failing: JsonModel = { json: async () => { throw new Error("Meta API 503"); } };
    const found: any = await callTool(store, "find_context", { query: "cursor login" }, { model: failing });
    expect(found.contexts[0].title).toBe("Login page wiring"); // the most shared words first
    expect(found.contexts[0].why).toMatch(/^Basic search: shares 2 word/);
  });
});

describe("ingest: index mode", () => {
  const indexer = (out: { title: string; summary: string; personal: boolean }, seen: string[] = []): JsonModel => ({
    async json(opts) {
      seen.push(opts.schemaName);
      if (opts.schemaName === "index") return opts.parse.parse(out) as never;
      throw new Error(`unexpected call ${opts.schemaName}`);
    },
  });

  it("writes a title and summary only, labels personal chats, and makes them searchable", async () => {
    const { store, project } = await setup();
    const seen: string[] = [];
    const out = await ingest(store, indexer({ title: "Push pull legs plan", summary: "A 6-day gym split with Sunday off.", personal: true }, seen), {
      index_only: true,
      source: { kind: "claude_chat", external_id: "chat-gym", title: "Claude chat" },
      text: "User: help me plan a gym week...",
    });
    expect(seen).toEqual(["index"]); // one call: no extraction, no model check
    expect(out.indexed_only).toBe(true);
    expect(out.claims).toEqual([]);
    const source = [...(store as any).sources].find((s: any) => s.external_id === "chat-gym");
    expect(source).toMatchObject({ title: "Push pull legs plan", label: "personal" });
    expect(source.project_id).toBeUndefined();

    const found = await listContexts(store, { query: "gym split" });
    expect(found.map((c) => c.title)).toEqual(["Push pull legs plan"]);
    expect((await listContexts(store, { project_id: project.id })).map((c) => c.title)).not.toContain("Push pull legs plan");
  });

  it("places an indexed session in its project, and the caller's label and title win", async () => {
    const { store, project } = await setup();
    await ingest(store, indexer({ title: "Generated", summary: "Wired the export watcher.", personal: false }), {
      index_only: true,
      project_id: project.id,
      source: { kind: "cursor", external_id: "conv-idx", title: "Export watcher", label: "personal" },
      text: "Wired the export watcher.",
    });
    const [entry] = (await listContexts(store, { project_id: project.id })).filter((c) => c.title === "Export watcher");
    expect(entry).toMatchObject({ project_id: project.id });
    expect([...(store as any).sources].find((s: any) => s.external_id === "conv-idx").label).toBe("personal");
  });

  it("lists a Muse Code session as its own tool, found by 'muse' but not by 'claude code'", async () => {
    const { store } = await setup();
    await ingest(store, indexer({ title: "Local sync dry run", summary: "Counted sessions per tool without sending.", personal: false }), {
      index_only: true,
      source: { kind: "muse_code", external_id: "01a17ffd-6774-7081-a842-0c78829944ff", title: "Muse Code session" },
      text: "User: dry run the sync",
    });
    const [entry] = await listContexts(store, { query: "muse sync" });
    expect(entry).toMatchObject({ tool: "Muse Code", title: "Local sync dry run" });
    expect(entry!.uri).toMatch(/^muse-code:\/\/local-sync-dry-run-[0-9a-f]{8}$/);
    expect(await listContexts(store, { query: "claude code sync" })).toEqual([]);
  });

  it("saves nothing when indexing fails, and full mode still needs a project", async () => {
    const { store } = await setup();
    const failing: JsonModel = { json: async () => { throw new Error("Meta API 503"); } };
    await expect(ingest(store, failing, { index_only: true, source: { kind: "cursor", external_id: "conv-fail" }, text: "x" })).rejects.toMatchObject({ code: "unavailable" });
    expect([...(store as any).sources].some((s: any) => s.external_id === "conv-fail")).toBe(false);
    await expect(ingest(store, failing, { source: { kind: "cursor", external_id: "conv-np" }, text: "x" })).rejects.toMatchObject({ code: "bad_input" });
  });
});

describe("recent_work", () => {
  it("lists this week's sessions for a tool, not older ones or email", async () => {
    const { store, project } = await setup();
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await ingest(store, model(extraction("Old cursor work")), { project_id: project.id, source: { kind: "cursor", external_id: "conv-old" }, text: "old", at: old });
    const week: any = await callTool(store, "recent_work", { tool: "claude code" }, { model: null });
    expect(week.sessions.map((s: any) => s.title)).toEqual(["Auth refactor: middleware done"]);
    expect(week.total).toBe(1);
    const limited: any = await callTool(store, "recent_work", { days: 365, limit: 1 }, { model: null });
    expect([limited.sessions.length, limited.total > 1]).toEqual([1, true]);
    const cursor: any = await callTool(store, "recent_work", { tool: "Cursor", project_id: project.id }, { model: null });
    expect(cursor.sessions.map((s: any) => s.title)).toEqual(["Login page wiring"]); // the 20-day-old one is left out
  });
});
