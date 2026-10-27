// "@ a session from any tool" (Oct 27): names, addresses and the distilled
// view of one source (a Claude Code session, a Cursor conversation, a Claude
// chat, a doc, an email thread). The view is what that source said and what of
// it is still true now: never the raw transcript, which Plumb doesn't store.
import type { Claim, Event, Source, SourceKind, Transition } from "../contract.js";
import { formatTime } from "./explain.js";

const TOOLS: Record<SourceKind, { slug: string; label: string; words: string[] }> = {
  claude_code: { slug: "claude-code", label: "Claude Code", words: ["claude", "code", "claude-code", "cc"] },
  cursor: { slug: "cursor", label: "Cursor", words: ["cursor"] },
  claude_chat: { slug: "claude-chat", label: "Claude chat", words: ["claude", "chat", "claude-chat"] },
  doc: { slug: "doc", label: "Doc", words: ["doc", "docs", "document"] },
  gmail_thread: { slug: "gmail", label: "Email", words: ["gmail", "email", "mail", "thread"] },
  manual: { slug: "notes", label: "Notes", words: ["notes", "note", "manual"] },
};

export const toolLabel = (kind: SourceKind) => TOOLS[kind].label;

// Placeholder titles hooks have sent. They don't name anything, so they never
// count as the tool's own title, and listings show a summary snippet instead.
const GENERIC_TITLES = new Set(["claude code session", "claude code turn", "cursor session", "cursor agent response", "cursor turn", "claude chat", "homepage notes"]);
export const isGenericTitle = (title: string | undefined) => !title?.trim() || GENERIC_TITLES.has(title.trim().toLowerCase());

/** The title to show: the real one, or else the start of the latest summary. */
export function displayTitle(title: string | undefined, latestSummary: string): string | undefined {
  if (!isGenericTitle(title)) return title!.trim();
  const snippet = latestSummary.replace(/^\.\.\./, "").replace(/\s+/g, " ").trim();
  if (!snippet) return undefined;
  return snippet.length > 60 ? `${snippet.slice(0, 57).replace(/\s+\S*$/, "")}...` : snippet;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "untitled";
}

/** cursor://auth-refactor-3f9a1c2d: tool, title slug, first 8 characters of the source id. */
export function contextUri(source: Source): string {
  return `${TOOLS[source.kind].slug}://${slugify(source.title ?? "")}-${source.id.slice(0, 8)}`;
}

/** The id prefix a context URI points at, or undefined if it isn't one. */
export function parseContextUri(uri: string): { tool: string; idPrefix: string } | undefined {
  const m = /^([a-z-]+):\/\/(?:.*-)?([0-9a-f]{8})$/i.exec(uri.trim());
  return m ? { tool: m[1]!.toLowerCase(), idPrefix: m[2]!.toLowerCase() } : undefined;
}

const day = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: process.env.PLUMB_TZ ?? "America/New_York", month: "short", day: "numeric" }).format(new Date(iso));

/** "Cursor: Auth refactor, login page next (Oct 27)" */
export function contextName(source: Source, lastAt: string): string {
  return `${toolLabel(source.kind)}: ${source.title?.trim() || "Untitled"} (${day(lastAt)})`;
}

/**
 * Every query word must match. A word that names a tool ("cursor", "email",
 * "claude") picks the tool; the other words must appear in the title or the
 * latest summary. So "cursor redeploy" doesn't return a Claude Code session
 * whose summary mentions Cursor.
 */
export function matchesQuery(source: Source, latestSummary: string, query: string): boolean {
  const toolWords = new Set(Object.values(TOOLS).flatMap((t) => t.words));
  const own = new Set(TOOLS[source.kind].words);
  const text = [source.title ?? "", latestSummary].join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 1)
    .every((w) => (toolWords.has(w) ? own.has(w) : text.includes(w)));
}

export interface ContextInput {
  source: Source;
  lastAt: string;
  events: Event[]; // this source's events (its summaries)
  claims: Claim[]; // claims written from this source
  latestTransition: Map<string, Transition>; // claim id -> its latest transition
  changedSince: { claim: Claim; transition: Transition }[]; // related claims that changed after lastAt
}

const MAX_SUMMARIES = 5;
const MAX_CLAIMS = 30;
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export function renderContext(input: ContextInput): string {
  const { source, lastAt } = input;
  const lines = [
    `# ${contextName(source, lastAt)}`,
    "",
    `From Plumb: what this ${source.kind === "gmail_thread" ? "email thread" : source.kind === "doc" ? "doc" : "session"} said, and what of it is still true now. Last active ${formatTime(lastAt)}.`,
  ];

  // Summaries starting "..." are raw-text fallbacks from before Oct 27 (a failed
  // extraction); they read as noise, so the view leaves them out.
  const summaries = [...input.events]
    .filter((e) => e.kind !== "clock" && !e.summary.startsWith("..."))
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))
    .slice(-MAX_SUMMARIES);
  // Summaries are one line each; a raw fallback summary can hold newlines and headings.
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  if (summaries.length) lines.push("", "## What happened", "", ...summaries.map((e) => `- ${formatTime(e.occurred_at)}: ${oneLine(e.summary)}`));

  const claims = [...input.claims].sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at)).slice(0, MAX_CLAIMS);
  const why = (c: Claim) => input.latestTransition.get(c.id)?.explanation ?? "";
  const groups: [string, Claim[], boolean][] = [
    ["Still true", claims.filter((c) => c.status === "IN"), false],
    ["No longer true", claims.filter((c) => c.status === "OUT"), true],
    ["Waiting for Usman's review", claims.filter((c) => c.status === "REVIEW"), true],
  ];
  for (const [heading, list, withWhy] of groups) {
    if (!list.length) continue;
    lines.push("", `## ${heading}`, "", ...list.map((c) => `- [${c.kind.replace("_", " ")}] ${withWhy ? `${sentence(c.text)} ${why(c)}`.trim() : c.text}`));
  }
  if (!claims.length && !summaries.length) lines.push("", "Plumb has nothing recorded from it yet.");

  if (input.changedSince.length) {
    lines.push(
      "",
      "## Changed since, elsewhere",
      "",
      ...input.changedSince.map(({ claim, transition }) => `- ${transition.to_status}: ${sentence(claim.text)} ${transition.explanation}`),
    );
  }
  return lines.join("\n") + "\n";
}
