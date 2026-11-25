/**
 * Pull-first: session saves are index-only unless full extract is opted in.
 * Set PLUMB_FULL_EXTRACT=1, or list project ids in PLUMB_FULL_EXTRACT_PROJECTS.
 */
export function wantFullExtract(projectId) {
  if (process.env.PLUMB_FULL_EXTRACT === "1") return true;
  const allow = (process.env.PLUMB_FULL_EXTRACT_PROJECTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (projectId && allow.includes(projectId)) return true;
  return false;
}
