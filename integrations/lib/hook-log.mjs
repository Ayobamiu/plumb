/**
 * One-line local log for Cursor hooks (stderr is easy to miss).
 * Writes under repo logs/cursor-hooks.log (gitignored via logs/).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "./plumb-env.mjs";

export function hookLog(hookName, fields = {}) {
  const dir = resolve(repoRoot(), "logs");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "cursor-hooks.log");
  const parts = [
    new Date().toISOString(),
    hookName,
    ...Object.entries(fields).map(([k, v]) => {
      const s =
        v === undefined || v === null
          ? ""
          : typeof v === "string"
            ? v
            : JSON.stringify(v);
      return `${k}=${String(s).replace(/\s+/g, " ").slice(0, 200)}`;
    }),
  ];
  try {
    appendFileSync(path, parts.join(" ") + "\n", "utf8");
  } catch {
    /* never break the agent for logging */
  }
  return path;
}
