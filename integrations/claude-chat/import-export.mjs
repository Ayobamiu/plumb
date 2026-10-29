#!/usr/bin/env node
/**
 * Import a Claude.ai data export into Plumb (index mode).
 *
 * Anthropic's export email download link requires you to be signed in
 * (privacy.claude.com: "You must be signed in to your account to download").
 * So the Gmail watcher cannot fetch the zip unattended. Download the file in a
 * browser while signed in, then run this script on the zip or conversations.json.
 *
 * Usage (from repo root):
 *   node integrations/claude-chat/import-export.mjs ~/Downloads/data-YYYY-MM-DD-….zip
 *   node integrations/claude-chat/import-export.mjs ./conversations.json
 *   node integrations/claude-chat/import-export.mjs ./export.zip --dry
 *   node integrations/claude-chat/import-export.mjs ./export.zip --limit 20
 */
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, basename, extname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { loadRootEnv } from "../lib/plumb-env.mjs";
import { ingestText } from "../lib/ingest.mjs";
import { hookLog } from "../lib/hook-log.mjs";

loadRootEnv();

const args = process.argv.slice(2);
const pathArg = args.find((a) => !a.startsWith("--"));
const dry = args.includes("--dry");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

if (!pathArg) {
  console.error(
    "Usage: node integrations/claude-chat/import-export.mjs <export.zip|conversations.json>",
  );
  process.exit(1);
}

const inputPath = resolve(pathArg);
if (!existsSync(inputPath)) {
  console.error("File not found:", inputPath);
  process.exit(1);
}

const token =
  process.env.PLUMB_TOKEN_CLAUDE_CHAT || process.env.PLUMB_INGEST_TOKEN;
if (!token && !dry) {
  console.error("PLUMB_TOKEN_CLAUDE_CHAT is not set");
  process.exit(1);
}

function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (p?.type === "text" && p.text) return p.text;
      if (typeof p?.text === "string") return p.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Turn one Claude.ai conversation object into labeled User:/Claude chat: text. */
function labeledFromConversation(conv) {
  const messages =
    conv.chat_messages || conv.messages || conv.chatMessages || [];
  const turns = [];
  for (const m of messages) {
    const role = (m.sender || m.role || "").toLowerCase();
    const text =
      textFromContent(m.content) ||
      (typeof m.text === "string" ? m.text.trim() : "");
    if (!text) continue;
    if (role === "human" || role === "user") turns.push(`User:\n${text}`);
    else if (role === "assistant" || role === "claude")
      turns.push(`Claude chat:\n${text}`);
  }
  return turns.join("\n\n");
}

function findConversationsJson(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of readdirSync(cur)) {
      const p = resolve(cur, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (name === "conversations.json") return p;
    }
  }
  return null;
}

function loadConversations(filePath) {
  const ext = extname(filePath).toLowerCase();
  let jsonPath = filePath;
  let tmp = null;
  if (ext === ".zip") {
    tmp = mkdtempSync(resolve(tmpdir(), "plumb-claude-export-"));
    try {
      execFileSync("unzip", ["-qo", filePath, "-d", tmp], { stdio: "pipe" });
    } catch (err) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw new Error(
        `unzip failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    jsonPath = findConversationsJson(tmp);
    if (!jsonPath) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw new Error("conversations.json not found in zip");
    }
  }

  const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
  const list = Array.isArray(raw)
    ? raw
    : raw.conversations || raw.chats || [];
  if (tmp) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  return list;
}

let conversations;
try {
  conversations = loadConversations(inputPath);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log(
  `loaded ${conversations.length} conversations from ${basename(inputPath)} (index mode)`,
);

let ok = 0;
let skip = 0;
let fail = 0;
let n = 0;

for (const conv of conversations) {
  if (n >= limit) break;
  n++;
  const id = String(
    conv.uuid || conv.id || conv.conversation_id || `chat-${n}`,
  ).slice(0, 120);
  const title = (conv.name || conv.title || "").trim().slice(0, 200);
  const text = labeledFromConversation(conv);
  if (!text.trim()) {
    skip++;
    console.log("skip empty", id, title || "(no title)");
    continue;
  }
  console.log(
    dry ? "dry" : "index",
    id,
    title || "(untitled)",
    `${text.length} chars`,
  );
  if (dry) {
    skip++;
    continue;
  }
  try {
    await ingestText({
      text,
      sourceKind: "claude_chat",
      externalId: id,
      ...(title ? { title } : {}),
      token,
      indexOnly: true,
    });
    hookLog("import-export", {
      event: "ok",
      conversation_id: id,
      chars: String(text.length),
    });
    ok++;
  } catch (err) {
    fail++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error("fail", id, msg);
    hookLog("import-export", { event: "error", conversation_id: id, err: msg });
  }
}

console.log(JSON.stringify({ ok, skip, fail, scanned: n, mode: "index" }));
process.exit(fail ? 1 : 0);
