// Systems under test. Each takes a scenario and returns every claim's status
// after each step, or null when the scenario doesn't apply to it. `systems`
// are plain code and free to run; `modelSystems` call Muse Spark (pnpm eval:model).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  confirmOut,
  evaluateClaims,
  explainContradicted,
  extractClaims,
  findDuplicates,
  knownThreads,
  loadPrompt,
  materializeClaims,
  modelCheck,
  MUSE_SPARK,
  onEvent,
  recheckClaims,
  restore,
  suggestLinks,
  selectCandidates,
  sendToReview,
  type BrainState,
  type ClaimStatus,
  type Event,
  type JsonModel,
} from "@plumb/core";
import { claimKeys, timeline, type Scenario, type Step } from "./scenario.js";

/** A key's status, or MISSING when extraction never produced the claim. */
export type KeyStatus = ClaimStatus | "MISSING";

export interface SystemRun {
  statusAfter: Map<string, Map<string, KeyStatus>>; // step key -> claim key -> status
  flagMs: number[]; // wall-clock time of each step that flagged a claim
  extraction?: { found: number; keys: number; extracted: number; texts: number; extras: string[] };
  links?: { expected: number; right: number; wrong: string[] }; // link suggestions vs expect_links
}

type System = (s: Scenario) => Promise<SystemRun | null>;

const SOURCE_ID = "eval-source";

function toEvent(step: Extract<Step, { type: "event" }>, index: number): Event {
  const e = step.event;
  return {
    id: `e${String(index).padStart(3, "0")}`,
    kind: e.kind,
    source_id: SOURCE_ID,
    occurred_at: e.occurred_at,
    observed_at: e.occurred_at,
    summary: e.summary,
    ...(e.from && { from: e.from }),
    ...(e.thread_id && { thread_id: e.thread_id }),
  };
}

const lower = (s: string) => s.toLowerCase();

/**
 * Plumb: Part B always; with a model, also extraction (Part A) for texts and
 * the model check (Part C) for events. Without a model, text scenarios don't apply.
 */
