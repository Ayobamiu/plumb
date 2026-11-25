// Cheap cross-tool read (Nov 25, claims suspended): what get_context hands
// another tool, and how find_context reads the user's words. Plain code, no
// model call: the tool asking (Claude, Cursor) is the model that picks.
import type { Event, Source, SourceKind } from "../contract.js";
import { contextName } from "./context.js";

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.PLUMB_TZ ?? "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

const MAX_EVENTS = 10;

/** Title, summary, recent turns. Events list what happened for emails and docs (no digest there). */
export function renderSessionContext(input: { source: Source; lastAt: string; events: Event[] }): string {
  const { source, lastAt } = input;
  const what = source.kind === "gmail_thread" ? "email thread" : source.kind === "doc" ? "doc" : "session";
  const lines = [`# ${contextName(source, lastAt)}`, "", `From Plumb: this ${what} as last saved. Last active ${when(lastAt)}.`];
  const summary = source.summary?.replace(/\s+/g, " ").trim();
  if (summary) lines.push("", "## Summary", "", summary);
  const happened = input.events
    .filter((e) => e.kind !== "clock" && !e.summary.startsWith("...") && e.summary.trim() !== summary)
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))
    .slice(-MAX_EVENTS);
  if (happened.length > 1 || (happened.length === 1 && !source.digest)) {
    lines.push("", "## What happened", "", ...happened.map((e) => `- ${when(e.occurred_at)}: ${e.summary.replace(/\s+/g, " ").trim()}`));
  }
  if (source.digest?.trim()) {
    lines.push("", "## Recent turns (oldest first, earlier turns left out)", "", source.digest.trim());
  }
  if (!summary && !happened.length && !source.digest?.trim()) lines.push("", "Plumb has nothing recorded from it yet.");
  return lines.join("\n");
}

// Words that carry no topic (same spirit as search.ts STOP, plus time words:
// "last week" is the caller's job, via recent_work or the dates shown).
const STOP = new Set(
  "a an and about any are as at be by can did do does for from get give had has have how i in is it its last me my of on or our that the this to was we were what when where which who why with yesterday today tonight week weeks month ago thing stuff session sessions chat chats work worked working earlier recent recently please find show".split(" "),
);

export interface ParsedQuery {
  words: string[]; // topic words for full-text search
  kinds?: SourceKind[]; // when the user named a tool
}

/** Split the user's words into a tool filter and topic words. Ambiguous words ("code") stay topic words. */
export function parseSearchQuery(query: string): ParsedQuery {
  let q = ` ${query.toLowerCase().replace(/[^a-z0-9.\s-]+/g, " ")} `;
  const kinds = new Set<SourceKind>();
  const take = (re: RegExp, k: SourceKind[]) => {
    if (re.test(q)) {
      k.forEach((x) => kinds.add(x));
      q = q.replace(re, " ");
    }
  };
  take(/\bclaude[\s-]?code\b/g, ["claude_code"]);
  take(/\bclaude(\.ai|[\s-]?chat)\b/g, ["claude_chat"]);
  take(/\bclaude\b/g, ["claude_code", "claude_chat"]);
  take(/\bcursor\b/g, ["cursor"]);
  take(/\bmuse[\s-]?code\b|\bmuse\b/g, ["muse_code"]);
  take(/(^|\s)(gmail|e-?mails?|inbox)(?=\s)/g, ["gmail_thread"]);
  take(/\b(google\s+)?docs?\b|\bdocument\b/g, ["doc"]);
  const words = [...new Set(q.split(/[^a-z0-9-]+/).filter((w) => w.length > 1 && !STOP.has(w)))];
  return { words, ...(kinds.size && { kinds: [...kinds] }) };
}
