import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { listClaudeSessions, readClaudeSession } from "../src/readers/claude-code.js";
import { isPlumbSlug, listCursorSessions, readCursorSession } from "../src/readers/cursor.js";
import { listMuseSessions, readMuseSession } from "../src/readers/muse.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fx = (...parts: string[]) => resolve(testDir, "fixtures", ...parts);

describe("claude reader", () => {
  it("lists sessions with the hook's session id", () => {
    const sessions = listClaudeSessions(fx("claude"));
    expect(sessions.map((s) => s.externalId).sort()).toEqual([
      "aaaa1111-2222-3333-4444-555555555555",
      "bbbb2222-3333-4444-5555-666666666666",
    ]);
  });

  it("reads labeled turns, title and cwd, skipping junk rows", () => {
    const { turns, title, workdir } = readClaudeSession(
      fx("claude/-fake-plumb/aaaa1111-2222-3333-4444-555555555555.jsonl"),
    );
    expect(turns).toEqual(["Usman:\nCheck the login page", "Claude Code:\nLogin looks fine"]);
    expect(title).toBe("Login check");
    expect(workdir).toBe("/fake/plumb");
  });

  it("returns no title when the history has none", () => {
    const { title } = readClaudeSession(fx("claude/-fake-other/bbbb2222-3333-4444-5555-666666666666.jsonl"));
    expect(title).toBeUndefined();
  });

  it("lists nothing when history is missing", () => {
    expect(listClaudeSessions(fx("claude-missing"))).toEqual([]);
  });
});

describe("cursor reader", () => {
  it("lists transcripts with the jsonl basename id, skipping compaction", () => {
    const sessions = listCursorSessions(fx("cursor"));
    expect(sessions.map((s) => s.externalId).sort()).toEqual([
      "cccc3333-4444-5555-6666-777777777777",
      "dddd4444-5555-6666-7777-888888888888",
    ]);
    expect(sessions[0]!.slug).toContain("fake-plumb");
  });

  it("reads labeled turns and skips tool parts", () => {
    const { turns } = readCursorSession(
      fx("cursor/Users-someone-fake-plumb/agent-transcripts/cccc3333-4444-5555-6666-777777777777.jsonl"),
    );
    expect(turns).toEqual(["Usman:\nAdd a logout button", "Cursor:\nLogout added"]);
  });

  it("matches plumb slugs by decoded path suffix", () => {
    expect(isPlumbSlug("Users-someone-fake-plumb", "/fake/plumb")).toBe(true);
    expect(isPlumbSlug("Users-someone-fake-other", "/fake/plumb")).toBe(false);
    expect(isPlumbSlug("Users-someone-my-plumb-notes", "/fake/plumb")).toBe(false);
  });

  it("lists nothing when history is missing", () => {
    expect(listCursorSessions(fx("cursor-missing"))).toEqual([]);
  });
});

describe("muse reader", () => {
  it("lists sessions with the session UUID", () => {
    const sessions = listMuseSessions(fx("muse"));
    expect(sessions.map((s) => s.externalId).sort()).toEqual([
      "ffff5555-6666-7777-8888-999999999999",
      "gggg6666-7777-8888-9999-aaaaaaaaaaaa",
    ]);
  });

  it("reads user intents and committed assistant messages plus the workspace root", () => {
    const { turns, workdir } = readMuseSession(
      fx("muse/2026/10/28/ffff5555-6666-7777-8888-999999999999/session.jsonl"),
    );
    expect(turns).toEqual(["Usman:\nReview the auth diff", "Muse Code:\nAuth looks good"]);
    expect(workdir).toBe("/fake/plumb");
  });

  it("lists nothing when history is missing", () => {
    expect(listMuseSessions(fx("muse-missing"))).toEqual([]);
  });
});
