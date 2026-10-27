import { describe, expect, it } from "vitest";
import {
  DUPLICATE_PREFIX,
  findDuplicates,
  hintOnlyClaims,
  materializeClaims,
  recheckClaims,
  type BrainState,
  type Event,
  type JsonModel,
  type NewClaim,
} from "../src/index.js";

let n = 0;
const newId = () => `id${++n}`;

function state(claims: (NewClaim & { temp_id: string })[]) {
  const m = materializeClaims({
    project_id: "p",
    source_id: "s",
    extracted_by: "t",
    recorded_at: "2026-10-25T00:00:00Z",
    claims,
    existing: new Map(),
    newId,
  });
  const s: BrainState = { claims: new Map(m.claims.map((c) => [c.id, c])), reasons: m.reasons, events: [], transitions: [] };
  return { s, id: (k: string) => m.id_map[k]! };
}

const hint = (text_hint: string) => ({
  type: "absence" as const,
  since: "2026-10-25T00:00:00Z",
  pattern: { event_kind: "doc_edited" as const, text_hint },
});
const coded = { type: "absence" as const, since: "2026-10-25T00:00:00Z", pattern: { event_kind: "email_received" as const, from: "a@x.com" } };
const until = { type: "until" as const, at: "2027-01-01T00:00:00Z" };
const c = (temp_id: string, text: string, reasons: NewClaim["reasons"], valid_from = "2026-10-25T00:00:00Z") => ({
  temp_id,
  text,
  kind: "decision" as const,
  valid_from,
  reasons,
});
const ev = (summary: string, occurred_at = "2026-10-27T10:00:00Z"): Event => ({
  id: newId(),
  kind: "email_received",
  source_id: "gmail",
  occurred_at,
  observed_at: occurred_at,
  from: "Theo Grant <theo@ourteam.io>",
  thread_id: "t-db",
  summary,
});

describe("hintOnlyClaims", () => {
  it("picks claims whose every absence is a text_hint", () => {
    const { s, id } = state([
      c("storage", "We use Supabase for storage.", [hint("storage moved off Supabase")]),
      c("mixed", "No reply from A.", [coded, hint("A answered elsewhere")]),
      c("deadline", "Ship by Friday.", [until]),
    ]);
    expect(hintOnlyClaims(s).map((x) => x.id)).toEqual([id("storage")]);
  });
});

describe("recheckClaims", () => {
  it("shows each claim only newer events, flags yes with a checked quote, and skips claims with nothing new", async () => {
    const { s, id } = state([
      c("storage", "We use Supabase for storage.", [hint("storage moved off Supabase")]),
      c("later", "The venue is the Hallway space.", [hint("venue changed")], "2026-10-28T00:00:00Z"),
    ]);
    const old = ev("Supabase invoice for September", "2026-10-24T09:00:00Z");
    const move = ev("Heads up: moving the database to Neon next week");
    let seen = "";
    let calls = 0;
    const model: JsonModel = {
      async json(opts) {
        calls++;
        seen = opts.user;
        return opts.parse.parse({ verdict: "yes", event: 1, quote: "moving the database to Neon", why: "Switching." }) as never;
      },
    };
    const out = await recheckClaims(model, s, [old, move]);
    expect(calls).toBe(1); // "later" was written after both events
    expect(out.checked).toBe(1);
    expect(seen).not.toContain("September");
    expect(seen).toContain("News that would break it: storage moved off Supabase");
    expect(out.flags).toEqual([
      {
        claim_id: id("storage"),
        event_id: move.id,
        explanation: expect.stringMatching(/^Sent to REVIEW because the background check of an email from Theo Grant .* says this is no longer true: "moving the database to Neon"\.$/),
      },
    ]);
  });

  it("treats no, a bad event number, and a failed call as nothing to flag", async () => {
    const { s } = state([c("a", "A.", [hint("a")]), c("b", "B.", [hint("b")]), c("d", "D.", [hint("d")])]);
    const answers = [
      { verdict: "no", event: null, quote: null, why: "" },
      { verdict: "yes", event: 7, quote: "x", why: "" },
    ];
    let i = 0;
    const model: JsonModel = {
      async json(opts) {
        const a = answers[i++];
        if (!a) throw new Error("timeout");
        return opts.parse.parse(a) as never;
      },
    };
    expect((await recheckClaims(model, s, [ev("something")])).flags).toEqual([]);
  });
});

describe("findDuplicates", () => {
  const dupModel = (groups: string[][]): JsonModel => ({
    async json(opts) {
      return opts.parse.parse({ groups: groups.map((refs) => ({ refs, why: "same" })) }) as never;
    },
  });

  it("keeps the oldest claim and flags the newer repeat", async () => {
    const { s, id } = state([
      c("new", "The demo venue is Hallway.", [until], "2026-10-26T00:00:00Z"),
      c("old", "Demo day is at the Hallway space.", [until], "2026-10-24T00:00:00Z"),
    ]);
    // Refs follow age, oldest first: c1 is "old", c2 is "new".
    const flags = await findDuplicates(dupModel([["c2", "c1", "c9"]]), s);
    expect(flags).toEqual([{ claim_id: id("new"), explanation: `${DUPLICATE_PREFIX} "Demo day is at the Hallway space"; confirm OUT to keep just one.` }]);
  });

  it("never flags a claim others depend on, or one Usman already saw flagged as a repeat", async () => {
    const { s, id } = state([
      c("old", "X is true.", [until], "2026-10-20T00:00:00Z"),
      c("dep_target", "X holds.", [until], "2026-10-21T00:00:00Z"),
      c("child", "Do Y.", [{ type: "depends_on", claim: "dep_target" }], "2026-10-22T00:00:00Z"),
      c("seen", "X is still true.", [until], "2026-10-23T00:00:00Z"),
    ]);
    s.transitions.push({ id: "t", claim_id: id("seen"), from_status: "IN", to_status: "REVIEW", depth: 0, explanation: `${DUPLICATE_PREFIX} "X is true"; confirm OUT to keep just one.`, at: "2026-10-24T00:00:00Z" });
    expect(await findDuplicates(dupModel([["c1", "c2", "c4"]]), s)).toEqual([]);
  });
});
