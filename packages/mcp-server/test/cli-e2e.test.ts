// The real CLI (packages/cli) against a local server: a new user signs in
// with the device flow, the CLI connects Claude Code and Cursor in a fake home
// folder, brings in fake past sessions (secrets stripped), and the user finds
// one by description. Nothing here touches the real home folder or network.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonModel } from "@plumb/core";
import { createHttpApp } from "../src/http.js";
import { MEMORY_USER, MemoryStore } from "../src/tools/memory-store.js";
import { callTool, ScopedStore } from "../src/tools/index.js";

const CLI = resolve(__dirname, "../../cli/bin/plumb.mjs");
const seen: string[] = [];
const model: JsonModel = {
  async json(opts) {
    seen.push(opts.user);
    if (opts.schemaName === "claims") {
      const gym = opts.user.includes("gym");
      return opts.parse.parse({ claims: [], contradicts: [], mentions: [], title: gym ? "Gym week plan" : "Auth refactor", summary: gym ? "A push pull legs week." : "Tokens per tool.", personal: gym }) as never;
    }
    if (opts.schemaName === "search") {
      const id = /\[([^\]]+)\][^\n]*\n  title: Gym week plan/.exec(opts.user)![1];
      return opts.parse.parse({ best: id, alternatives: [], why: "It's the gym plan." }) as never;
    }
    throw new Error(`unexpected ${opts.schemaName}`);
  },
};

function run(args: string[], env: NodeJS.ProcessEnv, onOut?: (s: string) => void, stdin?: string): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...process.env, ...env } });
    child.stdin.end(stdin ?? "");
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      onOut?.(out);
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

describe("npx plumb-ai init, end to end", () => {
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
    mkdirSync(join(home, "repo", ".git"), { recursive: true });
    const cwd = join(home, "repo", "src"); // a subfolder: the session lands in the repo's project
    writeFileSync(join(proj, "s-gym.jsonl"), JSON.stringify({ cwd, timestamp: "2026-10-20T10:00:00Z", message: { role: "user", content: "Plan my gym week. My key is META_MODEL_API_KEY=abcdef123456789" } }) + "\n");
    writeFileSync(join(proj, "s-auth.jsonl"), JSON.stringify({ cwd, timestamp: "2026-10-21T10:00:00Z", message: { role: "user", content: "Refactor auth to one token per tool" } }) + "\n");
    const env = { HOME: home, PLUMB_HOME: join(home, ".plumb"), PLUMB_CURSOR_DB: join(home, "none.vscdb"), PATH: "/usr/bin:/bin", PLUMB_SKIP_LAUNCHCTL: "1" };

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

      // Saved for the new user only, in full mode, in the project for the folder, with the secret gone before it left.
      const mine = store.sources.filter((s) => s.user_id === "user-new");
      expect(mine.map((s) => [s.external_id, s.title, s.label]).sort()).toEqual([["s-auth", "Auth refactor", undefined], ["s-gym", "Gym week plan", "personal"]]);
      expect(store.projects.filter((p) => p.user_id === "user-new").map((p) => [p.name, p.workspace]).sort()).toEqual([["My work", undefined], ["repo", join(home, "repo")]]);
      expect(seen.join("\n")).not.toContain("abcdef123456789");
      expect(seen.join("\n")).toContain("META_MODEL_API_KEY=[REDACTED]");
      const config = JSON.parse(readFileSync(join(home, ".plumb", "config.json"), "utf8"));
      expect(config.token).toMatch(/^plumb_/);

      // Running it again sends nothing new.
      const again = await run(["backfill", "--yes"], env);
      expect(again.out).toContain("saved 0, unchanged or empty 2");

      // A session that grew sends only its new turns, marked as a continuation.
      appendFileSync(join(proj, "s-auth.jsonl"), JSON.stringify({ cwd, timestamp: "2026-10-22T10:00:00Z", message: { role: "assistant", content: "Done: the login page now uses per-tool tokens." } }) + "\n");
      const grew = await run(["backfill", "--yes"], env);
      expect(grew.out).toContain("saved 1, unchanged or empty 1");
      const last = seen.at(-1)!;
      expect(last).toContain("This continues a session already saved");
      expect(last).toContain("Done: the login page now uses per-tool tokens.");
      expect(last).not.toContain("Refactor auth to one token per tool");

      // init again (after an update) keeps the working token: no new sign-in.
      const devicesBefore = store.devices.length;
      const reinit = await run(["init", "--api", api, "--yes", "--no-backfill"], env);
      expect(reinit.out).toContain("Already signed in");
      expect(store.devices.length).toBe(devicesBefore);
      expect(JSON.parse(readFileSync(join(home, ".plumb", "config.json"), "utf8")).token).toBe(config.token);

      // Session start in that repo: nothing changed yet, so no note.
      const start = (dir: string) => run(["hook-start", "claude-code"], env, undefined, JSON.stringify({ cwd: dir }));
      expect((await start(cwd)).out.trim()).toBe("");
      // A claim in the repo goes OUT; the next session start there says so, in Claude Code's format.
      const scoped = new ScopedStore(store, "user-new");
      const repoProject = store.projects.find((p) => p.user_id === "user-new" && p.workspace === join(home, "repo"))!;
      const rec: any = await callTool(scoped, "record_claims", { project_id: repoProject.id, source: { kind: "claude_code", external_id: "s-auth" }, extracted_by: "t", claims: [{ text: "Deploy the login page Friday", kind: "next_step", valid_from: "2026-10-21T00:00:00Z", reasons: [{ type: "until", at: "2027-01-01T00:00:00Z" }] }] }, { model: null });
      await callTool(scoped, "resolve_review", { claim_id: rec.claims[0].id, action: "confirm_out" }, { model: null });
      const note = JSON.parse((await start(cwd)).out);
      expect(note.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(note.hookSpecificOutput.additionalContext).toContain("- No longer true (in \"Auth refactor\"): Deploy the login page Friday. Went OUT because you confirmed it is no longer true.");
      expect((await start(cwd)).out.trim()).toBe(""); // shown once, then quiet

      // Claude Desktop's side: MCP over stdin through the local bridge.
      const rpc = (id: number, method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const bridge = await run(["mcp"], env, undefined, [
        rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        rpc(2, "tools/list"),
        rpc(3, "prompts/list"),
      ].join("\n") + "\n");
      const answers = bridge.out.trim().split("\n").map((l) => JSON.parse(l));
      expect(answers.map((a) => a.id)).toEqual([1, 2, 3]);
      expect(answers[0].result.instructions).toContain("When a message starts with /plumb");
      expect(answers[1].result.tools.map((t: any) => t.name)).toContain("find_context");
      expect(answers[2].result.prompts.map((t: any) => t.name)).toEqual(["plumb"]);

      // And the user finds it by description, through the same token.
      const found = await (await fetch(`${api}/tools/find_context`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` }, body: JSON.stringify({ query: "my gym plan from last week" }) })).json();
      expect(found.contexts.map((c: any) => [c.title, c.why])).toEqual([["Gym week plan", "It's the gym plan."]]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});
