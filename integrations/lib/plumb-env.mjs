import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Load repo-root .env into process.env without overwriting existing keys. */
export function loadRootEnv() {
  const path = resolve(root, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function repoRoot() {
  return root;
}

export function apiBase() {
  const explicit = process.env.PLUMB_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const ingest = process.env.PLUMB_INGEST_URL?.trim();
  if (ingest) return ingest.replace(/\/ingest\/?$/, "");
  const mcp = process.env.PLUMB_MCP_URL?.trim();
  if (mcp) return mcp.replace(/\/mcp\/?$/, "");
  throw new Error("Set PLUMB_API_URL, PLUMB_INGEST_URL, or PLUMB_MCP_URL");
}

export function projectId() {
  const id = process.env.PLUMB_PROJECT_ID?.trim();
  if (!id) throw new Error("PLUMB_PROJECT_ID is not set");
  return id;
}
