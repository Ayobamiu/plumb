import { describe, expect, it } from "vitest";
import {
  checkedQuote,
  materializeClaims,
  modelCheck,
  selectCandidates,
  senderNames,
  type BrainState,
  type Event,
  type JsonModel,
  type NewClaim,
} from "../src/index.js";

let n = 0;
const newId = () => `id${++n}`;
const since = "2026-10-25T00:00:00Z";

function state(claims: (NewClaim & { temp_id: string })[]) {
  const m = materializeClaims({
    project_id: "p",
    source_id: "doc-1",
    extracted_by: "t",
    recorded_at: since,
    claims,
    existing: new Map(),
    newId,
  });
  const s: BrainState = { claims: new Map(m.claims.map((c) => [c.id, c])), reasons: m.reasons, events: [], transitions: [] };
  return { s, id: (k: string) => m.id_map[k]! };
}

const c = (temp_id: string, text: string, reasons: NewClaim["reasons"]) => ({ temp_id, text, kind: "status" as const, valid_from: since, reasons });
const absence = (pattern: Record<string, string>) => ({
  type: "absence" as const,
  since,
  pattern: { event_kind: "email_received" as const, ...pattern },
});
const until = { type: "until" as const, at: "2027-01-01T00:00:00Z" };

const email = (from: string, summary: string, thread_id = "t-new"): Event => ({
  id: newId(),
  kind: "email_received",
  source_id: "gmail",
  occurred_at: "2026-10-27T10:00:00Z",
  observed_at: "2026-10-27T10:00:00Z",
  from,
  thread_id,
  summary,
});

describe("senderNames", () => {
  it("reads names from the display name and the address", () => {
    expect(senderNames("Matt Jones <mj@new-co.com>")).toEqual(expect.arrayContaining(["matt", "jones"]));
    expect(senderNames("matt.jones@x.com")).toEqual(["matt", "jones"]);
  });
});

describe("selectCandidates", () => {
  const { s, id } = state([
    c("matt", "Matt is unresponsive about the contract.", [absence({ from: "matt@old-co.com", thread_id: "t-contract" })]),
    c("lunch", "Lunch with the team is on Thursday.", [until]),
    c("venue", "The venue for demo day is the Hallway space.", [absence({ text_hint: "demo day venue changed" })]),
  ]);

  it("picks a claim naming the sender, even from a new address and thread", () => {
    const got = selectCandidates(s, email("Matt Jones <matt@new-co.com>", "Contract: signed copy attached"));
    expect(got.map((x) => x.claim.id)).toEqual([id("matt")]);
    expect(got[0]!.signals.join()).toMatch(/sender named in claim/);
  });

  it("picks a text_hint claim when the event shares its words", () => {
    const got = selectCandidates(s, email("events@hallway.io", "Demo day venue moved to the Annex"));
    expect(got.map((x) => x.claim.id)).toEqual([id("venue")]);
  });

  it("skips unrelated email, clock ticks, and claims that are not IN", () => {
    expect(selectCandidates(s, email("news@example.com", "Weekly newsletter"))).toEqual([]);
    expect(selectCandidates(s, { ...email("matt@new-co.com", "x"), kind: "clock" })).toEqual([]);
    s.claims.set(id("matt"), { ...s.claims.get(id("matt"))!, status: "REVIEW" });
    expect(selectCandidates(s, email("Matt Jones <matt@new-co.com>", "Contract"))).toEqual([]);
  });
});

describe("checkedQuote", () => {
  const e = email("a@x.com", "Re: LOI   we are in, signed today");
  it("keeps a real quote, ignoring case and spacing", () => {
    expect(checkedQuote("We are in, signed", e)).toBe("We are in, signed");
  });
  it("falls back to the event text when the model's quote isn't in the event", () => {
    expect(checkedQuote("they said no", e)).toBe(e.summary);
    expect(checkedQuote(null, e)).toBe(e.summary);
  });
});

describe("modelCheck", () => {
  const { s, id } = state([
    c("a", "No reply from Matt about the contract yet.", [until]),
    c("b", "Matt prefers calls on Mondays.", [until]),
    c("d", "Matt owes us the signed contract.", [until]),
  ]);
  const event = email("Matt Jones <matt@new.com>", "Contract: signed copy attached");
  const verdicts: Record<string, unknown> = {
    [id("a")]: { verdict: "yes", quote: "signed copy attached", why: "He replied." },
    [id("b")]: { verdict: "no", quote: null, why: "Unrelated." },
  };
  const model: JsonModel = {
    async json(opts) {
      const claimId = [...s.claims.values()].find((cl) => opts.user.includes(cl.text))!.id;
      if (!(claimId in verdicts)) throw new Error("timeout");
      return opts.parse.parse(verdicts[claimId]) as never;
    },
  };

  it("flags yes and unsure only, with a checked quote and a template sentence; failures count as no", async () => {
    const candidates = [...s.claims.values()].map((claim) => ({ claim, score: 2, signals: [] }));
    const out = await modelCheck(model, event, candidates);
    expect(out.flags).toHaveLength(1);
    expect(out.flags[0]).toMatchObject({ claim_id: id("a"), event_id: event.id, verdict: "yes", quote: "signed copy attached" });
    expect(out.flags[0]!.explanation).toMatch(
      /^Sent to REVIEW because a model check of an email from Matt Jones <matt@new.com> at Oct 27, 6:00 AM EDT says this is no longer true: "signed copy attached"\.$/,
    );
    expect(out.checked.map((x) => x.verdict)).toEqual(["yes", "no", "error"]);
  });
});
