import { describe, expect, it } from "vitest";
import { isQuiet, lastActivity, type Claim, type ClaimKind, type Transition } from "../src/index.js";

const now = "2026-11-10T12:00:00Z";
const claim = (kind: ClaimKind, recorded_at: string, extra: Partial<Claim> = {}): Claim => ({
  id: "c",
  project_id: "p",
  text: "x",
  kind,
  status: "IN",
  source_id: "s",
  valid_from: recorded_at,
  recorded_at,
  extracted_by: "t",
  ...extra,
});
const restored: Transition = { id: "t", claim_id: "c", from_status: "REVIEW", to_status: "IN", depth: 0, explanation: "Back IN", at: "2026-11-09T12:00:00Z" };

describe("quiet rule", () => {
  it("hides an old next step nobody mentioned, but not one mentioned or changed lately", () => {
    expect(isQuiet(claim("next_step", "2026-10-28T12:00:00Z"), [], now)).toBe(true);
    expect(isQuiet(claim("next_step", "2026-10-28T12:00:00Z", { last_mentioned_at: "2026-11-08T12:00:00Z" }), [], now)).toBe(false);
    expect(isQuiet(claim("next_step", "2026-10-28T12:00:00Z"), [restored], now)).toBe(false);
    expect(lastActivity(claim("fact", "2026-10-28T12:00:00Z"), [restored])).toBe(Date.parse(restored.at));
  });

  it("never hides goals or decisions, or anything not IN, and respects the day setting", () => {
    expect(isQuiet(claim("goal", "2026-10-01T12:00:00Z"), [], now)).toBe(false);
    expect(isQuiet(claim("decision", "2026-10-01T12:00:00Z"), [], now)).toBe(false);
    expect(isQuiet(claim("fact", "2026-10-01T12:00:00Z", { status: "REVIEW" }), [], now)).toBe(false);
    expect(isQuiet(claim("fact", "2026-11-05T12:00:00Z"), [], now, 7)).toBe(false);
    expect(isQuiet(claim("fact", "2026-11-05T12:00:00Z"), [], now, 3)).toBe(true);
  });
});
