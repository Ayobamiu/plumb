/**
 * Clock job every minute: emit a clock event so until-reasons can break.
 * record_event only persists the tick when something actually changes.
 */
import { recordEvent } from "./lib/record-event.js";

const INTERVAL_MS = 60_000;

async function tick(): Promise<void> {
  const now = new Date().toISOString();
  const result = await recordEvent({
    kind: "clock",
    source: { kind: "manual", external_id: "clock", title: "Clock" },
    occurred_at: now,
    summary: `clock ${now}`,
  });
  const transitions =
    result && typeof result === "object" && "transitions" in result
      ? (result as { transitions: unknown[] }).transitions
      : [];
  console.log(
    transitions.length > 0
      ? `clock: ${transitions.length} transition(s)`
      : "clock: nothing changed",
  );
}

async function main(): Promise<void> {
  console.log(`clock watcher every ${INTERVAL_MS / 1000}s`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("clock failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
