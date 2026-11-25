// No-model session index and digest (Nov 25). The server's copy of Cursor's
// integrations/lib/host-index.mjs localIndex, so a client that sends raw text
// with no summary (the published CLI, older hooks) is still indexed without
// paying for a model call. Keep the two in step.

const HEAD_CHARS = 10_000;
const TAIL_CHARS = 30_000;
const TITLE_MAX = 80;
const SUMMARY_MAX = 600;
export const DIGEST_MAX = 20_000;

/** What the CLI puts first when it sends only the turns since its last save. */
export const CONTINUES_MARKER = "(This continues a session already saved; earlier turns are not shown.)";

export interface LocalIndex {
  title: string;
  summary: string;
  personal: boolean;
  indexed_by: string;
}

function indexExcerpt(text: string): string {
  const t = text.trim();
  if (t.length <= HEAD_CHARS + TAIL_CHARS) return t;
  return `${t.slice(0, HEAD_CHARS)}\n\n[... ${t.length - HEAD_CHARS - TAIL_CHARS} characters left out ...]\n\n${t.slice(-TAIL_CHARS)}`;
}

const cleanTitle = (title: string | undefined) =>
  String(title ?? "")
    .replace(/["“”']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);

const cleanSummary = (summary: string) => summary.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX);

const PERSONAL_RE =
  /\b(gym|workout|knee|health|fitness|family|visa|opt|immigration|dentist|doctor|recipe|grocery|apartment|rent|dating|hobby|hobbies|travel|vacation)\b/i;
const USER_LINE = /^(User|Usman|Human)\s*:/i;

/** Searchable title + excerpt summary from the text alone. Always succeeds. */
export function localIndex(text: string, opts: { title?: string; sourceKind?: string } = {}): LocalIndex {
  const excerpt = indexExcerpt(text.replace(CONTINUES_MARKER, ""));
  let title = cleanTitle(opts.title);
  if (!title) {
    const userLine = excerpt
      .split("\n")
      .map((l) => l.trim())
      .find((l) => USER_LINE.test(l));
    if (userLine) title = cleanTitle(userLine.replace(USER_LINE, "").trim());
  }
  if (!title) title = excerpt.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) || `${opts.sourceKind || "session"} note`;
  let summary = cleanSummary(excerpt);
  if (summary.length === SUMMARY_MAX) {
    const cut = summary.lastIndexOf(". ");
    if (cut > SUMMARY_MAX / 2) summary = summary.slice(0, cut + 1);
  }
  return {
    title,
    summary: summary || title,
    personal: PERSONAL_RE.test(excerpt),
    indexed_by: `local/${opts.sourceKind || "session"}/index.v1`,
  };
}

/**
 * The last turns of a session, at most DIGEST_MAX characters, starting on a
 * line boundary. Text that continues an earlier save is appended to the
 * stored digest; anything else replaces it (it is the whole session).
 */
export function sessionDigest(previous: string | undefined, text: string): string {
  const trimmed = text.trim();
  const continues = trimmed.startsWith(CONTINUES_MARKER);
  const fresh = continues ? trimmed.slice(CONTINUES_MARKER.length).trim() : trimmed;
  const all = continues && previous ? `${previous.trim()}\n\n${fresh}` : fresh;
  if (all.length <= DIGEST_MAX) return all;
  const tail = all.slice(-DIGEST_MAX);
  const nl = tail.indexOf("\n");
  return nl >= 0 && nl < 2_000 ? tail.slice(nl + 1) : tail;
}
