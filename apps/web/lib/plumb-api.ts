/** MCP HTTP API base (no trailing /mcp or /ingest). */
export function plumbApiBase(): string | null {
  const explicit = process.env.PLUMB_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const ingest = process.env.PLUMB_INGEST_URL?.trim();
  if (ingest) return ingest.replace(/\/ingest\/?$/, "");
  const mcp = process.env.PLUMB_MCP_URL?.trim();
  if (mcp) return mcp.replace(/\/mcp\/?$/, "");
  return null;
}

export function plumbWebToken(): string | undefined {
  return process.env.PLUMB_MCP_TOKEN || process.env.PLUMB_TOKEN_WEB || undefined;
}
