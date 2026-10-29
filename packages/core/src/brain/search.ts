// Search by description (Oct 28): find the session someone means from their
// own words ("gym plan from Claude last week"), not keywords. Code gathers a
// short list of candidates; Muse Spark picks the best match, or none, with a
// one-line why. Keyword AND matching (matchesQuery) stays as the fallback when
// no model is available.
import { z } from "zod";
import { MUSE_SPARK } from "../meta/client.js";
import { loadPrompt, type JsonModel } from "./extract.js";

export const SEARCH_PROMPT = "search.v2";
const MAX_CANDIDATES = 40;
const MAX_CLAIMS = 3;

export interface SearchCandidate {
  id: string;
  tool: string; // "Claude chat", "Cursor", ...
  last_at: string;
  title?: string;
  summary: string;
  claims: string[]; // a few things it said, newest first
}

export interface SearchMatch {
  id: string;
  why: string;
}

export interface SearchResult {
  best?: SearchMatch;
  alternatives: SearchMatch[];
  why: string; // why best fits, or what was looked for when nothing did
  candidates: number; // how many the model saw
}

// Words that carry no topic. Tool names are kept: the model reads them.
const STOP = new Set(
  "a an and about any are as at be by can chat did do does for from get give had has have how i in is it its last me my of on or our session sessions that the this to was we were what when where which who why with yesterday today week weeks ago thing stuff".split(" "),
);

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);

/** How many of the query's topic words (stemmed) a candidate contains. */
export function sharedWords(c: SearchCandidate, query: string): number {
  const text = new Set(words([c.tool, c.title ?? "", c.summary, ...c.claims].join(" ")));
  return [...new Set(words(query))].filter((w) => text.has(w)).length;
}

/**
 * The short list the model sees: candidates sharing a word with the query
 * first (most shared words, then newest), then the newest of the rest, so a
 * paraphrase with no shared word can still be found among recent sessions.
 */
export function gatherCandidates(all: SearchCandidate[], query: string, max = MAX_CANDIDATES): SearchCandidate[] {
  return all
    .map((c) => ({ c, hits: sharedWords(c, query) }))
    .sort((a, b) => b.hits - a.hits || Date.parse(b.c.last_at) - Date.parse(a.c.last_at))
    .slice(0, max)
    .map((s) => s.c);
}

const Answer = z.object({
  best: z.string().nullable(),
  alternatives: z.array(z.object({ id: z.string(), why: z.string() })),
  why: z.string(),
});
const SCHEMA = {
  type: "object",
  properties: {
    best: { anyOf: [{ type: "string" }, { type: "null" }] },
    alternatives: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, why: { type: "string" } }, required: ["id", "why"], additionalProperties: false },
    },
    why: { type: "string" },
  },
  required: ["best", "alternatives", "why"],
  additionalProperties: false,
};

const when = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function buildSearchMessage(query: string, candidates: SearchCandidate[], now: string, tz = process.env.PLUMB_TZ ?? "America/New_York"): string {
  const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
  return [
    `Now: ${when(now, tz)}, ${new Date(now).getUTCFullYear()}`,
    `Request: ${oneLine(query)}`,
    "",
    "Candidates:",
    ...candidates.map((c) =>
      [
        `[${c.id}] ${c.tool}, last active ${when(c.last_at, tz)}`,
        `  title: ${oneLine(c.title ?? "(none)")}`,
        `  summary: ${oneLine(c.summary).slice(0, 300) || "(none)"}`,
        ...c.claims.slice(0, MAX_CLAIMS).map((t) => `  said: ${oneLine(t).slice(0, 160)}`),
      ].join("\n"),
    ),
  ].join("\n");
}

export async function searchByDescription(
  model: JsonModel,
  query: string,
  all: SearchCandidate[],
  now: string,
  modelId = MUSE_SPARK,
): Promise<SearchResult> {
  const candidates = gatherCandidates(all, query);
  if (candidates.length === 0) return { alternatives: [], why: "Nothing is saved yet.", candidates: 0 };
  const out = await model.json({
    job: "search",
    developer: await loadPrompt(SEARCH_PROMPT),
    user: buildSearchMessage(query, candidates, now),
    schemaName: "search",
    jsonSchema: SCHEMA,
    parse: Answer,
    effort: "low",
    model: modelId,
  });
  // Ids the model made up are dropped, and best never repeats as an alternative.
  const known = new Set(candidates.map((c) => c.id));
  const best = out.best && known.has(out.best) ? { id: out.best, why: out.why.trim() } : undefined;
  const alternatives = out.alternatives
    .filter((a, i, list) => known.has(a.id) && a.id !== best?.id && list.findIndex((x) => x.id === a.id) === i)
    .slice(0, 3)
    .map((a) => ({ id: a.id, why: a.why.trim() }));
  return { ...(best && { best }), alternatives, why: out.why.trim(), candidates: candidates.length };
}
