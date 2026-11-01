/**
 * Gmail watcher: poll users.history.list every 60s from the last stored historyId.
 * Emits email_received / email_sent via record_event. Never stores full bodies.
 *
 * Cursor rules (from Claude Code's migration notes):
 * - First run: store users.getProfile historyId, do not replay old mail.
 * - Advance the cursor only after every message on the page was recorded
 *   (or skipped as missing/trash/draft).
 * - historyId 404 (~week old): reset to profile historyId and log it.
 * - message 404: skip and keep going so one deleted id cannot stall the cursor.
 */
import { fileURLToPath } from "node:url";
import { getCursor, getGmailRefreshToken, setCursor } from "./lib/supabase.js";
import { recordEvent } from "./lib/record-event.js";
import {
  getMessageMeta,
  getProfile,
  header,
  listHistory,
  refreshAccessToken,
  type AccessToken,
  type MessageMeta,
} from "./lib/gmail-api.js";

const POLL_MS = 60_000;
const CURSOR = "gmail";

let token: AccessToken | undefined;
let meEmail = "";

async function accessToken(refreshToken: string): Promise<string> {
  if (!token || Date.now() >= token.expires_at) {
    token = await refreshAccessToken(refreshToken);
  }
  return token.access_token;
}

function occurredAt(msg: MessageMeta): string {
  const ms = Number(msg.internalDate ?? Date.now());
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function summary(msg: MessageMeta): string {
  const subject = header(msg, "Subject")?.trim() || "(no subject)";
  const snippet = (msg.snippet ?? "").replace(/\s+/g, " ").trim();
  const text = snippet ? `${subject} - ${snippet}` : subject;
  return text.slice(0, 1000);
}

function kindFor(msg: MessageMeta): "email_received" | "email_sent" {
  const labels = msg.labelIds ?? [];
  if (labels.includes("SENT") && !labels.includes("INBOX")) return "email_sent";
  if (labels.includes("SENT") && meEmail) {
    const from = header(msg, "From") ?? "";
    if (from.toLowerCase().includes(meEmail.toLowerCase())) return "email_sent";
  }
  return "email_received";
}

async function recordMessage(msg: MessageMeta): Promise<void> {
  const threadId = msg.threadId;
  const from = header(msg, "From");
  await recordEvent({
    kind: kindFor(msg),
    source: {
      kind: "gmail_thread",
      external_id: threadId,
      title: header(msg, "Subject")?.slice(0, 200),
    },
    occurred_at: occurredAt(msg),
    from,
    thread_id: threadId,
    summary: summary(msg),
  });
}

/** Process one history page; returns the new historyId to store when done. */
async function processSince(access: string, startHistoryId: string): Promise<string> {
  let pageToken: string | undefined;
  let latest = startHistoryId;
  const seen = new Set<string>();

  for (;;) {
    const page = await listHistory(access, startHistoryId, pageToken);
    if (page.status === 404) {
      throw Object.assign(new Error("historyId expired"), { code: "HISTORY_EXPIRED" as const });
    }
    if (page.status !== 200 || !page.data) {
      throw new Error(`gmail history HTTP ${page.status}: ${(page.body ?? "").slice(0, 200)}`);
    }

    latest = page.data.historyId;
    const added = page.data.history ?? [];
    for (const entry of added) {
      for (const item of entry.messagesAdded ?? []) {
        const id = item.message.id;
        if (seen.has(id)) continue;
        seen.add(id);
        const got = await getMessageMeta(access, id);
        if (got.status === 404) {
          console.warn(`skip missing message id=${id} (404)`);
          continue;
        }
        if (got.status !== 200 || !got.data) {
          throw new Error(`gmail message ${id} HTTP ${got.status}: ${(got.body ?? "").slice(0, 200)}`);
        }
        const meta = got.data;
        // Skip drafts / trash noise.
        const labels = meta.labelIds ?? [];
        if (labels.includes("DRAFT") || labels.includes("TRASH")) continue;
        await recordMessage(meta);
        console.log(`recorded ${kindFor(meta)} thread=${meta.threadId} id=${id}`);
      }
    }

    pageToken = page.data.nextPageToken;
    if (!pageToken) break;
  }

  return latest;
}

async function tick(refreshToken: string): Promise<void> {
  const access = await accessToken(refreshToken);
  if (!meEmail) {
    const profile = await getProfile(access);
    meEmail = profile.emailAddress;
  }

  const stored = await getCursor(CURSOR);
  if (!stored) {
    const profile = await getProfile(access);
    await setCursor(CURSOR, profile.historyId);
    console.log(`first run: stored historyId ${profile.historyId} (no replay)`);
    return;
  }

  try {
    const next = await processSince(access, stored);
    if (next !== stored) {
      await setCursor(CURSOR, next);
      console.log(`cursor → ${next}`);
    } else {
      console.log("no new mail");
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "HISTORY_EXPIRED") {
      const profile = await getProfile(access);
      await setCursor(CURSOR, profile.historyId);
      console.warn(`historyId expired; reset to ${profile.historyId}`);
      return;
    }
    throw err;
  }
}

export async function startGmail(): Promise<void> {
  const refresh = await getGmailRefreshToken();
  if (!refresh) {
    throw new Error(
      "No Gmail refresh token in Vault. Visit http://localhost:3000/api/gmail/auth while pnpm dev:web is running, then retry.",
    );
  }

  console.log(`gmail watcher polling every ${POLL_MS / 1000}s`);
  for (;;) {
    try {
      await tick(refresh);
    } catch (err) {
      console.error("tick failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startGmail().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}