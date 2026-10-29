import { describe, expect, it } from "vitest";
import { renderProjectState, type Claim, type ClaimKind, type Transition } from "../src/index.js";

const at = "2026-10-27T14:00:00Z";
const claim = (id: string, text: string, kind: ClaimKind, status: Claim["status"] = "IN"): Claim => ({
  id,
  project_id: "p",
  text,
  kind,
  status,
  source_id: "s",
  valid_from: at,
  recorded_at: at,
  extracted_by: "t",
});
const tr = (claim_id: string, to: Transition["to_status"], explanation: string, extra: Partial<Transition> = {}): Transition => ({
  id: `t-${claim_id}`,
  claim_id,
  from_status: "IN",
  to_status: to,
  depth: 0,
  explanation,
  at,
  ...extra,
});
const empty = { goal: [], decision: [], status: [], next_step: [], open_question: [], fact: [] };
const opts = { since: "2026-10-26T14:00:00Z", now: at };

describe("renderProjectState", () => {
  it("lists what changed, nesting chain falls under their cause, then IN claims by kind in homepage order", () => {
    const md = renderProjectState(
      {
        project: { id: "p", name: "Meta hackathon", created_at: at },
        in_claims: {
          ...empty,
          fact: [claim("f", "Demo day is Nov 4.", "fact")],
          goal: [claim("g", "Ship Plumb for the Meta hackathon.", "goal")],
        },
        changed_since: [
          { claim: claim("b", "Follow up with Avery Friday.", "next_step", "OUT"), transition: tr("b", "OUT", 'Went OUT because it depends on "No reply from Avery", which went OUT.', { depth: 1, cause_claim_id: "a" }) },
          { claim: claim("a", "No reply from Avery", "status", "OUT"), transition: tr("a", "OUT", "Went OUT because an email from avery@x.edu arrived.") },
          { claim: claim("r", "We use Supabase.", "decision", "REVIEW"), transition: tr("r", "REVIEW", 'Sent to REVIEW because the background check says: "moving to Neon".') },
        ],
      },
      opts,
    );
    expect(md).toBe(
      [
        "# Project state: Meta hackathon",
        "",
        "Written by Plumb at Oct 27, 10:00 AM EDT. Don't edit this file: it is rewritten at the start of each session.",
        "",
        "## Changed since Oct 26, 10:00 AM EDT",
        "",
        "- OUT: No reply from Avery. Went OUT because an email from avery@x.edu arrived.",
        '  - OUT: Follow up with Avery Friday. Went OUT because it depends on "No reply from Avery", which went OUT.',
        '- May be out of date: We use Supabase. Sent to REVIEW because the background check says: "moving to Neon".',
        "",
        "## Goals",
        "",
        "- Ship Plumb for the Meta hackathon.",
        "",
        "## Facts",
        "",
        "- Demo day is Nov 4.",
        "",
      ].join("\n"),
    );
    expect(md).not.toMatch(/—/); // no em dashes in anything Usman reads
  });

  it("says so when nothing changed and there are no claims", () => {
    const md = renderProjectState({ project: { id: "p", name: "New", created_at: at }, in_claims: empty, changed_since: [] }, opts);
    expect(md).toContain("Nothing went OUT or to REVIEW.");
    expect(md).toContain("## Current claims\n\nNone yet.");
  });
});
