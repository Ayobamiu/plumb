// Brain Part B: invalidation. Plain code, no LLM.
//
// The engine works on an in-memory BrainState and mutates it in place, returning
// the changes it made. The DB layer loads a state, runs the engine and writes the
// returned changes; evals run the same engine with no DB at all.
import type { AbsencePattern, Claim, ClaimStatus, Event, Reason, Transition } from "../contract.js";
import {
  explainAbsenceBroken,
  explainChain,
  explainConfirmedOut,
  explainRestored,
  explainUntilPassed,
} from "./explain.js";

export interface BrainState {
  claims: Map<string, Claim>;
  reasons: Reason[];
  events: Event[];
  transitions: Transition[];
}

export interface BrainContext {
  now: string; // when we are deciding: retracted_at and Transition.at
  newId: () => string;
}

export interface Change {
  claim: Claim; // the claim after the change
  transition: Transition;
}

type AbsenceReason = Extract<Reason, { type: "absence" }>;
type UntilReason = Extract<Reason, { type: "until" }>;
type DependsOnReason = Extract<Reason, { type: "depends_on" }>;

const ms = (iso: string) => Date.parse(iso);

// "Avery Hart <Avery@Northfield.edu>" and "avery@northfield.edu" are the same sender.
export function normalizeAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1]! : from).trim().toLowerCase();
}

/** Code matches an absence only if it names a sender, thread or source. The rest go to the model check. */
export function hasCodePattern(pattern: AbsencePattern): boolean {
  return pattern.from !== undefined || pattern.thread_id !== undefined || pattern.source_id !== undefined;
}

/** An absence breaks when the event matches every filled field and happened after `since`. */
export function absenceBrokenBy(pattern: AbsencePattern, since: string, event: Event): boolean {
  // A pattern with only event_kind (and maybe text_hint) would match every email.
  if (!hasCodePattern(pattern)) return false;
  if (event.kind !== pattern.event_kind) return false;
  if (ms(event.occurred_at) <= ms(since)) return false;
  if (pattern.from !== undefined) {
    if (!event.from || normalizeAddress(event.from) !== normalizeAddress(pattern.from)) return false;
  }
  if (pattern.thread_id !== undefined && event.thread_id !== pattern.thread_id) return false;
  if (pattern.source_id !== undefined && event.source_id !== pattern.source_id) return false;
  return true;
}

export function untilPassed(at: string, now: string): boolean {
  return ms(now) > ms(at);
}

const isLive = (status: ClaimStatus) => status === "IN" || status === "REVIEW";

/** Events in the order they happened in the world. Ties break on id so runs are repeatable. */
export function sortEvents(events: Event[]): Event[] {
  return [...events].sort((a, b) => ms(a.occurred_at) - ms(b.occurred_at) || a.id.localeCompare(b.id));
}

/** Run one new event: break matching absence reasons (and until reasons on a clock tick), then the chain. */
export function onEvent(state: BrainState, event: Event, ctx: BrainContext): Change[] {
  state.events.push(event);
  const roots: Change[] = [];
  for (const reason of state.reasons) {
    const claim = state.claims.get(reason.claim_id);
    if (!claim || !isLive(claim.status)) continue;
    if (reason.type === "absence" && absenceBrokenBy(reason.pattern, reason.since, event)) {
      roots.push(markOut(state, claim, ctx, {
        event_id: event.id,
        reason_id: reason.id,
        valid_to: event.occurred_at,
        explanation: explainAbsenceBroken(reason.pattern, event),
      }));
    } else if (reason.type === "until" && event.kind === "clock" && untilPassed(reason.at, event.occurred_at)) {
      roots.push(markOut(state, claim, ctx, {
        event_id: event.id,
        reason_id: reason.id,
        valid_to: reason.at,
        explanation: explainUntilPassed(reason.at),
      }));
    }
  }
  return [...roots, ...cascade(state, roots, ctx)];
}

