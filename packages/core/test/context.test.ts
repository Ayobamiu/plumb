import { describe, expect, it } from "vitest";
import { contextName, contextUri, displayTitle, matchesQuery, parseContextUri, renderContext, type Claim, type Source, type Transition } from "../src/index.js";

const source: Source = { id: "3f9a1c2d-0000-4000-8000-000000000000", kind: "cursor", external_id: "conv-1", title: "Auth refactor: login page next" };

describe("context names and addresses", () => {
  it("builds a readable uri and name, and parses the uri back to the id prefix", () => {
    expect(contextUri(source)).toBe("cursor://auth-refactor-login-page-next-3f9a1c2d");
    expect(parseContextUri("cursor://auth-refactor-login-page-next-3f9a1c2d")).toEqual({ tool: "cursor", idPrefix: "3f9a1c2d" });
    expect(parseContextUri("not a uri")).toBeUndefined();
    expect(contextUri({ ...source, title: undefined, kind: "claude_code" })).toBe("claude-code://untitled-3f9a1c2d");
    expect(contextName(source, "2026-10-27T18:00:00Z")).toBe("Cursor: Auth refactor: login page next (Oct 27)");
  });

  it("matches on the tool's names, the title and the latest summary; every word must match", () => {
    expect(matchesQuery(source, "", "cursor auth")).toBe(true);
    expect(matchesQuery({ ...source, kind: "claude_code" }, "", "claude code auth")).toBe(true);
    expect(matchesQuery({ ...source, kind: "gmail_thread", title: "LOI" }, "Avery replied", "email avery")).toBe(true);
    expect(matchesQuery(source, "", "cursor billing")).toBe(false);
    // A tool word picks the tool, even if another tool's summary mentions it.
    expect(matchesQuery({ ...source, kind: "claude_code", title: "Redeploy plan" }, "Asked Cursor to redeploy", "cursor redeploy")).toBe(false);
    expect(matchesQuery({ ...source, kind: "claude_chat", title: "Pricing" }, "", "claude pricing")).toBe(true);
  });
});

describe("renderContext", () => {
  const at = "2026-10-27T18:00:00Z";
  const claim = (id: string, text: string, status: Claim["status"], kind: Claim["kind"] = "status"): Claim => ({
    id, project_id: "p", text, kind, status, source_id: source.id, valid_from: at, recorded_at: at, extracted_by: "t",
  });
  const tr = (claim_id: string, to: Transition["to_status"], explanation: string): Transition => ({
    id: `t-${claim_id}`, claim_id, from_status: "IN", to_status: to, depth: 0, explanation, at,
  });

  it("splits what the session said into still true, no longer true (with why) and review, then what changed elsewhere", () => {
    const md = renderContext({
      source,
      lastAt: at,
      events: [{ id: "e", kind: "session_note", source_id: source.id, occurred_at: at, observed_at: at, summary: "Usman finished the middleware." }],
      claims: [
        claim("a", "We use JWT for sessions", "IN", "decision"),
        claim("b", "All tests pass on main", "OUT"),
        claim("c", "Login page ships Friday", "REVIEW", "next_step"),
      ],
      latestTransition: new Map([
        ["b", tr("b", "OUT", "Went OUT because CI failed.")],
        ["c", tr("c", "REVIEW", 'Sent to REVIEW because "Claude chat" said: "moved to Monday".')],
      ]),
      changedSince: [{ claim: { ...claim("x", "Staging uses Postgres 16", "OUT"), source_id: "other" }, transition: tr("x", "OUT", "Went OUT because the doc was edited.") }],
    });
    expect(md).toContain("# Cursor: Auth refactor: login page next (Oct 27)");
    expect(md).toContain("## What happened\n\n- Oct 27, 2:00 PM EDT: Usman finished the middleware.");
    expect(md).toContain("## Still true\n\n- [decision] We use JWT for sessions");
    expect(md).toContain("## No longer true\n\n- [status] All tests pass on main. Went OUT because CI failed.");
    expect(md).toContain("## Waiting for your review\n\n- [next step] Login page ships Friday.");
    expect(md).toContain("## Changed since, elsewhere\n\n- OUT: Staging uses Postgres 16. Went OUT because the doc was edited.");
    expect(md).not.toMatch(/—/);
  });
});

describe("displayTitle", () => {
  it("keeps a real title, and replaces a hook placeholder with the start of the latest summary", () => {
    expect(displayTitle("Login page wiring", "x")).toBe("Login page wiring");
    expect(displayTitle("Claude Code turn", "Usman finished the auth middleware and moved on to the login page wiring for Friday.")).toBe("Usman finished the auth middleware and moved on to the...");
    expect(displayTitle("Cursor agent response", "")).toBeUndefined();
  });
});

describe("renderContext leaves out raw-text fallback summaries", () => {
  it("skips summaries starting with ...", () => {
    const at = "2026-10-27T18:00:00Z";
    const md = renderContext({
      source,
      lastAt: at,
      events: [
        { id: "a", kind: "doc_edited", source_id: source.id, occurred_at: at, observed_at: at, summary: "...raw tail of a tab ## Rules" },
        { id: "b", kind: "doc_edited", source_id: source.id, occurred_at: at, observed_at: at, summary: "The rules section was tightened." },
      ],
      claims: [],
      latestTransition: new Map(),
      changedSince: [],
    });
    expect(md).toContain("The rules section was tightened.");
    expect(md).not.toContain("raw tail");
  });
});
