// PROJECT_STATE.md (tab 1, "Generated state file"): the project state as
// plain markdown, for tools without MCP and for session-start context. Rendered
// on the server and returned by get_project_state as `markdown`, so every tool
// shows the same text. Same layout as the homepage: what changed, then IN claims by kind.
import type { z } from "zod";
import type { ClaimKind } from "../contract.js";
import type { GetProjectStateOutput } from "../tools.js";
import { formatTime } from "./explain.js";

type State = Omit<z.infer<typeof GetProjectStateOutput>, "markdown" | "summary">;
type Changed = State["changed_since"][number];

const KIND_ORDER: [ClaimKind, string][] = [
  ["goal", "Goals"],
  ["decision", "Decisions"],
  ["status", "Status"],
  ["next_step", "Next steps"],
  ["open_question", "Open questions"],
  ["fact", "Facts"],
];

/** Claims are plain sentences, but not all end with a period; the explanation follows, so add one. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

function changedLine(row: Changed, indent: string): string {
  const label = row.transition.to_status === "REVIEW" ? "REVIEW (waiting for Usman)" : row.transition.to_status;
  return `${indent}- ${label}: ${sentence(row.claim.text)} ${row.transition.explanation}`;
}

/** Changed claims newest first, with chain falls nested under the claim that knocked them down. */
function changedLines(rows: Changed[]): string[] {
  const listed = new Set(rows.map((r) => r.claim.id));
  const children = new Map<string, Changed[]>();
  const roots: Changed[] = [];
  for (const r of rows) {
    const cause = r.transition.cause_claim_id;
    if (r.transition.depth > 0 && cause && listed.has(cause)) children.set(cause, [...(children.get(cause) ?? []), r]);
    else roots.push(r);
  }
  const out: string[] = [];
  const walk = (r: Changed, depth: number, seen: Set<string>) => {
    out.push(changedLine(r, "  ".repeat(depth)));
    if (seen.has(r.claim.id)) return;
    seen.add(r.claim.id);
    for (const child of children.get(r.claim.id) ?? []) walk(child, depth + 1, seen);
  };
  for (const r of roots) walk(r, 0, new Set());
  return out;
}

export function renderProjectState(state: State, opts: { since: string; now: string }): string {
  const lines = [
    `# Project state: ${state.project.name}`,
    "",
    `Written by Plumb at ${formatTime(opts.now)}. Don't edit this file: it is rewritten at the start of each session. Claims marked REVIEW are waiting for Usman.`,
    "",
    `## Changed since ${formatTime(opts.since)}`,
    "",
    ...(state.changed_since.length ? changedLines(state.changed_since) : ["Nothing went OUT or to REVIEW."]),
  ];
  let any = false;
  for (const [kind, heading] of KIND_ORDER) {
    const claims = state.in_claims[kind] ?? [];
    if (claims.length === 0) continue;
    any = true;
    lines.push("", `## ${heading}`, "", ...claims.map((c) => `- ${c.text}`));
  }
  if (!any) lines.push("", "## Current claims", "", "None yet.");
  return lines.join("\n") + "\n";
}
