// HTTP surface for Plumb: Streamable MCP at /mcp, REST at /tools/:name,
// POST /ingest for write-back, GET /health for the host, /auth/device/* for
// `npx plumb init`. Per user (Oct 28): every request runs on a ScopedStore for
// the user behind its bearer token; only /sweep (the owner's watchers) sees all.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express from "express";
import {
  IngestInput,
  ListLinkSuggestionsInput,
  MetaClient,
  ResolveLinkSuggestionInput,
  type JsonModel,
} from "@plumb/core";
import type { Express, Request, Response } from "express";
import { loadTokens, requireBearer, type TokenMap } from "./auth.js";
import { createPlumbMcp } from "./create-mcp.js";
import { deviceRoutes } from "./device.js";
import { ScopedStore } from "./tools/scoped-store.js";
import {
  callTool,
  hasClientIndex,
  ingest,
  isToolName,
  listLinkSuggestions,
  resolveLinkSuggestion,
  sweep,
  SupabaseStore,
  ToolError,
  type AuthStore,
  type Store,
} from "./tools/index.js";
import { shouldIndexOnly, sweepEnabled } from "./pull-first.js";
import { claimsEnabled, museIndexEnabled } from "./claims.js";

/** Placeholder when the caller already indexed; MetaClient is never constructed. */
const CLIENT_INDEX_MODEL: JsonModel = {
  json: async () => {
    throw new Error("MetaClient not used for client-indexed ingest");
  },
};

export interface HttpOptions {
  store?: Store & AuthStore;
  tokens?: TokenMap;
  ownerUserId?: string; // env tokens belong to this user (PLUMB_OWNER_USER_ID)
  webUrl?: string; // the homepage, for device sign-in (PLUMB_WEB_URL)
  verifySession?: (accessToken: string) => Promise<string | undefined>;
  model?: JsonModel; // tests; the real server uses Muse Spark (META_MODEL_API_KEY)
  /** Host for DNS-rebinding checks; use 0.0.0.0 in deploy. */
  host?: string;
}

/** Legacy cost pause: blocks the sleep-time sweep only. Ingest stays on (index). */
function extractionPaused(now = Date.now()): boolean {
  if (process.env.PLUMB_PAUSE_EXTRACTION === "1") return true;
  if (process.env.PLUMB_PAUSE_EXTRACTION === "0") return false;
  const until = process.env.PLUMB_PAUSE_UNTIL?.trim() || "2026-11-10T00:00:00.000Z";
  const t = Date.parse(until);
  return Number.isFinite(t) && now < t;
}

function statusFor(err: ToolError): number {
  if (err.code === "bad_input") return 400;
  if (err.code === "unavailable") return 503;
  return 404;
}

