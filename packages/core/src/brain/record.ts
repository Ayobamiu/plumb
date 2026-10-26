// Turn record_claims input into stored claims and reasons. Shared by the MCP
// handler and the evals, so both resolve temp ids and same_as the same way.
import type { Claim, Reason } from "../contract.js";
import type { NewClaim } from "../tools.js";

export interface MaterializeInput {
  project_id: string;
  source_id: string;
  extracted_by: string;
  recorded_at: string;
  claims: NewClaim[];
  existing: Map<string, Claim>; // for same_as and depends_on pointing at stored claims
  newId: () => string;
}

export interface Materialized {
  claims: Claim[]; // new claims only
  reasons: Reason[]; // all new reasons, including ones added to same_as claims
  id_map: Record<string, string>; // temp_id to real id
  touched: string[]; // ids of new claims and same_as claims, to evaluate right away
}

export function materializeClaims(input: MaterializeInput): Materialized {
  const id_map: Record<string, string> = {};
  const claims: Claim[] = [];

  // First pass: assign ids, so depends_on can point forward or backward.
  const ids = input.claims.map((c) => {
    if (c.same_as) {
      if (!input.existing.has(c.same_as)) throw new Error(`same_as points at unknown claim ${c.same_as}`);
      if (c.temp_id) id_map[c.temp_id] = c.same_as;
      return c.same_as;
    }
    const id = input.newId();
    if (c.temp_id) id_map[c.temp_id] = id;
    return id;
  });

  const resolve = (ref: string) => {
    const id = id_map[ref] ?? (input.existing.has(ref) ? ref : undefined);
    if (!id) throw new Error(`depends_on points at unknown claim ${ref}`);
    return id;
  };

  const reasons: Reason[] = [];
  input.claims.forEach((c, i) => {
    const claim_id = ids[i]!;
    if (!c.same_as) {
      claims.push({
        id: claim_id,
        project_id: input.project_id,
        text: c.text,
        kind: c.kind,
        status: "IN",
        source_id: input.source_id,
        valid_from: c.valid_from,
        recorded_at: input.recorded_at,
        extracted_by: input.extracted_by,
        ...(c.confidence !== undefined && { confidence: c.confidence }),
      });
    }
    for (const r of c.reasons) {
      const id = input.newId();
      if (r.type === "depends_on") {
        const target = resolve(r.claim);
        if (target === claim_id) throw new Error(`claim ${c.temp_id ?? claim_id} depends on itself`);
        reasons.push({ id, claim_id, type: "depends_on", claim: target });
      } else {
        reasons.push({ id, claim_id, ...r });
      }
    }
  });

  return { claims, reasons, id_map, touched: [...new Set(ids)] };
}
