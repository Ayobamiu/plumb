// The quiet rule (Usman, Oct 27): a claim can be true and still not worth
// showing. IN claims nobody has recorded, mentioned or changed for a while are
// left out of the default view (get_project_state, PROJECT_STATE.md). They stay
// IN and are never deleted; nothing about their truth changes.
import type { Claim, ClaimKind, Transition } from "../contract.js";

export const QUIET_AFTER_DAYS = 7;
// Standing choices and aims define the project even when nobody repeats them.
const NEVER_QUIET: ReadonlySet<ClaimKind> = new Set(["goal", "decision"]);

/** The latest sign of life: recorded, mentioned, or a status change. */
export function lastActivity(claim: Claim, transitions: Transition[]): number {
  let at = Math.max(Date.parse(claim.recorded_at), claim.last_mentioned_at ? Date.parse(claim.last_mentioned_at) : 0);
  for (const t of transitions) if (t.claim_id === claim.id) at = Math.max(at, Date.parse(t.at));
  return at;
}

export function isQuiet(claim: Claim, transitions: Transition[], now: string, days = QUIET_AFTER_DAYS): boolean {
  if (claim.status !== "IN" || NEVER_QUIET.has(claim.kind)) return false;
  return Date.parse(now) - lastActivity(claim, transitions) > days * 24 * 60 * 60 * 1000;
}
