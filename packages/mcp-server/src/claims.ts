// Claims switch (Nov 25, Usman: "suspend the claims for now"). With
// PLUMB_CLAIMS=0 nothing claims-related runs: no extraction (every /ingest is
// index-only), no clock or sweep work, no invalidation on record_event, and the
// read tools (find_context, get_context, recent_work) read sources only.
// The tables and code stay; unset it (or set 1) to turn claims back on.
export function claimsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLUMB_CLAIMS !== "0";
}

// Index-only ingest with no client summary: Muse Spark or the free local index
// (title + excerpt). PLUMB_MUSE_INDEX=1/0 decides; unset, Muse only while claims are on.
export function museIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PLUMB_MUSE_INDEX === "1") return true;
  if (env.PLUMB_MUSE_INDEX === "0") return false;
  return claimsEnabled(env);
}
