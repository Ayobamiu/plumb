/**
 * Railway worker: Gmail poll + clock + sleep-time sweep + doc watcher.
 * Doc watcher starts only when PLUMB_DOCS_URL / PLUMB_DOCS_TOKEN / PLUMB_WATCH_DOCS are set.
 */
import { startClock } from "./clock.js";
import { startDocs } from "./docs.js";
import { startGmail } from "./gmail.js";
import { startSweep } from "./sweep.js";

async function main(): Promise<void> {
  console.log("plumb watchers worker starting (gmail + clock + sweep + docs)");
  await Promise.all([startGmail(), startClock(), startSweep(), startDocs()]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
