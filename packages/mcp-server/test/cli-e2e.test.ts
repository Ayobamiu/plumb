// The real CLI (packages/cli) against a local server: a new user signs in
// with the device flow, the CLI connects Claude Code and Cursor in a fake home
// folder, brings in fake past sessions (secrets stripped), and the user finds
// one by description. Nothing here touches the real home folder or network.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonModel } from "@plumb/core";
import { createHttpApp } from "../src/http.js";
import { MEMORY_USER, MemoryStore } from "../src/tools/memory-store.js";

const CLI = resolve(__dirname, "../../cli/bin/plumb.mjs");
const seen: string[] = [];
const model: JsonModel = {
  async json(opts) {
    seen.push(opts.user);
    if (opts.schemaName === "index") return opts.parse.parse({ title: opts.user.includes("gym") ? "Gym week plan" : "Auth refactor", summary: opts.user.includes("gym") ? "A push pull legs week." : "Tokens per tool.", personal: opts.user.includes("gym") }) as never;
    if (opts.schemaName === "search") {
      const id = /\[([^\]]+)\][^\n]*\n  title: Gym week plan/.exec(opts.user)![1];
      return opts.parse.parse({ best: id, alternatives: [], why: "It's the gym plan." }) as never;
    }
    throw new Error(`unexpected ${opts.schemaName}`);
  },
};

function run(args: string[], env: NodeJS.ProcessEnv, onOut?: (s: string) => void): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      onOut?.(out);
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

describe("npx plumb-cli init, end to end", () => {
  it("signs in a new user, installs, backfills with secrets stripped, and search finds the session", async () => {
    const store = new MemoryStore();
    const app = createHttpApp({ store, tokens: new Map(), ownerUserId: MEMORY_USER, host: "127.0.0.1", webUrl: "http://web.test", verifySession: async (t) => (t === "s" ? "user-new" : undefined), model });
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const home = mkdtempSync(join(tmpdir(), "plumb-e2e-"));
    const proj = join(home, ".claude", "projects", "-repo");
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(proj, "s-gym.jsonl"), JSON.stringify({ timestamp: "2026-10-20T10:00:00Z", message: { role: "user", content: "Plan my gym week. My key is META_MODEL_API_KEY=abcdef123456789" } }) + "\n");
    writeFileSync(join(proj, "s-auth.jsonl"), JSON.stringify({ timestamp: "2026-10-21T10:00:00Z", message: { role: "user", content: "Refactor auth to one token per tool" } }) + "\n");
    const env = { HOME: home, PLUMB_HOME: join(home, ".plumb"), PLUMB_CURSOR_DB: join(home, "none.vscdb"), PATH: "/usr/bin:/bin" };

    try {
      let approved = false;
      const init = await run(["init", "--api", api, "--yes"], env, (out) => {
        const code = /Your code: ([A-Z]{4}-[A-Z]{4})/.exec(out)?.[1];
        if (code && !approved) {
          approved = true;
          void fetch(`${api}/auth/device/approve`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer s" }, body: JSON.stringify({ user_code: code }) });
        }
      });
      expect(init.code, init.out).toBe(0);
      expect(init.out).toContain("Signed in.");
      expect(init.out).toContain("Claude Code: hooks in ~/.claude/settings.json");
      expect(init.out).toContain("saved 2");

      // Saved for the new user only, as index mode, with the secret gone before it left.
      const mine = store.sources.filter((s) => s.user_id === "user-new");
      expect(mine.map((s) => [s.external_id, s.title, s.label]).sort()).toEqual([["s-auth", "Auth refactor", undefined], ["s-gym", "Gym week plan", "personal"]]);
      expect(seen.join("\n")).not.toContain("abcdef123456789");
      expect(seen.join("\n")).toContain("META_MODEL_API_KEY=[REDACTED]");
      const config = JSON.parse(readFileSync(join(home, ".plumb", "config.json"), "utf8"));
      expect(config.token).toMatch(/^plumb_/);

      // Running it again sends nothing new.
      const again = await run(["backfill", "--yes"], env);
      expect(again.out).toContain("saved 0, unchanged or empty 2");

      // And the user finds it by description, through the same token.
      const found = await (await fetch(`${api}/tools/find_context`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` }, body: JSON.stringify({ query: "my gym plan from last week" }) })).json();
      expect(found.contexts.map((c: any) => [c.title, c.why])).toEqual([["Gym week plan", "It's the gym plan."]]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});
