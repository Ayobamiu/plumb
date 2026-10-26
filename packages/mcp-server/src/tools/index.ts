// MCP tool registry. Handlers land here (Claude Code); transport, deploy and
// auth live outside src/tools (Cursor). Input schemas come from @plumb/core.
//
// Transport code only needs callTool:
//   const store = SupabaseStore.fromEnv();
//   const result = await callTool(store, "record_event", body);
// It throws ToolError with code "bad_input" (HTTP 400) or "not_found" (404).
//
// POST /ingest is not an MCP tool; it needs a model client too:
//   const body = IngestInput.parse(json); // from @plumb/core, 400 on failure
//   const result = await ingest(store, new MetaClient(), body);
import {
  ExplainClaimInput,
  GetProjectStateInput,
  ListProjectsInput,
  RecordClaimsInput,
  RecordEventInput,
  ResolveReviewInput,
} from "@plumb/core";
import { createHandlers, ToolError } from "./handlers.js";
import type { Store } from "./store.js";

export const toolInputs = {
  list_projects: ListProjectsInput,
  get_project_state: GetProjectStateInput,
  record_claims: RecordClaimsInput,
  record_event: RecordEventInput,
  explain_claim: ExplainClaimInput,
  resolve_review: ResolveReviewInput,
} as const;

export type ToolName = keyof typeof toolInputs;

// Descriptions for MCP tool listings, from the tool table in tab 1.
export const toolDescriptions: Record<ToolName, string> = {
  list_projects: "List projects with counts of IN, OUT and REVIEW claims.",
  get_project_state:
    "Call at session start. Returns the project's IN claims grouped by kind, plus every claim that went OUT or REVIEW since a given time (default: last 24 hours), with the reason.",
  record_claims:
    "Call at session end. Write new claims, each with at least one reason (depends_on, evidence, absence or until). Claims with no reason are rejected.",
  record_event: "Log something that happened (an email, a doc edit, a clock tick), then run invalidation.",
  explain_claim: "The reason chain and full status history for one claim.",
  resolve_review: "Usman's decision on a claim: confirm_out, restore_in, or edit its text.",
};

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(toolInputs, name);
}

export async function callTool(store: Store, name: string, input: unknown): Promise<unknown> {
  if (!isToolName(name)) throw new ToolError("not_found", `unknown tool ${name}`);
  const parsed = toolInputs[name].safeParse(input ?? {});
  if (!parsed.success) throw new ToolError("bad_input", parsed.error.message);
  const handler = createHandlers(store)[name] as (input: unknown) => Promise<unknown>;
  return handler(parsed.data);
}

export { createHandlers, ToolError } from "./handlers.js";
export { ingest, knownThreads } from "./ingest.js";
export { ConflictError, type Store, type BrainWrite, type ProjectWithCounts } from "./store.js";
export { SupabaseStore } from "./supabase-store.js";
export { MemoryStore } from "./memory-store.js";
