import { describe, expect, it } from "vitest";
import { hashToken, loadTokens, parseBearer, requireBearer } from "../src/auth.js";
import { MemoryStore } from "../src/tools/memory-store.js";
import type { Request, Response } from "express";

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };
  return {
    res: res as unknown as Response,
    get status() {
      return statusCode;
    },
    get body() {
      return body;
    },
    headers,
  };
}

describe("auth", () => {
  it("loads one token per tool and rejects duplicates", () => {
    const tokens = loadTokens({
      PLUMB_TOKEN_CLAUDE_CODE: "aaa",
      PLUMB_TOKEN_CURSOR: "bbb",
    });
    expect(tokens.get("aaa")).toBe("claude_code");
    expect(tokens.get("bbb")).toBe("cursor");
    expect(() =>
      loadTokens({
        PLUMB_TOKEN_CLAUDE_CODE: "same",
        PLUMB_TOKEN_CURSOR: "same",
      }),
    ).toThrow(/duplicate/);
  });

  it("parses Bearer headers", () => {
    expect(parseBearer("Bearer secret")).toBe("secret");
    expect(parseBearer("bearer secret")).toBe("secret");
    expect(parseBearer("Basic x")).toBeUndefined();
    expect(parseBearer(undefined)).toBeUndefined();
  });

  it("requireBearer: env tokens act as the owner, personal tokens as their user, revoked or unknown ones are refused", async () => {
    const auth = new MemoryStore();
    const personal = await auth.createToken({ user_id: "user-b", tool: "cli", token_hash: hashToken("plumb_personal") });
    await auth.createToken({ user_id: "user-c", tool: "cli", token_hash: hashToken("plumb_revoked") });
    auth.tokens.at(-1)!.revoked_at = "2026-10-28T00:00:00Z";
    const mw = requireBearer({ tokens: loadTokens({ PLUMB_TOKEN_WEB: "web-secret" }), ownerUserId: "owner", auth });
    const run = async (header?: string) => {
      const req = { header: () => header } as unknown as Request;
      const r = mockRes();
      let passed = false;
      await mw(req, r.res, () => {
        passed = true;
      });
      return { req, status: r.status, passed };
    };

    const env = await run("Bearer web-secret");
    expect(env).toMatchObject({ passed: true });
    expect([env.req.plumbUserId, env.req.plumbTool]).toEqual(["owner", "web"]);

    const mine = await run("Bearer plumb_personal");
    expect([mine.passed, mine.req.plumbUserId, mine.req.plumbTool]).toEqual([true, "user-b", "cli"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(auth.tokens.find((t) => t.id === personal.id)!.last_used_at).toBeDefined();

    for (const h of ["Bearer plumb_revoked", "Bearer nope", undefined]) expect(await run(h)).toMatchObject({ passed: false, status: 401 });

    const noOwner = requireBearer({ tokens: loadTokens({ PLUMB_TOKEN_WEB: "web-secret" }) });
    const r = mockRes();
    await noOwner({ header: () => "Bearer web-secret" } as unknown as Request, r.res, () => {
      throw new Error("should not next");
    });
    expect(r.status).toBe(503);
  });
});
