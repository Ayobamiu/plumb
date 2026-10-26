// Muse Spark client over Meta's OpenAI-compatible Responses API.
// Every call appends one line to logs/meta-calls.jsonl with tokens and cost.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export const META_BASE_URL = "https://api.meta.ai/v1";
// Confirmed via GET /v1/models on Oct 26, 2026.
export const MUSE_SPARK = "muse-spark-1.3";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

// USD per million tokens, standard tier (dev.meta.ai pricing, checked Oct 26, 2026).
// Not the cheaper contributor tier: that lets Meta train on prompts, and ours
// carry email summaries. Env vars override if the prices change.
const PRICE_IN = Number(process.env.META_PRICE_IN_PER_M ?? 1.25);
const PRICE_CACHED_IN = Number(process.env.META_PRICE_CACHED_IN_PER_M ?? 0.15);
const PRICE_OUT = Number(process.env.META_PRICE_OUT_PER_M ?? 4.25); // includes reasoning tokens
const COST_LOG = process.env.META_COST_LOG ?? "logs/meta-calls.jsonl";

export interface MetaCallLog {
  at: string;
  job: string; // extraction, model_check, sweep, summary, smoke
  model: string;
  effort: ReasoningEffort;
  response_id?: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface JsonCallOptions<T> {
  job: string;
  developer: string; // standing rules, sent as a developer message
  user: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>; // sent to the model
  parse: z.ZodType<T>; // checked in code after the call
  effort?: ReasoningEffort;
  model?: string;
}

export class MetaClient {
  constructor(private apiKey = process.env.META_MODEL_API_KEY) {
    if (!this.apiKey) throw new Error("META_MODEL_API_KEY is not set");
  }

  async json<T>(opts: JsonCallOptions<T>): Promise<T> {
    const model = opts.model ?? MUSE_SPARK;
    const effort = opts.effort ?? "low";
    const started = Date.now();
    const log: MetaCallLog = {
      at: new Date().toISOString(),
      job: opts.job,
      model,
      effort,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: 0,
      ms: 0,
      ok: false,
    };
    try {
      const res = await fetch(`${META_BASE_URL}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input: [
            { role: "developer", content: opts.developer },
            { role: "user", content: opts.user },
          ],
          reasoning: { effort },
          store: false,
          text: { format: { type: "json_schema", name: opts.schemaName, strict: true, schema: opts.jsonSchema } },
        }),
      });
      const body = (await res.json()) as ResponsesBody;
      if (!res.ok || body.error) {
        throw new Error(`Meta API ${res.status}: ${body.error?.message ?? "unknown error"}`);
      }
      log.response_id = body.id;
      log.input_tokens = body.usage?.input_tokens ?? 0;
      log.output_tokens = body.usage?.output_tokens ?? 0;
      log.cached_input_tokens = body.usage?.input_tokens_details?.cached_tokens ?? 0;
      log.reasoning_tokens = body.usage?.output_tokens_details?.reasoning_tokens ?? 0;
      log.cost_usd = callCost(log);

      const text = body.output
        ?.filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .find((c) => c.type === "output_text")?.text;
      if (!text) throw new Error("Meta API returned no output_text");
      const parsed = opts.parse.parse(JSON.parse(text));
      log.ok = true;
      return parsed;
    } catch (err) {
      log.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      log.ms = Date.now() - started;
      await writeLog(log);
    }
  }
}

/** Cached input tokens are part of input_tokens but bill at the cached rate. */
export function callCost(t: Pick<MetaCallLog, "input_tokens" | "cached_input_tokens" | "output_tokens">): number {
  const fresh = t.input_tokens - t.cached_input_tokens;
  return (fresh * PRICE_IN + t.cached_input_tokens * PRICE_CACHED_IN + t.output_tokens * PRICE_OUT) / 1_000_000;
}

async function writeLog(log: MetaCallLog) {
  await mkdir(dirname(COST_LOG), { recursive: true });
  await appendFile(COST_LOG, JSON.stringify(log) + "\n");
}

interface ResponsesBody {
  id?: string;
  error?: { message?: string } | null;
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
}