function sendToolError(res: Response, err: unknown): void {
  if (err instanceof ToolError) {
    res.status(statusFor(err)).json({ error: err.message, code: err.code });
    return;
  }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

export function createHttpApp(opts: HttpOptions = {}): Express {
  const supabase = opts.store ? undefined : SupabaseStore.fromEnv();
  const store: Store & AuthStore = opts.store ?? supabase!;
  const tokens = opts.tokens ?? loadTokens();
  const ownerUserId = opts.ownerUserId ?? process.env.PLUMB_OWNER_USER_ID?.trim();
  const host = opts.host ?? process.env.HOST ?? "0.0.0.0";
  // Like the SDK's createMcpExpressApp, but with a body limit that fits a long
  // session: /ingest takes up to 200k characters, and Express's default 100 KB
  // turned long transcripts into HTTP 413 (Oct 29 backfill: 23 of 113).
  const app = express();
  if (["127.0.0.1", "localhost", "::1"].includes(host)) app.use(localhostHostValidation());
  app.use(express.json({ limit: "2mb" }));
  const scoped = (req: Request) => new ScopedStore(store, req.plumbUserId!);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "plumb-mcp" });
  });

  // Device sign-in: no bearer token yet (approve checks the user's session instead).
  const verifySession = opts.verifySession ?? ((t: string) => supabase!.verifySession(t));
  const device = deviceRoutes({
    store,
    auth: store,
    webUrl: opts.webUrl ?? process.env.PLUMB_WEB_URL ?? "http://localhost:3000",
    verifySession,
  });
  const safe = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    fn(req, res).catch((err) => sendToolError(res, err));
  };
  app.post("/auth/device", safe(device.start));
  app.post("/auth/device/approve", safe(device.approve));
  app.post("/auth/device/token", safe(device.token));

  // Auth for every mutating / listing surface. Health stays open for the host.
  app.use(["/mcp", "/tools", "/ingest", "/links", "/sweep", "/auth/delete-account"], requireBearer({ tokens, ownerUserId, auth: store, verifySession }));

  // Delete my account (Oct 30): the caller's own rows, never anyone else's. The
  // owner's account can't be deleted this way: the watchers and env tokens use it.
  app.post("/auth/delete-account", safe(async (req, res) => {
    if (req.body?.confirm !== "delete") {
      res.status(400).json({ error: 'send { "confirm": "delete" }', code: "bad_input" });
      return;
    }
    if (req.plumbUserId === ownerUserId) {
      res.status(403).json({ error: "the owner account can't be deleted this way" });
      return;
    }
    res.json({ deleted: await store.deleteUser(req.plumbUserId!) });
  }));

  app.post("/tools/:name", async (req: Request, res: Response) => {
    const raw = req.params.name;
    const name = Array.isArray(raw) ? raw[0] : raw;
    if (!name || !isToolName(name)) {
      res.status(404).json({ error: `unknown tool ${name ?? ""}`, code: "not_found" });
      return;
    }
    try {
      const result = await callTool(scoped(req), name, req.body, opts.model ? { model: opts.model } : {});
      res.json(result);
    } catch (err) {
      sendToolError(res, err);
    }
  });

  app.post("/ingest", async (req: Request, res: Response) => {
    const parsed = IngestInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message, code: "bad_input" });
      return;
    }
    // Pull-first: tool sessions index by default (title + summary). Full claim
    // extract only when PLUMB_FULL_EXTRACT=1 or the project is allowlisted.
    let data = parsed.data;
    // Claims suspended: every ingest (docs and email too) is index-only.
    if (!claimsEnabled() && !data.index_only) data = { ...data, index_only: true };
    if (shouldIndexOnly(data)) {
      data = { ...data, index_only: true };
      console.log(
        JSON.stringify({
          ingest_pull_first: true,
          kind: data.source.kind,
          external_id: data.source.external_id,
        }),
      );
    }
    try {
      // Host-indexed sessions never touch Muse; don't require META_MODEL_API_KEY.
      const model =
        opts.model ?? (hasClientIndex(data) || (data.index_only && !museIndexEnabled()) ? CLIENT_INDEX_MODEL : new MetaClient());
      const result = await ingest(scoped(req), model, data);
      res.json(result);
    } catch (err) {
      sendToolError(res, err);
    }
  });

  // Link suggestions (homepage Accept / Dismiss). Not MCP tools.
  app.post("/links", async (req: Request, res: Response) => {
    const parsed = ListLinkSuggestionsInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message, code: "bad_input" });
      return;
    }
    try {
      res.json(await listLinkSuggestions(scoped(req), parsed.data));
    } catch (err) {
      sendToolError(res, err);
    }
  });

  app.post("/links/resolve", async (req: Request, res: Response) => {
    const parsed = ResolveLinkSuggestionInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message, code: "bad_input" });
      return;
    }
    try {
      res.json(await resolveLinkSuggestion(scoped(req), parsed.data));
    } catch (err) {
      sendToolError(res, err);
    }
  });

  // Sleep-time sweep: watchers call this every few hours.
  app.post("/sweep", async (req: Request, res: Response) => {
    // Every user's projects: only the owner's watchers may start it.
    if (req.plumbTool !== "watchers") {
      res.status(403).json({ error: "only the watchers token can run the sweep" });
      return;
    }
    // Pull-first: sweep (what changed) is opt-in via PLUMB_ENABLE_SWEEP=1.
    // Legacy pause also keeps it off.
    if (!claimsEnabled() || !sweepEnabled() || extractionPaused()) {
      console.log(JSON.stringify({ sweep_pause: true, enabled: sweepEnabled(), paused: extractionPaused() }));
      res.json({
        since: new Date().toISOString(),
        until: new Date().toISOString(),
        rechecked: 0,
        events: 0,
        transitions: [],
        faded: [],
        links: 0,
        expired: 0,
        paused: true,
      });
      return;
    }
    try {
      if (!process.env.META_MODEL_API_KEY?.trim()) {
        res.status(503).json({ error: "META_MODEL_API_KEY is not set", code: "bad_input" });
        return;
      }
      const result = await sweep(store, new MetaClient());
      res.json(result);
    } catch (err) {
      sendToolError(res, err);
    }
  });

  // Stateless Streamable HTTP: one server + transport per request (Railway-safe).
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createPlumbMcp(scoped(req));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("mcp error", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed on this server." },
      id: null,
    });
  });

  // Quiet 404 for everything else.
  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  return app;
}

export type { Express };
