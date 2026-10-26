// One structured call to Muse Spark to prove the key and the client work.
// Run from the repo root: pnpm smoke:meta
import { z } from "zod";
import { MetaClient } from "./client.js";

const Answer = z.object({ ok: z.boolean(), model_says: z.string() });

const answer = await new MetaClient().json({
  job: "smoke",
  developer: "You reply only with JSON that matches the schema.",
  user: 'Set ok to true and model_says to a five word greeting.',
  schemaName: "smoke",
  jsonSchema: {
    type: "object",
    properties: { ok: { type: "boolean" }, model_says: { type: "string" } },
    required: ["ok", "model_says"],
    additionalProperties: false,
  },
  parse: Answer,
  effort: "minimal",
});

console.log("Muse Spark replied:", answer);
