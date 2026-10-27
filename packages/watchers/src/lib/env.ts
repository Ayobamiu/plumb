/** Shared env helpers for watchers. Never log secret values. */

export function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Base URL of the MCP HTTP server (no trailing slash, no /mcp). */
export function plumbApiBase(): string {
  const explicit = process.env.PLUMB_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const ingest = process.env.PLUMB_INGEST_URL?.trim();
  if (ingest) return ingest.replace(/\/ingest\/?$/, "");
  const mcp = process.env.PLUMB_MCP_URL?.trim();
  if (mcp) return mcp.replace(/\/mcp\/?$/, "");
  throw new Error("Set PLUMB_API_URL, PLUMB_INGEST_URL, or PLUMB_MCP_URL");
}

export function watcherToken(): string {
  return requireEnv("PLUMB_TOKEN_WATCHERS");
}
