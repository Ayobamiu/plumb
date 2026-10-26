// MCP tool registry. Handlers land here (Claude Code); transport, deploy and
// auth live outside src/tools (Cursor). Input schemas come from @plumb/core.
import {
  ExplainClaimInput,
  GetProjectStateInput,
  ListProjectsInput,
  RecordClaimsInput,
  RecordEventInput,
  ResolveReviewInput,
} from "@plumb/core";

export const toolInputs = {
  list_projects: ListProjectsInput,
  get_project_state: GetProjectStateInput,
  record_claims: RecordClaimsInput,
  record_event: RecordEventInput,
  explain_claim: ExplainClaimInput,
  resolve_review: ResolveReviewInput,
} as const;

export type ToolName = keyof typeof toolInputs;
