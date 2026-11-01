// Types for the Cursor-owned ingest helper local-sync may import (AGENTS.md).
// Covers ingestText only; anything else it exports is out of our lane.
declare module "*integrations/lib/ingest.mjs" {
  export function ingestText(opts: {
    text: string;
    sourceKind: string;
    externalId: string;
    title?: string;
    token: string;
    indexOnly?: boolean;
    label?: string;
    projectId?: string;
  }): Promise<unknown>;
}