async function runPlumb(s: Scenario, model?: JsonModel): Promise<SystemRun | null> {
  if (s.texts.length > 0 && !model) return null;
  const m = materializeClaims({
    project_id: s.id,
    source_id: SOURCE_ID,
    extracted_by: "hand-written",
    recorded_at: s.recorded_at,
    claims: s.claims,
    existing: new Map(),
    newId: randomUUID,
  });
  const state: BrainState = { claims: new Map(m.claims.map((c) => [c.id, c])), reasons: m.reasons, events: [], transitions: [] };
  const keyToId = new Map(Object.entries(m.id_map));
  const keys = claimKeys(s);
  const statusOf = () => new Map(keys.map((k): [string, KeyStatus] => [k, keyToId.has(k) ? state.claims.get(keyToId.get(k)!)!.status : "MISSING"]));
  const statusAfter = new Map<string, Map<string, KeyStatus>>();
  const flagMs: number[] = [];
  const extractedIds: string[] = [];
  let eventIndex = 0;
  let lastSweepAt = -Infinity;
  const keyOf = (id: string) => [...keyToId].find(([, v]) => v === id)?.[0] ?? "(unkeyed claim)";
  const knownLinks = new Set<string>();
  const suggested: { claim_id: string; depends_on: string; accepted: boolean }[] = [];
  const expectedLinks = new Set(s.expect_links.map(([a, b]) => `${a}>${b}`));

  for (const step of timeline(s)) {
    const before = statusOf();
    const started = Date.now();
    const ctx = { now: step.at, newId: randomUUID };

    if (step.type === "event") {
      const event = toEvent(step, eventIndex++);
      onEvent(state, event, ctx);
      if (model) {
        const checked = await modelCheck(model, event, selectCandidates(state, event));
        for (const f of checked.flags) sendToReview(state, f.claim_id, ctx, { explanation: f.explanation, event_id: f.event_id });
      }
    } else if (step.type === "text") {
      const t = step.text;
      // As in production (/ingest): one source per kind and external id.
      const sourceId = `text:${t.source.kind}:${t.source.external_id}`;
      const result = await extractClaims(model!, {
        text: t.text,
        source: { kind: t.source.kind, ...(t.source.title && { title: t.source.title }) },
        at: t.at,
        now: t.at,
        in_claims: [...state.claims.values()].filter((c) => c.status === "IN"),
        threads: knownThreads(state.events),
      });
      // The text becomes an event first (Parts B and C run on it, the sweep
      // re-reads it later); its own claims are added after, as /ingest does.
      const textEvent: Event = {
        id: `t-${step.key}`,
        kind: t.source.kind === "doc" ? "doc_edited" : "session_note",
        source_id: sourceId,
        occurred_at: t.at,
        observed_at: t.at,
        summary: (result.summary || t.text.slice(-600)).slice(0, 1000),
      };
      onEvent(state, textEvent, ctx);
      const checked = await modelCheck(model!, textEvent, selectCandidates(state, textEvent));
      for (const f of checked.flags) sendToReview(state, f.claim_id, ctx, { explanation: f.explanation, event_id: f.event_id });
      const added = materializeClaims({
        project_id: s.id,
        source_id: sourceId,
        extracted_by: result.extracted_by,
        recorded_at: t.at,
        claims: result.claims,
        existing: state.claims,
        newId: randomUUID,
      });
      for (const c of added.claims) state.claims.set(c.id, c);
      state.reasons.push(...added.reasons);
      extractedIds.push(...added.claims.map((c) => c.id));
      evaluateClaims(state, added.touched, ctx);
      const title = t.source.title ? `"${t.source.title}"` : "a note";
      for (const c of result.contradicts) {
        sendToReview(state, c.claim_id, ctx, { explanation: explainContradicted(title, c.quote) });
      }
      // Give each unfound key the first new claim that has all its words.
      const taken = new Set(keyToId.values());
      for (const [key, words] of Object.entries(s.find)) {
        if (keyToId.has(key)) continue;
        const hit = added.claims.find((c) => !taken.has(c.id) && words.every((w) => lower(c.text).includes(lower(w))));
        if (hit) {
          keyToId.set(key, hit.id);
          taken.add(hit.id);
        }
      }
    } else if (step.type === "sweep") {
      // The sleep-time sweep needs a model; without one it does nothing.
      if (model) {
        const at = Date.parse(step.at);
        const news = state.events.filter((e) => Date.parse(e.occurred_at) > lastSweepAt && Date.parse(e.occurred_at) <= at);
        const flags = [...(await recheckClaims(model, state, news)).flags, ...(await findDuplicates(model, state))];
        const done = new Set<string>();
        for (const f of flags) {
          if (done.has(f.claim_id)) continue;
          done.add(f.claim_id);
          sendToReview(state, f.claim_id, ctx, { explanation: f.explanation, ...(f.event_id && { event_id: f.event_id }) });
        }
        // Links are suggested after this sweep's REVIEWs, as in production.
        for (const l of await suggestLinks(model, state, knownLinks)) suggested.push({ ...l, accepted: false });
        lastSweepAt = at;
      }
    } else if (step.action.action === "accept_links") {
      for (const l of suggested) {
        if (l.accepted || !expectedLinks.has(`${keyOf(l.claim_id)}>${keyOf(l.depends_on)}`)) continue;
        l.accepted = true;
        state.reasons.push({ id: randomUUID(), claim_id: l.claim_id, type: "depends_on", claim: l.depends_on });
        evaluateClaims(state, [l.claim_id], ctx);
      }
    } else {
      const id = keyToId.get(step.action.claim!);
      if (id) {
        if (step.action.action === "confirm_out") confirmOut(state, id, ctx);
        else restore(state, id, ctx);
      }
    }

    const after = statusOf();
    if ((step.type === "event" || step.type === "text") && [...after].some(([k, v]) => before.get(k) === "IN" && v !== "IN" && v !== "MISSING")) {
      flagMs.push(Date.now() - started);
    }
    statusAfter.set(step.key, after);
  }

  const run: SystemRun = { statusAfter, flagMs };
  if (s.expect_links.length > 0 || suggested.length > 0) {
    const made = suggested.map((l) => `${keyOf(l.claim_id)}>${keyOf(l.depends_on)}`);
    run.links = {
      expected: expectedLinks.size,
      right: [...expectedLinks].filter((k) => made.includes(k)).length,
      wrong: made.filter((k) => !expectedLinks.has(k)),
    };
  }
  if (s.texts.length > 0) {
    const findKeys = Object.keys(s.find);
    const keyed = new Set(keyToId.values());
    run.extraction = {
      found: findKeys.filter((k) => keyToId.has(k)).length,
      keys: findKeys.length,
      extracted: extractedIds.length,
      texts: s.texts.length,
      extras: extractedIds.filter((id) => !keyed.has(id)).map((id) => state.claims.get(id)!.text),
    };
  }
  return run;
}

