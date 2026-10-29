// Live smoke test against Supabase: record a two-claim chain, break it with an
// email, explain it, restore it. Rows are permanent (nothing is ever deleted),
// so everything lands in one project named "Smoke test", reused across runs.
// Run: pnpm smoke:db
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { callTool, ScopedStore, SupabaseStore } from "./index.js";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// Runs as the owner (per user, Oct 28): every request is scoped to a user.
const store = new ScopedStore(SupabaseStore.fromEnv(), process.env.PLUMB_OWNER_USER_ID!);
// Plain code only (Part B): the model check would make the "other thread" step depend on a model answer.
const call = (name: string, input: unknown) => callTool(store, name, input, { model: null }) as Promise<any>;

function expect(ok: boolean, what: string) {
  if (!ok) throw new Error(`smoke failed: ${what}`);
  console.log(`ok  ${what}`);
}

const owner = process.env.PLUMB_OWNER_USER_ID!;
const found = await db.from("projects").select("id").eq("name", "Smoke test").eq("user_id", owner).limit(1);
if (found.error) throw new Error(found.error.message);
let projectId = found.data[0]?.id as string | undefined;
if (!projectId) {
  const created = await db.from("projects").insert({ name: "Smoke test", user_id: owner }).select("id").single();
  if (created.error) throw new Error(created.error.message);
  projectId = created.data.id as string;
}

const run = randomUUID().slice(0, 8); // a fresh thread per run, so old runs don't interfere
const thread = `smoke-${run}`;
const since = new Date(Date.now() - 60_000).toISOString();

const recorded = await call("record_claims", {
  project_id: projectId,
  source: { kind: "manual", external_id: `smoke-${run}`, title: `Smoke run ${run}` },
  extracted_by: "smoke",
  claims: [
    {
      temp_id: "noreply",
      text: `No reply from the smoke tester yet (run ${run})`,
      kind: "status",
      valid_from: since,
      reasons: [{ type: "absence", since, pattern: { event_kind: "email_received", from: "tester@example.com", thread_id: thread } }],
    },
    {
      temp_id: "followup",
      text: `Follow up with the smoke tester (run ${run})`,
      kind: "next_step",
      valid_from: since,
      reasons: [{ type: "depends_on", claim: "noreply" }],
    },
  ],
});
const noreply = recorded.id_map.noreply as string;
const followup = recorded.id_map.followup as string;
expect(recorded.claims.length === 2 && recorded.reasons.length === 2, "record_claims wrote 2 claims and 2 reasons");

const other = await call("record_event", {
  kind: "email_received",
  source: { kind: "gmail_thread", external_id: `${thread}-other` },
  occurred_at: new Date().toISOString(),
  from: "tester@example.com",
  thread_id: `${thread}-other`,
  summary: "Smoke: same sender, other thread",
});
expect(other.transitions.length === 0, "an email in another thread breaks nothing");

const hit = await call("record_event", {
  kind: "email_received",
  source: { kind: "gmail_thread", external_id: thread },
  occurred_at: new Date().toISOString(),
  from: "Smoke Tester <Tester@Example.com>",
  thread_id: thread,
  summary: "Smoke: the reply",
});
expect(hit.transitions.map((t: any) => t.depth).join() === "0,1", "the reply breaks the claim and the chain (depth 0, 1)");

const explained = await call("explain_claim", { claim_id: followup });
expect(explained.claim.status === "OUT" && explained.depends_on[0]?.id === noreply, "explain_claim shows OUT and the link");

const state = await call("get_project_state", { project_id: projectId, since });
expect(state.changed_since.some((c: any) => c.claim.id === followup), "get_project_state lists the change");

const restored = await call("resolve_review", { claim_id: noreply, action: "restore_in", note: "smoke test" });
const after = await store.loadClaims({ ids: [noreply, followup] });
expect(restored.transitions.length === 2 && after.every((c) => c.status === "IN"), "restore_in brings both back IN");

const listed = await call("list_projects", {});
const counts = listed.projects.find((p: any) => p.id === projectId)?.counts;
console.log(`\nSmoke test project ${projectId}: ${JSON.stringify(counts)}`);
