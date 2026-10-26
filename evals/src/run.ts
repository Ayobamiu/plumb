// Eval runner. Usage: pnpm eval [--split dev|heldout|all] [--verbose]
// Runs every scenario through each system and reports the tab 5 metrics.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Scenario } from "./scenario.js";
import { systems, type SystemRun } from "./systems.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const split = args.includes("--split") ? args[args.indexOf("--split") + 1] : "dev";
const verbose = args.includes("--verbose");

interface Tally {
  detect: [number, number]; // [flagged, should flag], directly broken claims
  chain: [number, number]; // [fell, should fall], chain claims
  falseOut: [number, number]; // [marked OUT, should be IN]
  review: [number, number]; // [really stale, sent to REVIEW]
  scenariosPassed: number;
  scenarios: number;
  failures: string[];
}

const empty = (): Tally => ({
  detect: [0, 0],
  chain: [0, 0],
  falseOut: [0, 0],
  review: [0, 0],
  scenariosPassed: 0,
  scenarios: 0,
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
  const expected = new Map(s.claims.map((c) => [c.temp_id, "IN"]));
  const chainKeys = new Set<string>();
  let passed = true;

  for (const cp of s.expected) {
    for (const [k, v] of Object.entries(cp.status)) expected.set(k, v);
    cp.chain.forEach((k) => chainKeys.add(k));
    const actual = run.statusAfter.get(cp.after)!;

    for (const [key, want] of expected) {
      const got = actual.get(key) ?? "IN";
      if (got !== want) {
        passed = false;
        t.failures.push(`${s.id} after ${cp.after}: "${key}" expected ${want}, got ${got}`);
      }
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
  if (passed) t.scenariosPassed++;
}

const pct = ([n, d]: [number, number]) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`);

const scenarios = await loadScenarios();
const report: Record<string, unknown> = { at: new Date().toISOString(), split, scenarios: scenarios.map((s) => s.id) };

for (const [name, system] of Object.entries(systems)) {
  const t = empty();
  for (const s of scenarios) score(s, await system(s), t);
  report[name] = t;
  console.log(`\n${name}: ${t.scenariosPassed}/${t.scenarios} scenarios exact`);
  console.log(`  detection recall      ${pct(t.detect)}`);
  console.log(`  chain recall          ${pct(t.chain)}`);
  console.log(`  false retraction rate ${pct(t.falseOut)}`);
  console.log(`  REVIEW precision      ${pct(t.review)}`);
  if (verbose || name === "plumb") t.failures.forEach((f) => console.log(`  FAIL ${f}`));
}

const outDir = join(root, "results");
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, `${split}-${randomUUID().slice(0, 8)}.json`);
await writeFile(outFile, JSON.stringify(report, null, 2));
console.log(`\nWrote ${outFile}`);
