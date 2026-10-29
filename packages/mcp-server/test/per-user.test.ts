import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "../src/http.js";
import { callTool, ingest, listContexts, MEMORY_USER, MemoryStore, ScopedStore } from "../src/tools/index.js";
import type { JsonModel } from "@plumb/core";

const indexer: JsonModel = {
  async json(opts) {
    return opts.parse.parse({ title: "Gym plan", summary: "Push pull legs.", personal: true }) as never;
  },
};
const until = (at: string) => ({ type: "until" as const, at });

describe("per user: one user never sees or touches another's data", () => {
  it("scopes projects, claims, sources, contexts and writes", async () => {
    const store = new MemoryStore();
    const pa = store.addProject("A work", "user-a");
    const pb = store.addProject("B work", "user-b");
    const a = new ScopedStore(store, "user-a");
    const b = new ScopedStore(store, "user-b");

    await callTool(a, "record_claims", { project_id: pa.id, source: { kind: "cursor", external_id: "conv-1" }, extracted_by: "t", claims: [{ text: "A ships Friday", kind: "status", valid_from: "2026-10-28T00:00:00Z", reasons: [until("2027-01-01T00:00:00Z")] }] }, { model: null });
    // Same external id for user B: a separate source, not a merge.
    await ingest(b, indexer, { index_only: true, source: { kind: "cursor", external_id: "conv-1", user_id: "user-a" } as never, text: "B's chat" });

    expect((await callTool(b, "list_projects", {}, { model: null }) as any).projects.map((p: any) => p.name)).toEqual(["B work"]);
    await expect(callTool(b, "get_project_state", { project_id: pa.id }, { model: null })).rejects.toMatchObject({ code: "not_found" });
    const aClaim = [...store.claims.values()][0]!;
    await expect(callTool(b, "explain_claim", { claim_id: aClaim.id }, { model: null })).rejects.toMatchObject({ code: "not_found" });
    await expect(callTool(b, "resolve_review", { claim_id: aClaim.id, action: "confirm_out" }, { model: null })).rejects.toMatchObject({ code: "not_found" });
    await expect(callTool(b, "record_claims", { project_id: pa.id, source: { kind: "cursor", external_id: "x" }, extracted_by: "t", claims: [{ text: "sneaky", kind: "fact", valid_from: "2026-10-28T00:00:00Z", reasons: [until("2027-01-01T00:00:00Z")] }] }, { model: null })).rejects.toMatchObject({ code: "not_found" });

    // Two sources now, one per user, and a caller-sent user_id didn't win.
    expect(store.sources.filter((s) => s.external_id === "conv-1").map((s) => s.user_id).sort()).toEqual(["user-a", "user-b"]);
    expect((await listContexts(a, {})).map((c) => c.tool)).toEqual(["Cursor"]);
    expect((await listContexts(b, {})).map((c) => c.title)).toEqual(["Gym plan"]);
    expect(store.claims.get(aClaim.id)!.status).toBe("IN");
    expect(pb.user_id).toBe("user-b");
  });
});

async function withServer(run: (base: string, store: MemoryStore) => Promise<void>) {
  const store = new MemoryStore();
  const sessions: Record<string, string> = { "session-of-new-user": "user-new" };
  const app = createHttpApp({ store, tokens: new Map(), ownerUserId: MEMORY_USER, host: "127.0.0.1", webUrl: "https://plumb.example", verifySession: async (t) => sessions[t] });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const post = (base: string, path: string, body: unknown, auth?: string) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(auth && { authorization: `Bearer ${auth}` }) }, body: JSON.stringify(body) });

describe("device sign-in (npx plumb init)", () => {
  it("start, approve with a session, then trade the device code for a token once", async () => {
    await withServer(async (base, store) => {
      const started = (await (await post(base, "/auth/device", { tool: "claude_code" })).json()) as any;
      expect(started.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
      expect(started.verification_url).toBe(`https://plumb.example/device?code=${started.user_code}`);
      expect(store.devices[0]!.device_code_hash).not.toContain(started.device_code); // only the hash is kept

      expect((await (await post(base, "/auth/device/token", { device_code: started.device_code })).json()) as any).toEqual({ error: "authorization_pending" });
      expect((await post(base, "/auth/device/approve", { user_code: started.user_code })).status).toBe(401); // no session
      expect((await post(base, "/auth/device/approve", { user_code: started.user_code }, "not-a-session")).status).toBe(401);
      const approved = await post(base, "/auth/device/approve", { user_code: started.user_code.toLowerCase().replace("-", " ") }, "session-of-new-user");
      expect(approved.status).toBe(200);
      expect(store.projects.filter((p) => p.user_id === "user-new").map((p) => p.name)).toEqual(["My work"]); // a new user gets one project
      expect((await post(base, "/auth/device/approve", { user_code: started.user_code }, "session-of-new-user")).status).toBe(409);

      const got = (await (await post(base, "/auth/device/token", { device_code: started.device_code })).json()) as any;
      expect(got.access_token).toMatch(/^plumb_/);
      expect(got.user_id).toBe("user-new");
      expect(store.tokens[0]).toMatchObject({ user_id: "user-new", tool: "claude_code" });
      expect(store.tokens[0]!.token_hash).not.toBe(got.access_token);
      expect((await (await post(base, "/auth/device/token", { device_code: started.device_code })).json()) as any).toEqual({ error: "already_used" });

      // The token works, and only for the new user's data.
      const projects = (await (await post(base, "/tools/list_projects", {}, got.access_token)).json()) as any;
      expect(projects.projects.map((p: any) => p.name)).toEqual(["My work"]);
      expect((await post(base, "/sweep", {}, got.access_token)).status).toBe(403);
      expect((await (await post(base, "/auth/device/token", { device_code: "wrong" })).json()) as any).toEqual({ error: "expired_token" });
    });
  });
});
