/**
 * Railway worker: Gmail poll + clock + sleep-time sweep + doc watcher.
 * Doc watcher starts only when PLUMB_DOCS_URL / PLUMB_DOCS_TOKEN / PLUMB_WATCH_DOCS are set.
 */
import { startClock } from "./clock.js";
import { startDocs } from "./docs.js";
import { startGmail } from "./gmail.js";
import { startSweep } from "./sweep.js";

async function main(): Promise<void> {
  // Claims suspended (PLUMB_CLAIMS=0, Nov 25): the clock and sweep only serve claims.
  const claims = process.env.PLUMB_CLAIMS !== "0";
  console.log(`plumb watchers worker starting (gmail + docs${claims ? " + clock + sweep" : "; claims suspended, no clock or sweep"})`);
  await Promise.all([startGmail(), startDocs(), ...(claims ? [startClock(), startSweep()] : [])]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
