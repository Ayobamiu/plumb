// Search-by-description eval (Oct 28). Usage: pnpm eval:search [--split dev|heldout|all] [--model] [--runs N] [--verbose]
// Scores natural-language /plumb queries against made-up sessions in
// search/fixture.json. keyword is today's find_context (every word must match,
// newest first); any-word is the code-only candidate order; muse (--model) is
// searchByDescription.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { gatherCandidates, matchesQuery, MetaClient, searchByDescription, sharedWords, SourceKind, toolLabel, type SearchCandidate } from "@plumb/core";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const split = args.includes("--split") ? args[args.indexOf("--split") + 1] : "dev";
const verbose = args.includes("--verbose");
const withModel = args.includes("--model");
const runs = args.includes("--runs") ? Math.max(1, Number(args[args.indexOf("--runs") + 1]) || 1) : 1;

const Fixture = z.object({
  now: z.string(),
  sessions: z.array(z.object({ key: z.string(), kind: SourceKind, title: z.string(), last_at: z.string(), summary: z.string(), claims: z.array(z.string()) })),
});
const Queries = z.object({ queries: z.array(z.object({ q: z.string(), accept: z.array(z.string()), split: z.enum(["dev", "heldout"]) })) });
type Session = z.infer<typeof Fixture>["sessions"][number];

interface Answer {
  best?: string;
  alternatives: string[];
}
type System = (q: string) => Promise<Answer>;

const fixture = Fixture.parse(JSON.parse(await readFile(join(root, "search/fixture.json"), "utf8")));
const queries = Queries.parse(JSON.parse(await readFile(join(root, "search/queries.json"), "utf8"))).queries.filter((q) => split === "all" || q.split === split);
const candidates: SearchCandidate[] = fixture.sessions.map((s) => ({ id: s.key, tool: toolLabel(s.kind), last_at: s.last_at, title: s.title, summary: s.summary, claims: s.claims }));
const newest = (a: Session, b: Session) => Date.parse(b.last_at) - Date.parse(a.last_at);

const systems: Record<string, System> = {
  // find_context today: AND match on tool words, title and latest summary; the /plumb command takes the first (newest).
  keyword: async (q) => {
    const hits = fixture.sessions
      .filter((s) => matchesQuery({ id: s.key, kind: s.kind, external_id: s.key, title: s.title }, s.summary, q))
      .sort(newest)
      .map((s) => s.key);
    return { ...(hits[0] && { best: hits[0] }), alternatives: hits.slice(1, 4) };
  },
};
// The code-only order searchByDescription hands the model; best is the top one if it shares any word.
systems["any-word"] = async (q) => {
  const shared = gatherCandidates(candidates, q)
    .filter((c) => sharedWords(c, q) > 0)
    .map((c) => c.id);
  return { ...(shared[0] && { best: shared[0] }), alternatives: shared.slice(1, 4) };
};
if (withModel) {
  const client = new MetaClient();
  systems.muse = async (q) => {
    const r = await searchByDescription(client, q, candidates, fixture.now);
    return { ...(r.best && { best: r.best.id }), alternatives: r.alternatives.map((a) => a.id) };
  };
}

interface Tally {
  top1: [number, number]; // [best right, queries with an answer]
  found: [number, number]; // [right one in best or alternatives, queries with an answer]
  none: [number, number]; // [said not found, queries with no answer]
  ms: number[];
  misses: string[];
}

const results: Record<string, Tally> = {};
for (const [name, system] of Object.entries(systems)) {
  const t: Tally = { top1: [0, 0], found: [0, 0], none: [0, 0], ms: [], misses: [] };
  for (let run = 0; run < (name === "muse" ? runs : 1); run++) {
    for (const q of queries) {
      const started = Date.now();
      let a: Answer;
      try {
        a = await system(q.q);
      } catch (err) {
        t.misses.push(`${q.q}: error ${err instanceof Error ? err.message : String(err)}`);
        a = { alternatives: [] };
      }
      t.ms.push(Date.now() - started);
      const ok = new Set(q.accept);
      const got = a.best ? `${a.best}${a.alternatives.length ? ` (alts ${a.alternatives.join(", ")})` : ""}` : `none${a.alternatives.length ? ` (alts ${a.alternatives.join(", ")})` : ""}`;
      if (ok.size === 0) {
        t.none[1]++;
        if (!a.best) t.none[0]++;
        else t.misses.push(`"${q.q}": want none, got ${got}`);
      } else {
        t.top1[1]++;
        t.found[1]++;
        if (a.best && ok.has(a.best)) t.top1[0]++;
        else t.misses.push(`"${q.q}": want ${q.accept.join("|")}, got ${got}`);
        if ([a.best, ...a.alternatives].some((k) => k && ok.has(k))) t.found[0]++;
      }
    }
  }
  results[name] = t;
}

const pct = ([a, b]: [number, number]) => (b ? `${Math.round((100 * a) / b)}% (${a}/${b})` : "n/a");
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
console.log(`Search eval, split ${split}, ${queries.length} queries${runs > 1 ? `, muse x${runs}` : ""}\n`);
console.log(["system", "right best", "right in top 4", "says not found", "median ms"].join(" | "));
for (const [name, t] of Object.entries(results)) console.log([name, pct(t.top1), pct(t.found), pct(t.none), median(t.ms)].join(" | "));
if (verbose)
  for (const [name, t] of Object.entries(results)) {
    console.log(`\n${name} misses:`);
    for (const m of t.misses) console.log(`  ${m}`);
  }

await mkdir(join(root, "results"), { recursive: true });
const file = join(root, "results", `search-${split}-${randomUUID().slice(0, 8)}.json`);
await writeFile(file, JSON.stringify({ at: new Date().toISOString(), split, runs, results }, null, 2));
console.log(`\nSaved ${file}`);