/** Run several events in world order, so a late-seen email still lands in the right place. */
export function onEvents(state: BrainState, events: Event[], ctx: BrainContext): Change[] {
  return sortEvents(events).flatMap((e) => onEvent(state, e, ctx));
}

/**
 * Check claims that were just recorded against what we already know: an absence
 * already broken by a stored event, or an until already passed. Used by record_claims.
 */
export function evaluateClaims(state: BrainState, claimIds: string[], ctx: BrainContext): Change[] {
  const roots: Change[] = [];
  for (const id of claimIds) {
    const claim = state.claims.get(id);
    if (!claim || !isLive(claim.status)) continue;
    const broken = firstBrokenReason(state, claim.id, ctx.now);
    if (broken) roots.push(markOut(state, claim, ctx, broken));
  }
  return [...roots, ...cascade(state, roots, ctx)];
}

/** Usman confirms a REVIEW claim is false: OUT, then the chain runs as usual. */
export function confirmOut(state: BrainState, claimId: string, ctx: BrainContext): Change[] {
  const claim = mustGet(state, claimId);
  if (claim.status === "OUT") return [];
  const root = markOut(state, claim, ctx, { explanation: explainConfirmedOut() });
  return [root, ...cascade(state, [root], ctx)];
}

/**
 * Usman says a REVIEW or OUT claim is still true. It goes back IN, and so does
 * every dependent the chain knocked down because of it, if its other reasons hold.
 */
export function restore(state: BrainState, claimId: string, ctx: BrainContext): Change[] {
  const claim = mustGet(state, claimId);
  if (claim.status === "IN") return [];
  const changes = [setStatus(state, claim, "IN", ctx, { depth: 0, explanation: explainRestored() })];

  const visited = new Set([claimId]);
  const queue: { cause: Claim; depth: number }[] = [{ cause: changes[0]!.claim, depth: 0 }];
  while (queue.length) {
    const { cause, depth } = queue.shift()!;
    for (const dep of dependentsOf(state, cause.id)) {
      if (visited.has(dep.id) || dep.status !== "OUT") continue;
      if (lastOutCause(state, dep.id) !== cause.id) continue;
      if (firstBrokenReason(state, dep.id, ctx.now)) continue;
      visited.add(dep.id);
      const change = setStatus(state, dep, "IN", ctx, {
        depth: depth + 1,
        cause_claim_id: cause.id,
        explanation: explainRestored(cause),
      });
      changes.push(change);
      queue.push({ cause: change.claim, depth: depth + 1 });
    }
  }
  return changes;
}

/** Part C entry point: a model check may send a claim to REVIEW, never to OUT. */
export function sendToReview(
  state: BrainState,
  claimId: string,
  ctx: BrainContext,
  info: { explanation: string; event_id?: string },
): Change[] {
  const claim = mustGet(state, claimId);
  if (claim.status !== "IN") return [];
  return [setStatus(state, claim, "REVIEW", ctx, { depth: 0, ...info })];
}

// Breadth-first over depends_on edges in reverse. REVIEW claims never knock
// anything down: only OUT claims start or continue the chain.
function cascade(state: BrainState, roots: Change[], ctx: BrainContext): Change[] {
  const out: Change[] = [];
  const visited = new Set(roots.map((r) => r.claim.id));
  const queue = roots.map((r) => ({ cause: r.claim, depth: r.transition.depth, event_id: r.transition.event_id }));
  while (queue.length) {
    const { cause, depth, event_id } = queue.shift()!;
    for (const reason of dependsOnReasonsTo(state, cause.id)) {
      const dep = state.claims.get(reason.claim_id);
      if (!dep || visited.has(dep.id) || !isLive(dep.status)) continue;
      visited.add(dep.id);
      const change = markOut(state, dep, ctx, {
        depth: depth + 1,
        cause_claim_id: cause.id,
        event_id,
        reason_id: reason.id,
        valid_to: cause.valid_to,
        explanation: explainChain(cause),
      });
      out.push(change);
      queue.push({ cause: change.claim, depth: depth + 1, event_id });
    }
  }
  return out;
}

