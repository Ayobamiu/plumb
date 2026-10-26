import { describe, expect, it } from "vitest";
import {
  confirmOut,
  evaluateClaims,
  materializeClaims,
  onEvent,
  restore,
  sendToReview,
  type BrainState,
  type Event,
  type NewClaim,
} from "../src/index.js";

let n = 0;
const newId = () => `id${++n}`;
const NOW = "2026-10-27T12:00:00Z";
const ctx = { now: NOW, newId };

function setup(claims: (NewClaim & { temp_id: string })[]) {
  const m = materializeClaims({
    project_id: "p",
    source_id: "s",
    extracted_by: "test",
    recorded_at: "2026-10-25T00:00:00Z",
    claims,
    existing: new Map(),
    newId,
  });
  const state: BrainState = { claims: new Map(m.claims.map((c) => [c.id, c])), reasons: m.reasons, events: [], transitions: [] };
  const status = (k: string) => state.claims.get(m.id_map[k]!)!.status;
  return { state, id: (k: string) => m.id_map[k]!, status };
}

const absence = (thread: string) => ({
  type: "absence" as const,
  since: "2026-10-25T00:00:00Z",
  pattern: { event_kind: "email_received" as const, from: "a@x.com", thread_id: thread },
});
const dep = (claim: string) => ({ type: "depends_on" as const, claim });
const claim = (temp_id: string, reasons: NewClaim["reasons"]) => ({
  temp_id,
  text: `claim ${temp_id}`,
  kind: "status" as const,
  valid_from: "2026-10-25T00:00:00Z",
  reasons,
});
const email = (thread: string, at = "2026-10-26T06:01:00Z"): Event => ({
  id: newId(),
  kind: "email_received",
  source_id: "gmail",
  occurred_at: at,
  observed_at: at,
  from: "a@x.com",
  thread_id: thread,
  summary: "Re: hello",
});

describe("onEvent", () => {
  it("writes one transition per change with depth, cause and a template sentence", () => {
    const { state, id } = setup([claim("a", [absence("t1")]), claim("b", [dep("a")]), claim("c", [dep("b")])]);
    const e = email("t1");
    const changes = onEvent(state, e, ctx);

    expect(changes.map((c) => [c.claim.id, c.transition.depth, c.transition.cause_claim_id])).toEqual([
      [id("a"), 0, undefined],
      [id("b"), 1, id("a")],
      [id("c"), 2, id("b")],
    ]);
    const root = changes[0]!;
    expect(root.transition.event_id).toBe(e.id);
    expect(root.claim.valid_to).toBe(e.occurred_at);
    expect(root.claim.retracted_at).toBe(NOW);
    expect(root.transition.explanation).toMatch(/^Went OUT because an email from a@x.com arrived in thread t1 at Oct 26/);
    expect(changes[1]!.transition.explanation).toBe('Went OUT because it depends on "claim a", which went OUT.');
    expect(state.transitions).toHaveLength(3);
  });

  it("stops on dependency loops", () => {
    const { state, status } = setup([claim("a", [absence("t1"), dep("b")]), claim("b", [dep("a")])]);
    const changes = onEvent(state, email("t1"), ctx);
    expect(changes).toHaveLength(2);
    expect([status("a"), status("b")]).toEqual(["OUT", "OUT"]);
  });

  it("does not knock down dependents of a REVIEW claim", () => {
    const { state, id, status } = setup([claim("a", [absence("t1")]), claim("b", [dep("a")])]);
    sendToReview(state, id("a"), ctx, { explanation: "Model check: unsure." });
    expect([status("a"), status("b")]).toEqual(["REVIEW", "IN"]);

    confirmOut(state, id("a"), ctx);
    expect([status("a"), status("b")]).toEqual(["OUT", "OUT"]);
  });
});

describe("evaluateClaims", () => {
  it("marks a just-recorded claim OUT when a stored event already broke it", () => {
    const { state, id, status } = setup([claim("a", [absence("t1")]), claim("b", [dep("a")])]);
    state.events.push(email("t1"));
    evaluateClaims(state, [id("a"), id("b")], ctx);
    expect([status("a"), status("b")]).toEqual(["OUT", "OUT"]);
  });
});

describe("restore", () => {
  it("brings back dependents knocked down only by the restored claim", () => {
    const { state, id, status } = setup([
      claim("a", [absence("t1")]),
      claim("b", [dep("a")]),
      claim("c", [dep("a"), absence("t2")]),
    ]);
    onEvent(state, email("t1"), ctx);
    onEvent(state, email("t2"), ctx); // c's own reason is broken too now
    expect([status("a"), status("b"), status("c")]).toEqual(["OUT", "OUT", "OUT"]);

    const changes = restore(state, id("a"), ctx);
    expect([status("a"), status("b"), status("c")]).toEqual(["IN", "IN", "OUT"]);
    expect(changes[1]!.transition).toMatchObject({ depth: 1, cause_claim_id: id("a"), to_status: "IN" });
    expect(state.claims.get(id("b"))!.retracted_at).toBeUndefined();
  });
});

describe("materializeClaims", () => {
  it("rejects a depends_on pointing at nothing", () => {
    expect(() => setup([claim("a", [dep("missing")])])).toThrow(/unknown claim missing/);
  });
});
