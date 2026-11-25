/**
 * Local session index for hook fallbacks (no model, no API keys).
 *
 * Preferred path: the in-session LLM (Claude Code plan, Cursor plan) indexes
 * via Plumb MCP record_event. Hooks use this only when the model did not.
 */
const HEAD_CHARS = 10_000;
const TAIL_CHARS = 30_000;
const TITLE_MAX = 80;
const SUMMARY_MAX = 600;

/** Same excerpt shape the old Muse index used. */
export function indexExcerpt(text) {
  const t = String(text ?? "").trim();
  if (t.length <= HEAD_CHARS + TAIL_CHARS) return t;
  return `${t.slice(0, HEAD_CHARS)}\n\n[... ${t.length - HEAD_CHARS - TAIL_CHARS} characters left out ...]\n\n${t.slice(-TAIL_CHARS)}`;
}

function cleanTitle(title) {
  return String(title ?? "")
    .replace(/["“”']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);
}

function cleanSummary(summary) {
  return String(summary ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUMMARY_MAX);
}

const PERSONAL_RE =
  /\b(gym|workout|knee|health|fitness|family|visa|opt|immigration|dentist|doctor|recipe|grocery|apartment|rent|dating|hobby|hobbies|travel|vacation)\b/i;

/** No-model index: searchable title + excerpt summary. Always succeeds. */
export function localIndex(text, { title, sourceKind } = {}) {
  const excerpt = indexExcerpt(text);
  const native = cleanTitle(title);
  let derived = native;
  if (!derived) {
    const userLine = excerpt
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^(User|Usman|Human)\s*:/i.test(l));
    if (userLine) {
      derived = cleanTitle(userLine.replace(/^(User|Usman|Human)\s*:/i, "").trim());
    }
  }
  if (!derived) {
    const first = excerpt.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
    derived = first || `${sourceKind || "session"} note`;
  }
  let summary = cleanSummary(excerpt);
  if (summary.length === SUMMARY_MAX) {
    const cut = summary.lastIndexOf(". ");
    if (cut > SUMMARY_MAX / 2) summary = summary.slice(0, cut + 1);
  }
  return {
    title: derived,
    summary: summary || derived,
    personal: PERSONAL_RE.test(excerpt),
    indexed_by: `local/${sourceKind || "session"}/index.v1`,
  };
}

/** @deprecated use localIndex; kept so ingest.mjs call sites stay clear. */
export async function hostIndex(text, opts = {}) {
  return localIndex(text, opts);
}