interface TransitionInfo {
  depth?: number;
  event_id?: string;
  reason_id?: string;
  cause_claim_id?: string;
  valid_to?: string;
  explanation: string;
}

function markOut(state: BrainState, claim: Claim, ctx: BrainContext, info: TransitionInfo): Change {
  return setStatus(state, claim, "OUT", ctx, { depth: 0, ...info });
}

function setStatus(
  state: BrainState,
  claim: Claim,
  to: ClaimStatus,
  ctx: BrainContext,
  info: TransitionInfo,
): Change {
  const updated: Claim = { ...claim, status: to };
  if (to === "OUT") {
    updated.retracted_at = ctx.now;
    updated.valid_to = info.valid_to ?? ctx.now;
  } else if (to === "IN") {
    delete updated.retracted_at;
    delete updated.valid_to;
  }
  const transition: Transition = {
    id: ctx.newId(),
    claim_id: claim.id,
    from_status: claim.status,
    to_status: to,
    depth: info.depth ?? 0,
    explanation: info.explanation,
    at: ctx.now,
    ...(info.event_id && { event_id: info.event_id }),
    ...(info.reason_id && { reason_id: info.reason_id }),
    ...(info.cause_claim_id && { cause_claim_id: info.cause_claim_id }),
  };
  state.claims.set(claim.id, updated);
  state.transitions.push(transition);
  return { claim: updated, transition };
}

/** The first reason of a claim that no longer holds, given every stored event and the current time. */
function firstBrokenReason(state: BrainState, claimId: string, now: string): TransitionInfo | undefined {
  for (const reason of state.reasons) {
    if (reason.claim_id !== claimId) continue;
    const broken = reasonBroken(state, reason, now);
    if (broken) return broken;
  }
  return undefined;
}

function reasonBroken(state: BrainState, reason: Reason, now: string): TransitionInfo | undefined {
  switch (reason.type) {
    case "depends_on": {
      const target = state.claims.get(reason.claim);
      if (target && target.status === "OUT") {
        return { depth: 1, cause_claim_id: target.id, reason_id: reason.id, valid_to: target.valid_to, explanation: explainChain(target) };
      }
      return undefined;
    }
    case "absence":
      return absenceBrokenByAny(state, reason);
    case "until":
      return untilBroken(reason, now);
    case "evidence":
      return undefined; // superseded evidence is out of scope this week
  }
}

function absenceBrokenByAny(state: BrainState, reason: AbsenceReason): TransitionInfo | undefined {
  const event = sortEvents(state.events).find((e) => absenceBrokenBy(reason.pattern, reason.since, e));
  if (!event) return undefined;
  return {
    event_id: event.id,
    reason_id: reason.id,
    valid_to: event.occurred_at,
    explanation: explainAbsenceBroken(reason.pattern, event),
  };
}

function untilBroken(reason: UntilReason, now: string): TransitionInfo | undefined {
  if (!untilPassed(reason.at, now)) return undefined;
  return { reason_id: reason.id, valid_to: reason.at, explanation: explainUntilPassed(reason.at) };
}

function dependsOnReasonsTo(state: BrainState, claimId: string): DependsOnReason[] {
  return state.reasons.filter((r): r is DependsOnReason => r.type === "depends_on" && r.claim === claimId);
}

function dependentsOf(state: BrainState, claimId: string): Claim[] {
  return dependsOnReasonsTo(state, claimId)
    .map((r) => state.claims.get(r.claim_id))
    .filter((c): c is Claim => c !== undefined);
}

function lastOutCause(state: BrainState, claimId: string): string | undefined {
  for (let i = state.transitions.length - 1; i >= 0; i--) {
    const t = state.transitions[i]!;
    if (t.claim_id === claimId && t.to_status === "OUT") return t.cause_claim_id;
  }
  return undefined;
}

function mustGet(state: BrainState, claimId: string): Claim {
  const claim = state.claims.get(claimId);
  if (!claim) throw new Error(`unknown claim ${claimId}`);
  return claim;
}
