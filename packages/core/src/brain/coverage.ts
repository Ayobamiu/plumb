// Coverage check (plan step 5, Oct 28, Usman OK'd): per tool, when Plumb last
// saved something from it, so a gap shows before a search comes back empty.
// Counts every project: index mode saves sessions that belong to none.
import type { SourceKind } from "../contract.js";
import type { ToolCoverage } from "../tools.js";
import { toolLabel } from "./context.js";
import { formatTime } from "./explain.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const COVERAGE_DAYS = 90; // how far back "last saved" looks
const RECENT_DAYS = 7;
// A tool that has saved before but not for this long is flagged. Docs change
// rarely, and notes are typed by hand, so neither is ever flagged.
const STALE_DAYS: Partial<Record<SourceKind, number>> = { claude_code: 2, cursor: 2, claude_chat: 2, muse_code: 2, gmail_thread: 2 };
const ORDER: SourceKind[] = ["claude_code", "cursor", "muse_code", "claude_chat", "gmail_thread", "doc", "manual"];

/** One row per tool, from (source kind, time saved) pairs: events observed and claims recorded. */
export function computeCoverage(saves: { kind: SourceKind; source_id: string; at: string }[], now: string): ToolCoverage[] {
  const nowMs = Date.parse(now);
  return ORDER.map((kind) => {
    const mine = saves.filter((s) => s.kind === kind);
    const last = mine.reduce<string | undefined>((a, s) => (!a || Date.parse(s.at) > Date.parse(a) ? s.at : a), undefined);
    const recent = new Set(mine.filter((s) => nowMs - Date.parse(s.at) <= RECENT_DAYS * DAY_MS).map((s) => s.source_id));
    const limit = STALE_DAYS[kind];
    const stale = !!last && limit !== undefined && nowMs - Date.parse(last) > limit * DAY_MS;
    return { kind, tool: toolLabel(kind), ...(last && { last_saved_at: last }), sources_7d: recent.size, stale };
  });
}

const UNITS: Partial<Record<SourceKind, [string, string]>> = { gmail_thread: ["thread", "threads"], doc: ["doc", "docs"], manual: ["note", "notes"] };

const ago = (from: string, now: string) => {
  const days = Math.floor((Date.parse(now) - Date.parse(from)) / DAY_MS);
  return days === 1 ? "1 day" : `${days} days`;
};

/** The block for PROJECT_STATE.md: a warning line for stale tools, then one line per tool. */
export function renderCoverage(rows: ToolCoverage[], now: string): string[] {
  const stale = rows.filter((r) => r.stale);
  const lines = ["## Saving from your tools (all projects)", ""];
  if (stale.length) {
    lines.push(`Not saved lately: ${stale.map((r) => `${r.tool} (${ago(r.last_saved_at!, now)})`).join(", ")}. Its hook or watcher may have stopped; run the local sync or check it.`, "");
  }
  for (const r of rows) {
    if (!r.last_saved_at) {
      if (r.kind !== "manual") lines.push(`- ${r.tool}: nothing saved yet`);
      continue;
    }
    const n = r.sources_7d;
    const unit = UNITS[r.kind] ?? ["session", "sessions"];
    lines.push(`- ${r.tool}: last saved ${formatTime(r.last_saved_at)}, ${n} ${unit[n === 1 ? 0 : 1]} saved in the last 7 days`);
  }
  return lines;
}
