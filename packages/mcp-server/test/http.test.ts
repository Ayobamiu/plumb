import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "../src/http.js";
import { MemoryStore } from "../src/tools/memory-store.js";

async function withServer(
  run: (base: string) => Promise<void>,
): Promise<void> {
  const store = new MemoryStore();
  store.addProject("Http test");
  const tokens = new Map([["test-token", "web" as const]]);
  const app = createHttpApp({ store, tokens, host: "127.0.0.1" });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe("http transport", () => {
  it("serves health without auth", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    });
  });

  it("rejects tools without a bearer token", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/tools/list_projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    });
  });

  it("lists projects through POST /tools/:name", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/tools/list_projects`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: "{}",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { projects: { name: string }[] };
      expect(body.projects.some((p) => p.name === "Http test")).toBe(true);
    });
  });

  it("answers MCP initialize over POST /mcp", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.1" },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { serverInfo?: { name: string } };
      };
      expect(body.result?.serverInfo?.name).toBe("plumb");
    });
  });
});
