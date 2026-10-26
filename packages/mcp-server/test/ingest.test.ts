import { describe, expect, it } from "vitest";
import type { JsonModel } from "@plumb/core";
import { callTool, ingest, knownThreads, MemoryStore } from "../src/tools/index.js";

const r = (x: Record<string, unknown>) => ({
  type: "absence",
  event_kind: null,
  from: null,
  thread_id: null,
  text_hint: null,
  since: null,
  at: null,
  claim_ref: null,
  ...x,
});

function fakeModel(output: unknown): JsonModel & { user?: string } {
  const model: JsonModel & { user?: string } = {
    async json(opts) {
      model.user = opts.user;
      return opts.parse.parse(output) as never;
    },
  };
  return model;
}

describe("ingest", () => {
  it("extracts with known threads, records claims, and lets a real reply break them", async () => {
    const store = new MemoryStore();
    const project = store.addProject("Meta hackathon");
    // An earlier email in the thread, so extraction knows its id and sender.
    await callTool(store, "record_event", {
      kind: "email_received",
      source: { kind: "gmail_thread", external_id: "t-loi", title: "LOI" },
      occurred_at: new Date(Date.now() - 86_400_000).toISOString(),
      from: "Avery Hart <avery@northfield.edu>",
      thread_id: "t-loi",
      summary: "LOI: sending it over",
    });

    const model = fakeModel({
      claims: [
        {
          ref: "n1",
          text: "No reply from Avery about the LOI yet.",
          kind: "status",
          valid_from: null,
          confidence: 0.9,
          same_as: null,
          reasons: [r({ event_kind: "email_received", from: "avery@northfield.edu", thread_id: "t-loi" })],
        },
        {
          ref: "n2",
          text: "Follow up with Avery on Friday.",
          kind: "next_step",
          valid_from: null,
          confidence: 0.8,
          same_as: null,
          reasons: [r({ type: "depends_on", claim_ref: "n1" })],
        },
      ],
      contradicts: [],
    });
    const out = await ingest(store, model, {
      project_id: project.id,
      source: { kind: "claude_code", external_id: "s1", title: "Session" },
      text: "Still no word from Avery on the LOI. I'll follow up Friday.",
    });

    expect(model.user).toContain('thread_id t-loi: "LOI: sending it over" with avery@northfield.edu');
    expect(out.claims).toHaveLength(2);
    expect(out.extracted_by).toBe("muse-spark-1.3/extract.v1");
    expect(out.dropped).toEqual([]);

    const reply: any = await callTool(store, "record_event", {
      kind: "email_received",
      source: { kind: "gmail_thread", external_id: "t-loi" },
      occurred_at: new Date().toISOString(),
      from: "avery@northfield.edu",
      thread_id: "t-loi",
      summary: "Re: LOI",
    });
    expect(reply.transitions).toHaveLength(2);
  });

  it("sends contradicted claims to REVIEW, never OUT, and records nothing when nothing is new", async () => {
    const store = new MemoryStore();
    const project = store.addProject("p");
    const recorded: any = await callTool(store, "record_claims", {
      project_id: project.id,
      source: { kind: "claude_code", external_id: "s0" },
      extracted_by: "t",
      claims: [{ text: "All tests pass", kind: "status", valid_from: "2026-10-26T00:00:00Z", reasons: [{ type: "until", at: "2027-01-01T00:00:00Z" }] }],
    });
    const id = recorded.claims[0].id;

    const out = await ingest(store, fakeModel({ claims: [], contradicts: [{ ref: "c1", quote: "the build broke on main." }] }), {
      project_id: project.id,
      source: { kind: "cursor", external_id: "s2", title: "Cursor session" },
      text: "Heads up: the build broke on main.",
    });
    expect(out.claims).toEqual([]);
    expect(out.review).toHaveLength(1);
    expect(out.review[0]!.explanation).toBe('Sent to REVIEW because "Cursor session" said: "the build broke on main".');
    expect(store.claims.get(id)!.status).toBe("REVIEW");
  });

  it("keeps the end of very long text and says so", async () => {
    const store = new MemoryStore();
    const project = store.addProject("p");
    const model = fakeModel({ claims: [], contradicts: [] });
    const out = await ingest(store, model, {
      project_id: project.id,
      source: { kind: "claude_code", external_id: "s3" },
      text: "a".repeat(250_000) + "THE END",
    });
    expect(out.truncated).toBe(true);
    expect(model.user).toContain("THE END");
  });
});

describe("knownThreads", () => {
  it("lists threads newest first with distinct senders, and leaves out Usman's sent mail", () => {
    const e = (thread_id: string, kind: string, from: string, at: string, summary = "s") =>
      ({ id: at, kind, source_id: "x", occurred_at: at, observed_at: at, from, thread_id, summary }) as any;
    const threads = knownThreads([
      e("a", "email_received", "X <x@a.com>", "2026-10-20T00:00:00Z", "old subject"),
      e("a", "email_received", "x@a.com", "2026-10-22T00:00:00Z", "new subject"),
      e("a", "email_sent", "usman@me.com", "2026-10-21T00:00:00Z"),
      e("b", "email_received", "y@b.com", "2026-10-25T00:00:00Z"),
    ]);
    expect(threads).toEqual([
      { thread_id: "b", subject: "s", participants: ["y@b.com"] },
      { thread_id: "a", subject: "new subject", participants: ["x@a.com"] },
    ]);
  });
});