// Baseline 2 (tab 5): give Muse Spark the claims and the events so far, and
// ask which claims are now false. One call per event, so it sees what we see.
// It needs claims written down, so it skips text scenarios, Usman's actions and sweeps.
const BaselineOutput = z.object({ claims: z.array(z.object({ id: z.string(), status: z.enum(["IN", "OUT"]) })) });
const BASELINE_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, status: { type: "string", enum: ["IN", "OUT"] } },
        required: ["id", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
};

async function runLlmOnly(s: Scenario, model: JsonModel): Promise<SystemRun | null> {
  if (s.texts.length > 0 || s.actions.length > 0 || s.sweeps.length > 0) return null;
  const developer = await loadPrompt("baseline.v2");
  // Neutral ids, so the model can't read hints from our keys.
  const ids = new Map(s.claims.map((c, i) => [`c${i + 1}`, c.temp_id]));
  const claimLines = s.claims.map((c, i) => `c${i + 1} [${c.kind}, written ${c.valid_from}] ${c.text}`).join("\n");
  const events = timeline(s).filter((x): x is Extract<Step, { type: "event" }> => x.type === "event");
  const statusAfter = new Map<string, Map<string, KeyStatus>>();
  const flagMs: number[] = [];
  let previous = new Map(s.claims.map((c): [string, KeyStatus] => [c.temp_id, "IN"]));
  for (let i = 0; i < events.length; i++) {
    const step = events[i]!;
    const eventLines = events
      .slice(0, i + 1)
      .map(({ event: e }) => `- ${e.occurred_at} ${e.kind}${e.from ? ` from ${e.from}` : ""}${e.thread_id ? ` (thread ${e.thread_id})` : ""}: ${e.summary}`)
      .join("\n");
    const statuses = new Map(s.claims.map((c): [string, KeyStatus] => [c.temp_id, "IN"]));
    const started = Date.now();
    try {
      const out = await model.json({
        job: "eval_llm_only",
        developer,
        user: `Now: ${step.at}\n\nClaims:\n${claimLines}\n\nEvents:\n${eventLines}`,
        schemaName: "statuses",
        jsonSchema: BASELINE_SCHEMA,
        parse: BaselineOutput,
        effort: "medium",
        model: MUSE_SPARK,
      });
      for (const c of out.claims) {
        const k = ids.get(c.id);
        if (k) statuses.set(k, c.status);
      }
    } catch {
      // A failed call leaves everything IN, the same as doing nothing.
    }
    if ([...statuses].some(([k, v]) => previous.get(k) === "IN" && v !== "IN")) flagMs.push(Date.now() - started);
    previous = statuses;
    statusAfter.set(step.key, statuses);
  }
  return { statusAfter, flagMs };
}

export const modelSystems = (model: JsonModel): Record<string, System> => ({
  plumb_with_model: (s) => runPlumb(s, model),
  llm_only: (s) => runLlmOnly(s, model),
});

/** Baseline 1: claims stay IN forever. */
const doNothing: System = async (s) => ({
  statusAfter: new Map(timeline(s).map((step) => [step.key, new Map(claimKeys(s).map((k): [string, KeyStatus] => [k, "IN"]))])),
  flagMs: [],
});

/** Plumb's invalidation engine (Brain Part B) on hand-written claims. Free, no model. */
const plumb: System = (s) => runPlumb(s);

export const systems: Record<string, System> = { plumb, do_nothing: doNothing };
