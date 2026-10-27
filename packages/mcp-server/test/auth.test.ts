import { describe, expect, it } from "vitest";
import { loadTokens, parseBearer, requireBearer } from "../src/auth.js";
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

  it("requireBearer accepts a known token and rejects others", () => {
    const tokens = loadTokens({ PLUMB_TOKEN_WEB: "web-secret" });
    const mw = requireBearer(tokens);

    const okReq = { header: () => "Bearer web-secret" } as unknown as Request;
    let nextCalled = false;
    const ok = mockRes();
    mw(okReq, ok.res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(okReq.plumbTool).toBe("web");

    const bad = mockRes();
    mw({ header: () => "Bearer nope" } as unknown as Request, bad.res, () => {
      throw new Error("should not next");
    });
    expect(bad.status).toBe(401);

    const missing = mockRes();
    mw({ header: () => undefined } as unknown as Request, missing.res, () => {
      throw new Error("should not next");
    });
    expect(missing.status).toBe(401);

    const empty = mockRes();
    requireBearer(new Map())(
      { header: () => "Bearer x" } as unknown as Request,
      empty.res,
      () => {
        throw new Error("should not next");
      },
    );
    expect(empty.status).toBe(503);
  });
});
