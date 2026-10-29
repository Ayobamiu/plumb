import { describe, expect, it } from "vitest";
import { callTool, ConflictError, MemoryStore, ToolError, type Store } from "../src/tools/index.js";

const gmail = { kind: "gmail_thread" as const, external_id: "t1", title: "LOI" };
const session = { kind: "claude_code" as const, external_id: "s1" };
const since = "2026-10-25T00:00:00Z";

function setup() {
  const store = new MemoryStore();
  const project = store.addProject("Meta hackathon");
  const call = (name: string, input: unknown) => callTool(store, name, input, { model: null }) as Promise<any>;
  const status = (id: string) => store.claims.get(id)!.status;
  return { store, project, call, status };
}

async function seed(call: ReturnType<typeof setup>["call"], project_id: string) {
  const out = await call("record_claims", {
    project_id,
    source: session,
    extracted_by: "test",
    claims: [
      {
        temp_id: "noreply",
        text: "No reply from Avery yet",
        kind: "status",
        valid_from: since,
        reasons: [{ type: "absence", since, pattern: { event_kind: "email_received", from: "avery@example.edu", thread_id: "t1" } }],
      },
      { temp_id: "followup", text: "Follow up with Avery Friday", kind: "next_step", valid_from: since, reasons: [{ type: "depends_on", claim: "noreply" }] },
      { temp_id: "draft", text: "Draft the follow-up email", kind: "next_step", valid_from: since, reasons: [{ type: "depends_on", claim: "followup" }] },
    ],
  });
  return out.id_map as Record<string, string>;
}

const reply = (at = "2026-10-26T10:01:00Z") => ({
  kind: "email_received",
  source: gmail,
  occurred_at: at,
  from: "Avery Hart <Avery@Example.edu>",
  thread_id: "t1",
  summary: "Re: LOI",
});

describe("record_claims", () => {
  it("rejects a claim with no reason", async () => {
    const { project, call } = setup();
    const bad = { project_id: project.id, source: session, extracted_by: "t", claims: [{ text: "x", kind: "fact", valid_from: since, reasons: [] }] };
    await expect(call("record_claims", bad)).rejects.toMatchObject({ code: "bad_input" });
  });

  it("rejects an unknown project and a dangling depends_on", async () => {
    const { project, call } = setup();
    const claim = { text: "x", kind: "fact", valid_from: since, reasons: [{ type: "depends_on", claim: "nope" }] };
    await expect(call("record_claims", { project_id: "nope", source: session, extracted_by: "t", claims: [claim] })).rejects.toBeInstanceOf(ToolError);
    await expect(call("record_claims", { project_id: project.id, source: session, extracted_by: "t", claims: [claim] })).rejects.toMatchObject({ code: "bad_input" });
  });

  it("marks a new claim OUT right away if a stored event already broke it", async () => {
    const { project, call, status } = setup();
    await call("record_event", reply());
    const ids = await seed(call, project.id);
    expect(status(ids.noreply!)).toBe("OUT");
    expect(status(ids.draft!)).toBe("OUT");
  });
});

describe("record_event", () => {
  it("breaks the absence and runs the chain, writing everything", async () => {
    const { store, project, call, status } = setup();
    const ids = await seed(call, project.id);
    const out = await call("record_event", reply());
    expect(out.transitions.map((t: any) => t.depth)).toEqual([0, 1, 2]);
    expect(out.transitions[0].explanation).toMatch(/avery@example\.edu/i);
    expect([ids.noreply, ids.followup, ids.draft].map((id) => status(id!))).toEqual(["OUT", "OUT", "OUT"]);
    expect(store.events).toHaveLength(1);
    expect(store.transitions).toHaveLength(3);
  });

  it("leaves a thread-scoped claim alone when the sender writes in another thread", async () => {
    const { project, call, status } = setup();
    const ids = await seed(call, project.id);
    const out = await call("record_event", { ...reply(), thread_id: "t2" });
    expect(out.transitions).toEqual([]);
    expect(status(ids.noreply!)).toBe("IN");
  });

  it("stores clock ticks only when they change something", async () => {
    const { store, project, call, status } = setup();
    await call("record_claims", {
      project_id: project.id,
      source: session,
      extracted_by: "t",
      claims: [{ temp_id: "live", text: "Hackathon is live", kind: "status", valid_from: since, reasons: [{ type: "until", at: "2026-11-05T01:00:00Z" }] }],
    });
    const tick = (at: string) => ({ kind: "clock", source: { kind: "manual", external_id: "clock" }, occurred_at: at, summary: "tick" });
    await call("record_event", tick("2026-11-04T12:00:00Z"));
    expect(store.events).toHaveLength(0);
    const out = await call("record_event", tick("2026-11-05T01:01:00Z"));
    expect(out.transitions).toHaveLength(1);
    expect(store.events).toHaveLength(1);
    expect(status(out.transitions[0].claim_id)).toBe("OUT");
  });

  it("retries when another run changed a claim first", async () => {
    const { store, project, call } = setup();
    await seed(call, project.id);
    let fails = 1;
    const apply = store.apply.bind(store);
    store.apply = async (w) => {
      if (fails-- > 0) throw new ConflictError("raced");
      return apply(w);
    };
    const out = await call("record_event", reply());
    expect(out.transitions).toHaveLength(3);
    expect(store.events).toHaveLength(1);
  });
});

