// Index mode (Oct 28, Usman OK'd): every session gets a title and a short
// summary so search can find it, for one low-effort call. Claims are extracted
// only for the current project (full /ingest); an indexed session has none.
import { z } from "zod";
import type { SourceKind } from "../contract.js";
import { MUSE_SPARK } from "../meta/client.js";
import { loadPrompt, type JsonModel } from "./extract.js";

export const INDEX_PROMPT = "index.v1";
// The start usually says what the session is for; the end says where it landed.
const HEAD_CHARS = 10_000;
const TAIL_CHARS = 30_000;
const TITLE_MAX = 80;
const SUMMARY_MAX = 600;

export interface IndexInput {
  text: string;
  source: { kind: SourceKind; title?: string };
}

export interface IndexResult {
  title: string;
  summary: string;
  personal: boolean;
  indexed_by: string; // model id and prompt version
}

const Answer = z.object({ title: z.string(), summary: z.string(), personal: z.boolean() });
const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, summary: { type: "string" }, personal: { type: "boolean" } },
  required: ["title", "summary", "personal"],
  additionalProperties: false,
};

/** The part of a long text the index call reads: its start and its end. */
export function indexExcerpt(text: string): string {
  const t = text.trim();
  if (t.length <= HEAD_CHARS + TAIL_CHARS) return t;
  return `${t.slice(0, HEAD_CHARS)}\n\n[... ${t.length - HEAD_CHARS - TAIL_CHARS} characters left out ...]\n\n${t.slice(-TAIL_CHARS)}`;
}

export async function indexSession(model: JsonModel, input: IndexInput, modelId = MUSE_SPARK): Promise<IndexResult> {
  const out = await model.json({
    job: "index",
    developer: await loadPrompt(INDEX_PROMPT),
    user: [`Source: ${input.source.kind}${input.source.title ? ` "${input.source.title}"` : ""}`, "", "<<<", indexExcerpt(input.text), ">>>"].join("\n"),
    schemaName: "index",
    jsonSchema: SCHEMA,
    parse: Answer,
    effort: "low",
    model: modelId,
  });
  return {
    title: out.title.replace(/["“”]/g, "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX),
    summary: out.summary.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX),
    personal: out.personal,
    indexed_by: `${modelId}/${INDEX_PROMPT}`,
  };
}
