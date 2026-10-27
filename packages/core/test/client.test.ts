import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MetaClient } from "../src/index.js";

process.env.META_COST_LOG = "/tmp/plumb-test-meta-calls.jsonl";

const opts = {
  job: "test",
  developer: "d",
  user: "u",
  schemaName: "x",
  jsonSchema: {},
  parse: z.object({ ok: z.boolean() }),
};
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const good = answer(200, { id: "r1", output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }] });

afterEach(() => vi.unstubAllGlobals());

describe("MetaClient retries", () => {
  it("retries a 404 'model not found' and succeeds", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(answer(404, { error: { message: "The requested model was not found." } }))
      .mockResolvedValueOnce(good);
    vi.stubGlobal("fetch", fetch);
    await expect(new MetaClient("k", [0, 0]).json(opts)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after three attempts", async () => {
    const fetch = vi.fn().mockResolvedValue(answer(503, { error: { message: "busy" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(new MetaClient("k", [0, 0]).json(opts)).rejects.toThrow("Meta API 503: busy");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry a bad answer or a non-transient error", async () => {
    const bad = vi.fn().mockResolvedValue(answer(200, { output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":"no"}' }] }] }));
    vi.stubGlobal("fetch", bad);
    await expect(new MetaClient("k", [0, 0]).json(opts)).rejects.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);

    const denied = vi.fn().mockResolvedValue(answer(401, { error: { message: "bad key" } }));
    vi.stubGlobal("fetch", denied);
    await expect(new MetaClient("k", [0, 0]).json(opts)).rejects.toThrow("Meta API 401: bad key");
    expect(denied).toHaveBeenCalledTimes(1);
  });
});
