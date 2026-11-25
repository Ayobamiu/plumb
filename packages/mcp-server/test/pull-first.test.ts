import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpApp } from "../src/http.js";
import { MEMORY_USER, MemoryStore } from "../src/tools/memory-store.js";
import { shouldIndexOnly, sweepEnabled } from "../src/pull-first.js";

describe("shouldIndexOnly", () => {
  const session = {
    source: { kind: "cursor" as const, external_id: "c1" },
    text: "hello",
  };

  it("indexes tool sessions by default", () => {
    expect(shouldIndexOnly(session, {})).toBe(true);
  });

  it("skips when caller already set index_only", () => {
    expect(shouldIndexOnly({ ...session, index_only: true }, {})).toBe(false);
  });

  it("keeps docs on the full path", () => {
    expect(
      shouldIndexOnly(
        { source: { kind: "doc", external_id: "d1" }, text: "slide" },
        {},
      ),
    ).toBe(false);
  });

  it("allows full extract when PLUMB_FULL_EXTRACT=1", () => {
    expect(shouldIndexOnly(session, { PLUMB_FULL_EXTRACT: "1" })).toBe(false);
  });

  it("allows full extract for allowlisted projects", () => {
    expect(
      shouldIndexOnly(
        { ...session, project_id: "proj-a" },
        { PLUMB_FULL_EXTRACT_PROJECTS: "proj-a,proj-b" },
      ),
    ).toBe(false);
    expect(
      shouldIndexOnly(
        { ...session, project_id: "other" },
        { PLUMB_FULL_EXTRACT_PROJECTS: "proj-a" },
      ),
    ).toBe(true);
  });
});

describe("sweepEnabled", () => {
  it("is off unless PLUMB_ENABLE_SWEEP=1", () => {
    expect(sweepEnabled({})).toBe(false);
    expect(sweepEnabled({ PLUMB_ENABLE_SWEEP: "1" })).toBe(true);
  });
});

describe("http /ingest pull-first", () => {
  it("indexes a cursor session that did not send index_only", async () => {
    const store = new MemoryStore();
    store.addProject("Pull first");
    const tokens = new Map([["test-token", "web" as const]]);
    let indexed = 0;
    const model = {
      async json(opts: { schemaName: string; parse: { parse: (v: unknown) => unknown } }) {
        if (opts.schemaName !== "index") throw new Error(`unexpected ${opts.schemaName}`);
        indexed++;
        return opts.parse.parse({
          title: "Catalog session",
          summary: "A cheap index of the session.",
          personal: false,
        });
      },
    };
    const app = createHttpApp({
      store,
      tokens,
      ownerUserId: MEMORY_USER,
      host: "127.0.0.1",
      model: model as never,
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${base}/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          workspace: "/tmp/pull-first",
          source: { kind: "cursor", external_id: "conv-pull-1" },
          text: "User:\nship pull-first\n\nCursor:\ndone",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        indexed_only?: boolean;
        claims: unknown[];
      };
      expect(body.indexed_only).toBe(true);
      expect(body.claims).toEqual([]);
      expect(indexed).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("skips Muse when the host already sent summary", async () => {
    const store = new MemoryStore();
    store.addProject("Host index");
    const tokens = new Map([["test-token", "web" as const]]);
    let indexed = 0;
    const model = {
      async json() {
        indexed++;
        throw new Error("model should not run");
      },
    };
    const app = createHttpApp({
      store,
      tokens,
      ownerUserId: MEMORY_USER,
      host: "127.0.0.1",
      model: model as never,
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          workspace: "/tmp/host-index",
          source: { kind: "cursor", external_id: "conv-host-1", title: "Host indexed" },
          text: "User:\nhello\n\nCursor:\nworld",
          summary: "Cursor session about host-indexed ingest.",
          personal: false,
          indexed_by: "local/cursor/index.v1",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        indexed_only?: boolean;
        extracted_by?: string;
        event?: { summary?: string };
      };
      expect(body.indexed_only).toBe(true);
      expect(body.extracted_by).toBe("local/cursor/index.v1");
      expect(body.event?.summary).toContain("host-indexed");
      expect(indexed).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
