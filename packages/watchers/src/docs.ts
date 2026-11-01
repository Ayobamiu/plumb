/**
 * Doc watcher (tab 4): poll watched docs every few minutes.
 * On revision change, ingest each changed tab via /ingest (source kind "doc").
 * Do not call record_event: /ingest records doc_edited itself.
 *
 * First sighting of a doc: store cursor, no ingest (same as Gmail).
 * Cursor name: doc:<doc id>. Value: JSON { revision, tabs: { tabId: hash } }.
 * Advance the cursor only after every changed tab was ingested.
 *
 * Needs PLUMB_DOCS_URL + PLUMB_DOCS_TOKEN (docs MCP reachable from this host)
 * and PLUMB_WATCH_DOCS (comma-separated doc ids).
 * Optional PLUMB_DOCS_SKIP_TABS: comma-separated tab titles or tab ids to never
 * ingest. Skipped tabs still advance their stored hash (no replay on un-skip).
 */
import { fileURLToPath } from "node:url";
import {
  docsConfigured,
  listDocuments,
  readDocument,
  tabBodyHash,
  type DocRead,
  type DocTab,
} from "./lib/docs-api.js";
import { ingestText } from "./lib/ingest.js";
import { getCursor, setCursor } from "./lib/supabase.js";

const POLL_MS = 3 * 60_000; // every 3 minutes

type DocCursor = {
  revision: number;
  tabs: Record<string, string>; // tab id → body hash
};

function watchIds(): string[] {
  const raw = process.env.PLUMB_WATCH_DOCS?.trim() ?? "";
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tab titles or ids that must not be sent to /ingest. */
function skipTabs(): Set<string> {
  const raw = process.env.PLUMB_DOCS_SKIP_TABS?.trim() ?? "";
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function isSkipped(tab: DocTab, skip: Set<string>): boolean {
  return skip.has(tab.id) || skip.has(tab.title);
}

function cursorName(docId: string): string {
  return `doc:${docId}`;
}

function parseCursor(raw: string | null): DocCursor | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { revision?: unknown; tabs?: unknown };
    if (typeof j.revision !== "number") return null;
    const tabs: Record<string, string> = {};
    if (j.tabs && typeof j.tabs === "object") {
      for (const [k, v] of Object.entries(j.tabs as Record<string, unknown>)) {
        if (typeof v === "string") tabs[k] = v;
      }
    }
    return { revision: j.revision, tabs };
  } catch {
    // Legacy: plain revision number
    const n = Number(raw);
    return Number.isFinite(n) ? { revision: n, tabs: {} } : null;
  }
}

function encodeCursor(c: DocCursor): string {
  return JSON.stringify(c);
}

function hashesFrom(doc: DocRead): Record<string, string> {
  const tabs: Record<string, string> = {};
  for (const t of doc.tabs) tabs[t.id] = tabBodyHash(t.body);
  return tabs;
}

async function tickDoc(docId: string, listedRevision: number, listedTitle: string): Promise<void> {
  const name = cursorName(docId);
  const prev = parseCursor(await getCursor(name));

  if (!prev) {
    // First run: read once to seed tab hashes, store, do not ingest.
    const doc = await readDocument(docId);
    await setCursor(name, encodeCursor({ revision: doc.revision, tabs: hashesFrom(doc) }));
    console.log(`docs: first sight ${doc.title} (${docId}) rev=${doc.revision}, no ingest`);
    return;
  }

  if (prev.revision === listedRevision) return;

  const doc = await readDocument(docId);
  const nextHashes = hashesFrom(doc);
  const changed = doc.tabs.filter((t) => prev.tabs[t.id] !== nextHashes[t.id]);

  if (changed.length === 0) {
    // Revision bumped (rename, etc.) but no body change we track.
    await setCursor(name, encodeCursor({ revision: doc.revision, tabs: nextHashes }));
    console.log(`docs: ${listedTitle} rev ${prev.revision}→${doc.revision}, no tab body change`);
    return;
  }

  const skip = skipTabs();
  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  // Per-tab: only advance a tab's hash after a successful ingest (or skip).
  // Keep prev.revision if any ingest failed so the next poll retries those tabs.
  const hashes: Record<string, string> = { ...prev.tabs };
  for (const tab of changed) {
    if (isSkipped(tab, skip)) {
      skipped += 1;
      hashes[tab.id] = nextHashes[tab.id]!;
      console.log(`docs: skip ingest ${doc.title}: ${tab.title} (PLUMB_DOCS_SKIP_TABS)`);
      continue;
    }
    if (!tab.body.trim()) {
      hashes[tab.id] = nextHashes[tab.id]!;
      continue;
    }
    try {
      await ingestText({
        text: tab.body,
        sourceKind: "doc",
        externalId: `${doc.id}#${tab.id}`,
        title: `${doc.title}: ${tab.title}`,
      });
      hashes[tab.id] = nextHashes[tab.id]!;
      ingested += 1;
      console.log(`docs: ingested ${doc.title}: ${tab.title}`);
    } catch (err) {
      failed += 1;
      console.error(
        `docs: ingest failed ${doc.title}: ${tab.title}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (failed > 0) {
    // Advance successful/skipped tab hashes only; leave revision so we re-check.
    await setCursor(name, encodeCursor({ revision: prev.revision, tabs: hashes }));
    console.log(
      `docs: partial ${doc.id} (ingested ${ingested}, skipped ${skipped}, failed ${failed}); will retry failed tabs`,
    );
    return;
  }

  await setCursor(name, encodeCursor({ revision: doc.revision, tabs: hashes }));
  console.log(
    `docs: cursor → ${doc.id} rev=${doc.revision} (changed ${changed.length}, ingested ${ingested}, skipped ${skipped})`,
  );
}

async function tick(): Promise<void> {
  const ids = new Set(watchIds());
  if (ids.size === 0) {
    console.error("docs: PLUMB_WATCH_DOCS is empty; nothing to watch");
    return;
  }
  const listed = await listDocuments();
  for (const entry of listed) {
    if (!ids.has(entry.id)) continue;
    try {
      await tickDoc(entry.id, entry.revision, entry.title);
    } catch (err) {
      console.error(
        `docs: failed ${entry.title} (${entry.id}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export async function startDocs(): Promise<void> {
  if (!docsConfigured()) {
    console.log(
      "docs watcher skipped: set PLUMB_DOCS_URL and PLUMB_DOCS_TOKEN (docs MCP must be reachable from this host)",
    );
    return;
  }
  if (watchIds().length === 0) {
    console.log("docs watcher skipped: set PLUMB_WATCH_DOCS to a comma-separated list of doc ids");
    return;
  }

  const skip = [...skipTabs()];
  console.log(
    `docs watcher polling every ${POLL_MS / 1000}s for ${watchIds().length} doc(s)` +
      (skip.length ? `; skip tabs: ${skip.join(", ")}` : ""),
  );
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("docs tick failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startDocs().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
