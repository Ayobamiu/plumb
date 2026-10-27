// Eval runner. Usage: pnpm eval [--split dev|heldout|all] [--verbose] [--model] [--runs N]
// --model adds the systems that call Muse Spark (Plumb with extraction and the
// Part C check, and the LLM-only baseline). pnpm eval:model sets that up.
// --runs N repeats the model systems N times and pools their metrics: model
// answers vary run to run, so one run can flip a borderline scenario.
// Runs every scenario through each system and reports the tab 5 metrics.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MetaClient } from "@plumb/core";
import { claimKeys, Scenario, timeline } from "./scenario.js";
import { modelSystems, systems, type SystemRun } from "./systems.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const split = args.includes("--split") ? args[args.indexOf("--split") + 1] : "dev";
const verbose = args.includes("--verbose");
const withModel = args.includes("--model");
const runs = args.includes("--runs") ? Math.max(1, Number(args[args.indexOf("--runs") + 1]) || 1) : 1;

interface Tally {
  detect: [number, number]; // [flagged, should flag], directly broken claims
  chain: [number, number]; // [fell, should fall], chain claims
  falseOut: [number, number]; // [marked OUT, should be IN]
  review: [number, number]; // [really stale, sent to REVIEW]
  found: [number, number]; // [claims extraction produced, claims the texts state]
  extra: [number, number]; // [extracted claims no key asked for, texts]
  extras: string[]; // their text, to judge noise by reading
  flagMs: number[];
  scenariosPassed: number;
  scenarios: number;
  exactPerRun: number[];
  skipped: string[];
  failures: string[];
}

const empty = (): Tally => ({
  detect: [0, 0],
  chain: [0, 0],
  falseOut: [0, 0],
  review: [0, 0],
  found: [0, 0],
  extra: [0, 0],
  extras: [],
  flagMs: [],
  scenariosPassed: 0,
  scenarios: 0,
  exactPerRun: [],
  skipped: [],
  failures: [],
});

async function loadScenarios(): Promise<Scenario[]> {
  const dir = join(root, "scenarios");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const all = await Promise.all(
    files.map(async (f) => {
      const parsed = Scenario.safeParse(JSON.parse(await readFile(join(dir, f), "utf8")));
      if (!parsed.success) throw new Error(`${f}: ${parsed.error.message}`);
      return parsed.data;
    }),
  );
  return all.filter((s) => split === "all" || s.split === split);
}

function score(s: Scenario, run: SystemRun, t: Tally) {
  t.scenarios++;
  const expected = new Map(claimKeys(s).map((k) => [k, "IN"]));
  const chainKeys = new Set<string>();
  let passed = true;
  const stepAt = new Map(timeline(s).map((step) => [step.key, Date.parse(step.at)]));
  const lastTextAt = Math.max(...s.texts.map((x) => Date.parse(x.at)), -Infinity);

  for (const cp of s.expected) {
    for (const [k, v] of Object.entries(cp.status)) expected.set(k, v);
    cp.chain.forEach((k) => chainKeys.add(k));
    const actual = run.statusAfter.get(cp.after)!;

    for (const [key, want] of expected) {
      const raw = actual.get(key) ?? "IN";
      // A claim from a text that hasn't happened yet can't exist yet.
      if (raw === "MISSING" && want === "IN" && stepAt.get(cp.after)! < lastTextAt) continue;
      if (raw !== want) {
        passed = false;
        t.failures.push(`${s.id} after ${cp.after}: "${key}" expected ${want}, got ${raw}`);
      }
      // A claim extraction never produced can't be flagged or wrongly retracted;
      // it counts as missed in the extraction line instead.
      const got = raw === "MISSING" ? "IN" : raw;
      if (want === "IN") {
        t.falseOut[1]++;
        if (got === "OUT") t.falseOut[0]++;
      } else if (chainKeys.has(key)) {
        t.chain[1]++;
        if (got === "OUT") t.chain[0]++;
      } else {
        t.detect[1]++;
        if (got !== "IN") t.detect[0]++;
      }
      if (got === "REVIEW") {
        t.review[1]++;
        if (want !== "IN") t.review[0]++;
      }
    }
  }
  if (run.extraction) {
    t.found[0] += run.extraction.found;
    t.found[1] += run.extraction.keys;
    t.extra[0] += run.extraction.extracted - run.extraction.found;
    t.extra[1] += run.extraction.texts;
    t.extras.push(...run.extraction.extras.map((x) => `${s.id}: ${x}`));
  }
  t.flagMs.push(...run.flagMs);
  if (passed) t.scenariosPassed++;
}

const pct = ([n, d]: [number, number]) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`);
const median = (xs: number[]) => {
  if (xs.length === 0) return "n/a";
  const sorted = [...xs].sort((a, b) => a - b);
  const ms = sorted[Math.floor(sorted.length / 2)]!;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
};

const scenarios = await loadScenarios();
const report: Record<string, unknown> = { at: new Date().toISOString(), split, scenarios: scenarios.map((s) => s.id) };

const models = withModel ? modelSystems(new MetaClient()) : {};
const all = { ...systems, ...models };
report.systems = Object.keys(all);
report.runs = runs;

for (const [name, system] of Object.entries(all)) {
  const t = empty();
  // Plain-code systems give the same answer every time; only model systems repeat.
  const times = name in models ? runs : 1;
  for (let r = 0; r < times; r++) {
    const before = t.scenariosPassed;
    for (const s of scenarios) {
      const run = await system(s);
      if (run) score(s, run, t);
      else if (r === 0) t.skipped.push(s.id);
    }
    t.exactPerRun.push(t.scenariosPassed - before);
  }
  report[name] = t;
  const skipped = t.skipped.length ? `, skipped ${t.skipped.length} (${t.skipped.join(", ")})` : "";
  const perRun = t.scenarios / times;
  const exact = times > 1 ? `exact per run ${t.exactPerRun.join(", ")} of ${perRun}` : `${t.scenariosPassed}/${t.scenarios} scenarios exact`;
  console.log(`\n${name}: ${exact}${skipped}`);
  console.log(`  detection recall      ${pct(t.detect)}`);
  console.log(`  chain recall          ${pct(t.chain)}`);
  console.log(`  false retraction rate ${pct(t.falseOut)}`);
  console.log(`  REVIEW precision      ${pct(t.review)}`);
  console.log(`  time to flag (median) ${median(t.flagMs)}`);
  if (t.found[1] > 0) {
    console.log(`  extraction found      ${pct(t.found)}`);
    console.log(`  extra claims per text ${(t.extra[0] / t.extra[1]).toFixed(1)} (${t.extra[0]} over ${t.extra[1]} texts)`);
  }
  if (verbose || name.startsWith("plumb")) t.failures.forEach((f) => console.log(`  FAIL ${f}`));
  if (verbose) t.extras.forEach((x) => console.log(`  EXTRA ${x}`));
}

const outDir = join(root, "results");
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, `${split}-${randomUUID().slice(0, 8)}.json`);
await writeFile(outFile, JSON.stringify(report, null, 2));
console.log(`\nWrote ${outFile}`);
