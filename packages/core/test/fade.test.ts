import { describe, expect, it } from "vitest";
import { fadeReviews, type BrainState, type Claim, type Transition } from "../src/index.js";

const now = "2026-11-10T12:00:00Z";
const claim = (id: string, status: Claim["status"]): Claim => ({ id, project_id: "p", text: id, kind: "status", status, source_id: "s", valid_from: "2026-10-01T00:00:00Z", recorded_at: "2026-10-01T00:00:00Z", extracted_by: "t" });
const toReview = (claim_id: string, at: string): Transition => ({ id: `t-${claim_id}-${at}`, claim_id, from_status: "IN", to_status: "REVIEW", depth: 0, explanation: "maybe", at });

describe("REVIEW fades", () => {
  it("moves a REVIEW nothing confirmed for 7 days back IN, with why; a recent one stays", () => {
    const state: BrainState = {
      claims: new Map([
        ["old", claim("old", "REVIEW")],
        ["recent", claim("recent", "REVIEW")],
        ["reflagged", claim("reflagged", "REVIEW")],
        ["out", claim("out", "OUT")],
      ]),
      reasons: [],
      events: [],
      transitions: [toReview("old", "2026-11-02T12:00:00Z"), toReview("recent", "2026-11-08T12:00:00Z"), toReview("reflagged", "2026-10-20T00:00:00Z"), toReview("reflagged", "2026-11-09T00:00:00Z")],
    };
    let n = 0;
    const changes = fadeReviews(state, { now, newId: () => `id${n++}` });
    expect(changes.map((c) => [c.claim.id, c.claim.status, c.transition.from_status, c.transition.explanation])).toEqual([
      ["old", "IN", "REVIEW", "Back IN: nothing confirmed the change within 7 days."],
    ]);
  });
});
