// Link suggestions for the homepage (not MCP tools). The sweep writes them;
// Usman accepts or dismisses each one. Accepting adds the depends_on reason
// through record_claims (same_as plus the new reason), so it runs the same
// checks as any new reason: if the claim it now rests on is already OUT, the
// dependent goes OUT right away with the usual explanation.
import type { z } from "zod";
import type {
  ListLinkSuggestionsInput,
  ListLinkSuggestionsOutput,
  ResolveLinkSuggestionInput,
  ResolveLinkSuggestionOutput,
} from "@plumb/core";
import { createHandlers, ToolError } from "./handlers.js";
import type { Store } from "./store.js";

// Where accepted links come from, as a record_claims source.
const SOURCE = { kind: "manual" as const, external_id: "usman-links", title: "Links you accepted" };

export async function listLinkSuggestions(
  store: Store,
  input: z.infer<typeof ListLinkSuggestionsInput>,
): Promise<z.infer<typeof ListLinkSuggestionsOutput>> {
  const pending = await store.loadLinkSuggestions({ project_id: input.project_id, status: "pending" });
  if (pending.length === 0) return { suggestions: [] };
  const claims = new Map(
    (await store.loadClaims({ ids: [...new Set(pending.flatMap((p) => [p.claim_id, p.depends_on]))] })).map((c) => [c.id, c]),
  );
  return {
    suggestions: pending.flatMap((p) => {
      const claim = claims.get(p.claim_id);
      const depends_on_claim = claims.get(p.depends_on);
      return claim && depends_on_claim ? [{ ...p, claim, depends_on_claim }] : [];
    }),
  };
}

export async function resolveLinkSuggestion(
  store: Store,
  input: z.infer<typeof ResolveLinkSuggestionInput>,
): Promise<z.infer<typeof ResolveLinkSuggestionOutput>> {
  const all = await store.loadLinkSuggestions();
  const suggestion = all.find((s) => s.id === input.id);
  if (!suggestion) throw new ToolError("not_found", `unknown link suggestion ${input.id}`);
  if (suggestion.status !== "pending") throw new ToolError("bad_input", `link suggestion is already ${suggestion.status}`);
  const at = new Date().toISOString();

  if (input.action === "accept") {
    const [claim] = await store.loadClaims({ ids: [suggestion.claim_id] });
    if (!claim) throw new ToolError("not_found", `unknown claim ${suggestion.claim_id}`);
    const linked = (await store.loadReasons({ claim_ids: [claim.id] })).some(
      (r) => r.type === "depends_on" && r.claim === suggestion.depends_on,
    );
    // If an earlier accept added the link but didn't get to mark it, don't add it twice.
    if (!linked) {
      await createHandlers(store).record_claims({
        project_id: claim.project_id,
        source: SOURCE,
        extracted_by: "usman",
        claims: [
          {
            same_as: claim.id,
            text: claim.text,
            kind: claim.kind,
            valid_from: claim.valid_from,
            reasons: [{ type: "depends_on", claim: suggestion.depends_on }],
          },
        ],
      });
    }
  }
  const status = input.action === "accept" ? "accepted" : "dismissed";
  if (!(await store.resolveLinkSuggestion(suggestion.id, status, at))) {
    throw new ToolError("bad_input", "link suggestion was resolved by someone else");
  }
  return { suggestion: { ...suggestion, status, resolved_at: at } };
}
