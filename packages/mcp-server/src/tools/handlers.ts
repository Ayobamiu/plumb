// Handlers for the six MCP tools in tab 1. Each one loads what the brain needs,
// runs the plain-code engine from @plumb/core, and writes the result in one
// atomic Store.apply. Inputs arrive already validated (see index.ts).
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  ClaimKind,
  confirmOut,
  evaluateClaims,
  explainEdited,
  isQuiet,
  materializeClaims,
  modelCheck,
  onEvent,
  renderProjectState,
  restore,
  selectCandidates,
  sendToReview,
  withNote,
  type BrainContext,
  type BrainState,
  type Change,
  type Claim,
  type ClaimStatus,
  type Event,
  type JsonModel,
  type ExplainClaimInput,
  type ExplainClaimOutput,
  type GetProjectStateInput,
  type GetProjectStateOutput,
  type ListProjectsOutput,
  type Reason,
  type RecordClaimsInput,
  type RecordClaimsOutput,
  type RecordEventInput,
  type RecordEventOutput,
  type ResolveReviewInput,
  type ResolveReviewOutput,
  type Transition,
} from "@plumb/core";
import { ConflictError, type ClaimUpdate, type Store } from "./store.js";

export class ToolError extends Error {
  constructor(
    readonly code: "bad_input" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

type AbsenceReason = Extract<Reason, { type: "absence" }>;

function context(): BrainContext {
  return { now: new Date().toISOString(), newId: randomUUID };
}

// The engine follows depends_on edges across the whole graph, so it gets every
// claim and reason. Fine at this week's scale (hundreds of claims).
async function loadBrain(store: Store): Promise<BrainState> {
  const [claims, reasons] = await Promise.all([store.loadClaims(), store.loadReasons()]);
  return { claims: new Map(claims.map((c) => [c.id, c])), reasons, events: [], transitions: [] };
}

/** Stored events that could break any of these absence reasons. */
async function eventsFor(store: Store, reasons: Reason[]): Promise<Event[]> {
  const absences = reasons.filter((r): r is AbsenceReason => r.type === "absence");
  if (absences.length === 0) return [];
  const kinds = [...new Set(absences.map((r) => r.pattern.event_kind))];
  const after = absences.reduce((min, r) => (Date.parse(r.since) < Date.parse(min) ? r.since : min), absences[0]!.since);
  return store.loadEvents({ kinds, after });
}

const statuses = (state: BrainState) => new Map([...state.claims].map(([id, c]) => [id, c.status]));

/** Status changes to stored claims, each with the status it was computed from. */
function updatesFor(state: BrainState, before: Map<string, ClaimStatus>, changes: Change[]): ClaimUpdate[] {
  const ids = new Set(changes.map((c) => c.claim.id));
  return [...ids]
    .filter((id) => before.has(id))
    .map((id) => ({ claim: state.claims.get(id)!, expected_status: before.get(id)! }));
}

/** Another run may move a claim between our read and our write; start over when it does. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof ConflictError) || attempt >= MAX_ATTEMPTS) throw err;
    }
  }
}

async function mustProject(store: Store, id: string) {
  const project = await store.getProject(id);
  if (!project) throw new ToolError("not_found", `unknown project ${id}`);
  return project;
}

/** A claim to send to REVIEW, with its one-sentence explanation. */
export interface ReviewItem {
  claim_id: string;
  explanation: string;
  event_id?: string;
}

export interface HandlerOptions {
  model?: JsonModel; // runs Part C on record_event; without it only Part B runs
}

export function createHandlers(store: Store, opts: HandlerOptions = {}) {
  /** Not an MCP tool: send claims to REVIEW (Part C and /ingest). Never OUT. */
  async function review(items: ReviewItem[]): Promise<Transition[]> {
    if (items.length === 0) return [];
    return withRetry(async () => {
      const ctx = context();
      const state = await loadBrain(store);
      const before = statuses(state);
      const changes = items.flatMap((item) =>
        state.claims.has(item.claim_id)
          ? sendToReview(state, item.claim_id, ctx, {
              explanation: item.explanation,
              ...(item.event_id && { event_id: item.event_id }),
            })
          : [],
      );
      await store.apply({ updates: updatesFor(state, before, changes), transitions: changes.map((c) => c.transition) });
      return changes.map((c) => c.transition);
    });
  }

  /** Not an MCP tool: mark claims as just talked about (last_mentioned_at), without changing them. */
  async function mention(claimIds: string[], at: string): Promise<void> {
    const ids = [...new Set(claimIds)];
    if (ids.length === 0) return;
    await withRetry(async () => {
      const claims = await store.loadClaims({ ids });
      const updates = claims
        .filter((c) => !c.last_mentioned_at || Date.parse(c.last_mentioned_at) < Date.parse(at))
        .map((c) => ({ claim: { ...c, last_mentioned_at: at }, expected_status: c.status }));
      if (updates.length) await store.apply({ updates, transitions: [] });
    });
  }

  return {
    review,
    mention,

    async list_projects(): Promise<z.infer<typeof ListProjectsOutput>> {
      return { projects: await store.listProjects() };
    },

    async get_project_state(input: z.infer<typeof GetProjectStateInput>): Promise<z.infer<typeof GetProjectStateOutput>> {
      const project = await mustProject(store, input.project_id);
      const since = input.since ?? new Date(Date.now() - DAY_MS).toISOString();
      const claims = await store.loadClaims({ project_id: project.id });
      const byId = new Map(claims.map((c) => [c.id, c]));

      const now = new Date().toISOString();
      const inIds = claims.filter((c) => c.status === "IN").map((c) => c.id);
      // Status changes count as activity for the quiet rule (e.g. restored IN yesterday).
      const history = inIds.length ? await store.loadTransitions({ claim_ids: inIds }) : [];
      const in_claims = Object.fromEntries(ClaimKind.options.map((k) => [k, [] as Claim[]])) as Record<ClaimKind, Claim[]>;
      const quiet_claims: Claim[] = [];
      for (const c of claims) {
        if (c.status !== "IN") continue;
        if (isQuiet(c, history, now, input.quiet_after_days)) quiet_claims.push(c);
        else in_claims[c.kind].push(c);
      }

      const transitions = await store.loadTransitions({ since, to_statuses: ["OUT", "REVIEW"] });
      const changed_since = transitions
        .filter((t) => byId.has(t.claim_id))
        .reverse() // newest first
        .map((transition) => ({ claim: byId.get(transition.claim_id)!, transition }));

      const markdown = renderProjectState({ project, in_claims, changed_since, quiet_claims }, { since, now });
      return { project, in_claims, changed_since, markdown, quiet_claims };
    },

    async record_claims(input: z.infer<typeof RecordClaimsInput>): Promise<z.infer<typeof RecordClaimsOutput>> {
      await mustProject(store, input.project_id);
      return withRetry(async () => {
        const ctx = context();
        const source = await store.upsertSource(input.source);
        const state = await loadBrain(store);
        for (const c of input.claims) {
          const target = c.same_as ? state.claims.get(c.same_as) : undefined;
          if (c.same_as && target?.project_id !== input.project_id) {
            throw new ToolError("bad_input", `same_as points at unknown claim ${c.same_as}`);
          }
        }
        const before = statuses(state);

        let m: ReturnType<typeof materializeClaims>;
        try {
          m = materializeClaims({
            project_id: input.project_id,
            source_id: source.id,
            extracted_by: input.extracted_by,
            recorded_at: ctx.now,
            claims: input.claims,
            existing: state.claims,
            newId: ctx.newId,
          });
        } catch (err) {
          throw new ToolError("bad_input", err instanceof Error ? err.message : String(err));
        }

        // A new claim may already be false: its absence broken by a stored
        // event, its until passed, or a claim it depends on already OUT.
        for (const c of m.claims) state.claims.set(c.id, c);
        state.reasons.push(...m.reasons);
        state.events = await eventsFor(store, m.reasons);
        const changes = evaluateClaims(state, m.touched, ctx);

        const claims = m.claims.map((c) => state.claims.get(c.id)!);
        await store.apply({
          claims,
          reasons: m.reasons,
          updates: updatesFor(state, before, changes),
          transitions: changes.map((c) => c.transition),
        });
        return { claims, reasons: m.reasons, id_map: m.id_map };
      });
    },

    async record_event(input: z.infer<typeof RecordEventInput>): Promise<z.infer<typeof RecordEventOutput>> {
      const partB = await withRetry(async () => {
        const ctx = context();
        const source = await store.upsertSource(input.source);
        const event: Event = {
          id: ctx.newId(),
          kind: input.kind,
          source_id: source.id,
          occurred_at: input.occurred_at,
          observed_at: ctx.now,
          summary: input.summary,
          ...(input.from !== undefined && { from: input.from }),
          ...(input.thread_id !== undefined && { thread_id: input.thread_id }),
        };
        const state = await loadBrain(store);
        const before = statuses(state);
        const changes = onEvent(state, event, ctx);
        const transitions = changes.map((c) => c.transition);

        // The clock ticks every minute. Keep only the ticks that changed something.
        if (event.kind === "clock" && changes.length === 0) return { event, transitions, state };

        await store.apply({ event, updates: updatesFor(state, before, changes), transitions });
        return { event, transitions, state };
      });

      // Part C, after Part B is written: ask the model about IN claims the
      // patterns didn't catch. Model calls stay outside the retry loop, so a
      // write conflict never pays for them twice.
      const { event, transitions, state } = partB;
      const candidates = opts.model ? selectCandidates(state, event) : [];
      if (candidates.length === 0) return { event, transitions };
      const checked = await modelCheck(opts.model!, event, candidates);
      const reviewed = await review(checked.flags);
      return { event, transitions: [...transitions, ...reviewed] };
    },

    async explain_claim(input: z.infer<typeof ExplainClaimInput>): Promise<z.infer<typeof ExplainClaimOutput>> {
      const [claim] = await store.loadClaims({ ids: [input.claim_id] });
      if (!claim) throw new ToolError("not_found", `unknown claim ${input.claim_id}`);
      const [source, reasons, pointingHere, history] = await Promise.all([
        store.getSource(claim.source_id),
        store.loadReasons({ claim_ids: [claim.id] }),
        store.loadReasons({ depends_on: [claim.id] }),
        store.loadTransitions({ claim_ids: [claim.id] }),
      ]);
      if (!source) throw new ToolError("not_found", `unknown source ${claim.source_id}`);
      const dependsOnIds = reasons.flatMap((r) => (r.type === "depends_on" ? [r.claim] : []));
      const dependentIds = [...new Set(pointingHere.map((r) => r.claim_id))];
      const [depends_on, dependents] = await Promise.all([
        dependsOnIds.length ? store.loadClaims({ ids: dependsOnIds }) : [],
        dependentIds.length ? store.loadClaims({ ids: dependentIds }) : [],
      ]);
      return { claim, source, reasons, depends_on, dependents, history };
    },

    async resolve_review(input: z.infer<typeof ResolveReviewInput>): Promise<z.infer<typeof ResolveReviewOutput>> {
      if (input.action === "edit" && !input.text) throw new ToolError("bad_input", "edit needs text");
      return withRetry(async () => {
        const ctx = context();
        const state = await loadBrain(store);
        const claim = state.claims.get(input.claim_id);
        if (!claim) throw new ToolError("not_found", `unknown claim ${input.claim_id}`);
        const before = statuses(state);

        let changes: Change[];
        if (input.action === "confirm_out") {
          changes = confirmOut(state, claim.id, ctx);
        } else {
          // Restoring checks dependents' other reasons, and which claim knocked each one down.
          state.events = await eventsFor(store, state.reasons);
          state.transitions = await store.loadTransitions({ to_statuses: ["OUT"] });
          if (input.action === "edit") state.claims.set(claim.id, { ...claim, text: input.text! });
          changes = restore(state, claim.id, ctx);
          if (input.action === "edit") changes = edited(state, claim, changes, ctx);
        }
        if (input.note && changes[0]) changes[0].transition.explanation = withNote(changes[0].transition.explanation, input.note);

        await store.apply({ updates: updatesFor(state, before, changes), transitions: changes.map((c) => c.transition) });
        return { transitions: changes.map((c) => c.transition) };
      });
    },
  };
}

/**
 * An edit always writes a transition, even when the claim was already IN, and
 * the explanation keeps the old text, since nothing is ever deleted.
 */
function edited(state: BrainState, original: Claim, changes: Change[], ctx: BrainContext): Change[] {
  const explanation = explainEdited(original.text, original.status);
  if (changes[0]) {
    changes[0].transition.explanation = explanation;
    return changes;
  }
  const claim = state.claims.get(original.id)!;
  const transition = {
    id: ctx.newId(),
    claim_id: claim.id,
    from_status: claim.status,
    to_status: claim.status,
    depth: 0,
    explanation,
    at: ctx.now,
  };
  state.transitions.push(transition);
  return [{ claim, transition }];
}

export type Handlers = ReturnType<typeof createHandlers>;
