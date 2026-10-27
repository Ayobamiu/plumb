import { describe, expect, it } from "vitest";
import type { JsonModel } from "@plumb/core";
import { callTool, MemoryStore, sweep } from "../src/tools/index.js";

describe("sweep", () => {
  it("sends a hint-only claim to REVIEW, moves the cursor, and only looks at events seen since", async () => {
    const store = new MemoryStore();
    const project = store.addProject("p");
    const recorded: any = await callTool(
      store,
      "record_claims",
      {
        project_id: project.id,
        source: { kind: "claude_code", external_id: "s1" },
        extracted_by: "t",
        claims: [
          {
            text: "We use Supabase for storage.",
            kind: "decision",
            valid_from: "2026-10-25T00:00:00Z",
            reasons: [{ type: "absence", since: "2026-10-25T00:00:00Z", pattern: { event_kind: "doc_edited", text_hint: "storage moved off Supabase" } }],
          },
        ],
      },
      { model: null },
    );
    const claimId = recorded.claims[0].id;
    await callTool(
      store,
      "record_event",
      {
        kind: "email_received",
        source: { kind: "gmail_thread", external_id: "t-db" },
        occurred_at: new Date(Date.now() - 60_000).toISOString(),
        from: "theo@ourteam.io",
        thread_id: "t-db",
        summary: "Heads up: moving the database to Neon next week",
      },
      { model: null },
    );

    const users: string[] = [];
    const model: JsonModel = {
      async json(opts) {
        users.push(opts.user);
        if (opts.schemaName === "duplicates") return opts.parse.parse({ groups: [] }) as never;
        return opts.parse.parse({ verdict: "unsure", event: 1, quote: "moving the database to Neon", why: "Maybe." }) as never;
      },
    };

    const first = await sweep(store, model);
    expect(first.rechecked).toBe(1);
    expect(first.transitions).toHaveLength(1);
    expect(first.transitions[0]!.explanation).toMatch(/background check .* can't tell if this still holds/);
    expect(store.claims.get(claimId)!.status).toBe("REVIEW");
    expect(store.cursors.get("sweep")).toBe(first.until);

    // Nothing new since the last sweep: no re-check calls, nothing written.
    users.length = 0;
    const second = await sweep(store, model);
    expect(second.events).toBe(0);
    expect(second.transitions).toEqual([]);
    expect(users.some((u) => u.includes("News that would break it"))).toBe(false);
  });
});
