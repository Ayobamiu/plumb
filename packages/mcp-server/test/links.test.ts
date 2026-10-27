import { describe, expect, it } from "vitest";
import type { JsonModel } from "@plumb/core";
import { callTool, listLinkSuggestions, MemoryStore, resolveLinkSuggestion, sweep, ToolError } from "../src/tools/index.js";

const until = { type: "until", at: "2027-01-01T00:00:00Z" };

async function setup() {
  const store = new MemoryStore();
  const project = store.addProject("p");
  const record = (kind: "claude_code" | "cursor", text: string, reasons: unknown[], valid_from: string, claimKind = "status") =>
    callTool(
      store,
      "record_claims",
      { project_id: project.id, source: { kind, external_id: `${kind}-1` }, extracted_by: "t", claims: [{ text, kind: claimKind, valid_from, reasons }] },
      { model: null },
    ) as Promise<any>;
  const tests = await record(
    "claude_code",
    "All tests pass on main.",
    [{ type: "absence", since: "2026-10-26T00:00:00Z", pattern: { event_kind: "email_received", from: "ci@builds.ourteam.io" } }],
    "2026-10-26T00:00:00Z",
  );
  const deploy = await record("cursor", "Deploy to production on Friday.", [until], "2026-10-27T00:00:00Z", "next_step");
  return { store, project, testsId: tests.claims[0].id as string, deployId: deploy.claims[0].id as string };
}

// The fake model says the deploy plan (c2) assumes the tests claim (c1); refs go by age.
const model: JsonModel = {
  async json(opts) {
    if (opts.schemaName === "links") {
      const deps = opts.user.startsWith("Claim to check: c2") ? [{ ref: "c1", why: "Only deploy if tests pass." }] : [];
      return opts.parse.parse({ depends_on: deps }) as never;
    }
    if (opts.schemaName === "duplicates") return opts.parse.parse({ groups: [] }) as never;
    throw new Error("no re-check expected");
  },
};

const ciFails = {
  kind: "email_received",
  source: { kind: "gmail_thread", external_id: "t-ci" },
  occurred_at: new Date().toISOString(),
  from: "CI <ci@builds.ourteam.io>",
  thread_id: "t-ci",
  summary: "Build failed on main",
};

describe("link suggestions", () => {
  it("are suggested by the sweep, and once accepted a broken claim knocks down its new dependent", async () => {
    const { store, project, testsId, deployId } = await setup();
    const result = await sweep(store, model);
    expect(result.links).toBe(1);

    const listed = await listLinkSuggestions(store, { project_id: project.id });
    expect(listed.suggestions).toHaveLength(1);
    expect(listed.suggestions[0]).toMatchObject({ claim: { text: "Deploy to production on Friday." }, depends_on_claim: { text: "All tests pass on main." }, why: "Only deploy if tests pass." });

    const accepted = await resolveLinkSuggestion(store, { id: listed.suggestions[0]!.id, action: "accept" });
    expect(accepted.suggestion.status).toBe("accepted");
    expect(store.reasons.some((r) => r.claim_id === deployId && r.type === "depends_on" && r.claim === testsId)).toBe(true);
    expect((await listLinkSuggestions(store, { project_id: project.id })).suggestions).toEqual([]);

    const out: any = await callTool(store, "record_event", ciFails, { model: null });
    expect(out.transitions.map((t: any) => [t.claim_id, t.depth])).toEqual([[testsId, 0], [deployId, 1]]);
  });

  it("expires on its own when a claim on either side leaves IN, and comes back if that claim is restored", async () => {
    const { store, project, testsId } = await setup();
    await sweep(store, model);
    await callTool(store, "record_event", ciFails, { model: null });
    expect(store.claims.get(testsId)!.status).toBe("OUT");
    expect((await listLinkSuggestions(store, { project_id: project.id })).suggestions).toEqual([]);
    expect(store.links[0]).toMatchObject({ status: "expired", expired_because: "claim_left_in", expired_note: '"All tests pass on main." went OUT.' });
    await expect(resolveLinkSuggestion(store, { id: store.links[0]!.id, action: "accept" })).rejects.toBeInstanceOf(ToolError);

    // Usman restores the claim: the next sweep may suggest the pair again.
    await callTool(store, "resolve_review", { claim_id: testsId, action: "restore_in" }, { model: null });
    const again = await sweep(store, model);
    expect(again.links).toBe(1);
    expect(store.links).toHaveLength(1);
    expect(store.links[0]).toMatchObject({ status: "pending" });
    expect(store.links[0]!.expired_because).toBeUndefined();
  });

  it("a dismissed pair is not suggested again, and a resolved suggestion can't be resolved twice", async () => {
    const { store, project } = await setup();
    await sweep(store, model);
    const [s] = (await listLinkSuggestions(store, { project_id: project.id })).suggestions;
    await resolveLinkSuggestion(store, { id: s!.id, action: "dismiss" });
    await expect(resolveLinkSuggestion(store, { id: s!.id, action: "accept" })).rejects.toBeInstanceOf(ToolError);
    const again = await sweep(store, model);
    expect(again.links).toBe(0);
    expect(store.links).toHaveLength(1);
  });
});