describe("get_project_state and explain_claim", () => {
  it("groups IN claims by kind and lists what changed since", async () => {
    const { project, call } = setup();
    const ids = await seed(call, project.id);
    await call("record_event", reply());
    await call("record_claims", {
      project_id: project.id,
      source: session,
      extracted_by: "t",
      claims: [{ text: "Demo is Nov 4", kind: "fact", valid_from: since, reasons: [{ type: "until", at: "2026-11-05T01:00:00Z" }] }],
    });
    const state = await call("get_project_state", { project_id: project.id, since: "2026-01-01T00:00:00Z" });
    expect(state.in_claims.fact.map((c: any) => c.text)).toEqual(["Demo is Nov 4"]);
    expect(state.in_claims.next_step).toEqual([]);
    expect(state.changed_since).toHaveLength(3);
    expect(state.changed_since.at(-1).claim.id).toBe(ids.noreply);
    expect(state.markdown).toMatch(/^# Project state: Meta hackathon\n/);
    expect(state.markdown).toContain("  - OUT: Follow up with Avery Friday. Went OUT because");
    expect(state.markdown).toContain("## Facts\n\n- Demo is Nov 4");
    // Coverage counts every project; the session above just saved.
    expect(state.coverage.find((r: any) => r.kind === session.kind)).toMatchObject({ stale: false });
    expect(state.coverage.find((r: any) => r.kind === session.kind).last_saved_at).toBeDefined();
    expect(state.markdown).toContain("## Saving from your tools (all projects)");
  });

  it("explains a claim: reasons, both directions of the chain, history", async () => {
    const { project, call } = setup();
    const ids = await seed(call, project.id);
    await call("record_event", reply());
    const out = await call("explain_claim", { claim_id: ids.followup });
    expect(out.source.kind).toBe("claude_code");
    expect(out.depends_on.map((c: any) => c.id)).toEqual([ids.noreply]);
    expect(out.dependents.map((c: any) => c.id)).toEqual([ids.draft]);
    expect(out.history).toHaveLength(1);
    await expect(call("explain_claim", { claim_id: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("resolve_review", () => {
  async function inReview() {
    const s = setup();
    const ids = await seed(s.call, s.project.id);
    // Part C does this in production; here we put the root in REVIEW by hand.
    const claim = s.store.claims.get(ids.noreply!)!;
    s.store.claims.set(claim.id, { ...claim, status: "REVIEW" });
    return { ...s, ids };
  }

  it("confirm_out runs the chain", async () => {
    const { call, ids, status } = await inReview();
    const out = await call("resolve_review", { claim_id: ids.noreply, action: "confirm_out", note: "she replied by phone" });
    expect(out.transitions).toHaveLength(3);
    expect(out.transitions[0].explanation).toMatch(/\(note: she replied by phone\)\.$/);
    expect(status(ids.draft!)).toBe("OUT");
  });

  it("restore_in brings back what the chain knocked down", async () => {
    const { call, ids, status } = await inReview();
    await call("resolve_review", { claim_id: ids.noreply, action: "confirm_out" });
    const out = await call("resolve_review", { claim_id: ids.noreply, action: "restore_in" });
    expect(out.transitions).toHaveLength(3);
    expect([ids.noreply, ids.followup, ids.draft].map((id) => status(id!))).toEqual(["IN", "IN", "IN"]);
  });

  it("edit changes the text and keeps the old text in the transition", async () => {
    const { store, call, ids } = await inReview();
    const out = await call("resolve_review", { claim_id: ids.noreply, action: "edit", text: "No written reply from Avery yet" });
    expect(store.claims.get(ids.noreply!)!.text).toBe("No written reply from Avery yet");
    expect(store.claims.get(ids.noreply!)!.status).toBe("IN");
    expect(out.transitions[0].explanation).toBe('Back IN because Usman edited it; it used to say "No reply from Avery yet".');

    const again = await call("resolve_review", { claim_id: ids.noreply, action: "edit", text: "Still no reply" });
    expect(again.transitions[0]).toMatchObject({ from_status: "IN", to_status: "IN" });
    await expect(call("resolve_review", { claim_id: ids.noreply, action: "edit" })).rejects.toMatchObject({ code: "bad_input" });
  });
});

describe("list_projects", () => {
  it("counts claims by status", async () => {
    const { project, call } = setup();
    await seed(call, project.id);
    await call("record_event", reply());
    const out = await call("list_projects", {});
    expect(out.projects[0].counts).toEqual({ IN: 0, OUT: 3, REVIEW: 0 });
  });
});

// Keep the Store interface honest: MemoryStore must satisfy it.
const _check: Store = new MemoryStore();
void _check;

describe("record_event with the Part C model check", () => {
  it("sends a claim the patterns missed to REVIEW, never OUT, and leaves its dependents IN", async () => {
    const store = new MemoryStore();
    const project = store.addProject("p");
    const seeded: any = await callTool(
      store,
      "record_claims",
      {
        project_id: project.id,
        source: { kind: "claude_code", external_id: "s1" },
        extracted_by: "t",
        claims: [
          {
            temp_id: "matt",
            text: "Matt is unresponsive about the contract.",
            kind: "status",
            valid_from: since,
            reasons: [{ type: "absence", since, pattern: { event_kind: "email_received", from: "matt@old.com", thread_id: "t-contract" } }],
          },
          { temp_id: "chase", text: "Chase Matt's boss on Monday.", kind: "next_step", valid_from: since, reasons: [{ type: "depends_on", claim: "matt" }] },
        ],
      },
      { model: null },
    );
    let calls = 0;
    const model = {
      async json(opts: any) {
        calls++;
        return opts.user.includes("unresponsive")
          ? opts.parse.parse({ verdict: "yes", quote: "signed copy attached", why: "He replied." })
          : opts.parse.parse({ verdict: "no", quote: null, why: "Still worth chasing? Not shown." });
      },
    };
    const out: any = await callTool(
      store,
      "record_event",
      { ...reply(), from: "Matt Jones <matt@new.com>", thread_id: "t-other", summary: "Contract: signed copy attached" },
      { model },
    );
    expect(calls).toBe(2); // both claims name Matt
    expect(out.transitions).toHaveLength(1);
    expect(out.transitions[0]).toMatchObject({ to_status: "REVIEW", event_id: out.event.id });
    expect(store.claims.get(seeded.id_map.matt)!.status).toBe("REVIEW");
    expect(store.claims.get(seeded.id_map.chase)!.status).toBe("IN");
  });

  it("does not call the model when Part B already handled it or nothing is related", async () => {
    const { store, project, call } = setup();
    await seed(call, project.id);
    let calls = 0;
    const model = { async json(): Promise<never> { calls++; throw new Error("should not run"); } };
    await callTool(store, "record_event", reply(), { model }); // Part B takes all three claims OUT
    await callTool(store, "record_event", { ...reply(), from: "news@example.com", thread_id: "t9", summary: "Weekly newsletter" }, { model });
    expect(calls).toBe(0);
  });
});

describe("get_project_state quiet rule", () => {
  it("moves old, unmentioned claims to quiet_claims and says so in the markdown; goals stay", async () => {
    const { store, project, call } = setup();
    const out = await call("record_claims", {
      project_id: project.id,
      source: session,
      extracted_by: "t",
      claims: [
        { temp_id: "old", text: "Pick the red or white shoes", kind: "open_question", valid_from: since, reasons: [{ type: "until", at: "2027-01-01T00:00:00Z" }] },
        { temp_id: "goal", text: "Ship Plumb", kind: "goal", valid_from: since, reasons: [{ type: "until", at: "2027-01-01T00:00:00Z" }] },
        { temp_id: "fresh", text: "Demo is Nov 4", kind: "fact", valid_from: since, reasons: [{ type: "until", at: "2027-01-01T00:00:00Z" }] },
      ],
    });
    const age = (key: string) => {
      const c = store.claims.get(out.id_map[key])!;
      store.claims.set(c.id, { ...c, recorded_at: "2026-01-01T00:00:00Z" });
    };
    age("old");
    age("goal");
    const state = await call("get_project_state", { project_id: project.id });
    expect(state.quiet_claims.map((c: any) => c.text)).toEqual(["Pick the red or white shoes"]);
    expect(state.in_claims.open_question).toEqual([]);
    expect(state.in_claims.goal.map((c: any) => c.text)).toEqual(["Ship Plumb"]);
    expect(state.markdown).toContain("1 quiet claim is not shown");
    // Jan 1 is about 300 days ago: with a 365-day setting nothing is quiet.
    const wider = await call("get_project_state", { project_id: project.id, quiet_after_days: 365 });
    expect(wider.quiet_claims).toEqual([]);
  });
});
