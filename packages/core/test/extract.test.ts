import { describe, expect, it } from "vitest";
import { buildExtractMessage, checkExtraction, extractClaims, type ExtractInput, type JsonModel } from "../src/index.js";

const input: ExtractInput = {
  text: "Still waiting on Avery about the LOI. Follow up Friday.",
  source: { kind: "claude_code", title: "Session" },
  at: "2026-10-26T15:00:00Z",
  now: "2026-10-26T15:05:00Z",
  in_claims: [{ id: "uuid-old", text: "Tests pass", kind: "status" }],
  threads: [{ thread_id: "t-loi", subject: "LOI", participants: ["avery@northfield.edu"] }],
};

const reason = (r: Record<string, unknown>) => ({
  type: "absence",
  event_kind: null,
  from: null,
  thread_id: null,
  text_hint: null,
  since: null,
  at: null,
  claim_ref: null,
  ...r,
});
const claim = (ref: string, reasons: unknown[], extra: Record<string, unknown> = {}) => ({
  ref,
  text: `claim ${ref}`,
  kind: "status",
  valid_from: null,
  confidence: 0.9,
  same_as: null,
  reasons,
  ...extra,
});
const check = (claims: unknown[], contradicts: unknown[] = []) => checkExtraction({ claims, contradicts } as never, input);

describe("checkExtraction", () => {
  it("keeps a good absence, normalizing the address and filling since", () => {
    const out = check([claim("n1", [reason({ event_kind: "email_received", from: "Avery <AVERY@northfield.edu>", thread_id: "t-loi" })])]);
    expect(out.claims[0]!.reasons[0]).toEqual({
      type: "absence",
      since: input.at,
      pattern: { event_kind: "email_received", from: "avery@northfield.edu", thread_id: "t-loi" },
    });
    expect(out.claims[0]!.valid_from).toBe(input.at);
  });

  it("drops a made-up thread id and keeps the sender", () => {
    const out = check([claim("n1", [reason({ event_kind: "email_received", from: "avery@northfield.edu", thread_id: "t-made-up" })])]);
    expect(out.claims[0]!.reasons[0]).toMatchObject({ pattern: { from: "avery@northfield.edu" } });
    expect((out.claims[0]!.reasons[0] as any).pattern.thread_id).toBeUndefined();
  });

  it("turns an absence with no usable sender or thread into a text_hint for the model check", () => {
    const out = check([claim("n1", [reason({ event_kind: "email_received", from: "Avery" })])]);
    expect(out.claims[0]!.reasons[0]).toMatchObject({ pattern: { event_kind: "email_received", text_hint: "claim n1" } });
  });

  it("maps depends_on refs to existing ids or temp ids, and drops the chain under a bad claim", () => {
    const out = check([
      claim("n1", [reason({ type: "until", at: "not a time" })]),
      claim("n2", [reason({ type: "depends_on", claim_ref: "n1" })]),
      claim("n3", [reason({ type: "depends_on", claim_ref: "c1" })]),
      claim("n4", [reason({ type: "depends_on", claim_ref: "n3" })]),
    ]);
    expect(out.claims.map((c) => c.temp_id)).toEqual(["n3", "n4"]);
    expect(out.claims[0]!.reasons[0]).toEqual({ type: "depends_on", claim: "uuid-old" });
    expect(out.claims[1]!.reasons[0]).toEqual({ type: "depends_on", claim: "n3" });
    expect(out.dropped.map((d) => d.text)).toEqual(["claim n1", "claim n2"]);
  });

  it("drops repeated refs and refs that reuse a current claim's ref", () => {
    const until = reason({ type: "until", at: "2026-11-05T02:00:00Z" });
    const out = check([claim("n1", [until]), claim("n1", [until]), claim("c1", [until])]);
    expect(out.claims).toHaveLength(1);
    expect(out.dropped).toHaveLength(2);
  });

  it("maps same_as and contradicts to real ids, and ignores unknown refs", () => {
    const until = reason({ type: "until", at: "2026-11-05T02:00:00-04:00" });
    const out = check(
      [claim("n1", [until], { same_as: "c1" }), claim("n2", [until], { same_as: "c9" })],
      [{ ref: "c1", quote: "the build broke" }, { ref: "c7", quote: "x" }],
    );
    expect(out.claims[0]!.same_as).toBe("uuid-old");
    expect(out.claims[1]!.same_as).toBeUndefined();
    expect(out.contradicts).toEqual([{ claim_id: "uuid-old", quote: "the build broke" }]);
    expect(out.dropped).toHaveLength(1);
  });
});

describe("extractClaims", () => {
  it("retries once, then reports the failure instead of throwing", async () => {
    let calls = 0;
    const model: JsonModel = {
      async json() {
        calls++;
        throw new Error("schema mismatch");
      },
    };
    const out = await extractClaims(model, input);
    expect(calls).toBe(2);
    expect(out.claims).toEqual([]);
    expect(out.dropped[0]!.why).toMatch(/failed twice: schema mismatch/);
    expect(out.extracted_by).toBe("muse-spark-1.3/extract.v6");
  });

  it("sends the prompt file and lists current claims and threads by ref", async () => {
    let seen: any;
    const model: JsonModel = {
      async json(opts) {
        seen = opts;
        return { claims: [], contradicts: [] } as never;
      },
    };
    await extractClaims(model, input);
    expect(seen.developer).toMatch(/^You read one piece of text/);
    expect(seen.effort).toBe("medium");
    expect(buildExtractMessage(input)).toContain('c1 [status] Tests pass\n');
    expect(seen.user).toContain('thread_id t-loi: "LOI" with avery@northfield.edu');
  });
});
