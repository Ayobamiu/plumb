// HTTP surface for Plumb: Streamable MCP at /mcp, REST at /tools/:name,
// POST /ingest for write-back, GET /health for the host, /auth/device/* for
// `npx plumb init`. Per user (Oct 28): every request runs on a ScopedStore for
// the user behind its bearer token; only /sweep (the owner's watchers) sees all.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  IngestInput,
  ListLinkSuggestionsInput,
  MetaClient,
  ResolveLinkSuggestionInput,
} from "@plumb/core";
import type { Express, Request, Response } from "express";
import { loadTokens, requireBearer, type TokenMap } from "./auth.js";
import { createPlumbMcp } from "./create-mcp.js";
import { deviceRoutes } from "./device.js";
import { ScopedStore } from "./tools/scoped-store.js";
import {
  callTool,
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

export interface HttpOptions {
  store?: Store & AuthStore;
  tokens?: TokenMap;
  ownerUserId?: string; // env tokens belong to this user (PLUMB_OWNER_USER_ID)
  webUrl?: string; // the homepage, for device sign-in (PLUMB_WEB_URL)
  verifySession?: (accessToken: string) => Promise<string | undefined>;
  /** Host for DNS-rebinding checks; use 0.0.0.0 in deploy. */
  host?: string;
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
  const app = createMcpExpressApp({ host });
  const scoped = (req: Request) => new ScopedStore(store, req.plumbUserId!);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "plumb-mcp" });
  });

  // Device sign-in: no bearer token yet (approve checks the user's session instead).
  const device = deviceRoutes({
    store,
    auth: store,
    webUrl: opts.webUrl ?? process.env.PLUMB_WEB_URL ?? "http://localhost:3000",
    verifySession: opts.verifySession ?? ((t) => supabase!.verifySession(t)),
  });
  const safe = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    fn(req, res).catch((err) => sendToolError(res, err));
  };
  app.post("/auth/device", safe(device.start));
  app.post("/auth/device/approve", safe(device.approve));
  app.post("/auth/device/token", safe(device.token));

  // Auth for every mutating / listing surface. Health stays open for the host.
  app.use(["/mcp", "/tools", "/ingest", "/links", "/sweep"], requireBearer({ tokens, ownerUserId, auth: store }));

  app.post("/tools/:name", async (req: Request, res: Response) => {
    const raw = req.params.name;
    const name = Array.isArray(raw) ? raw[0] : raw;
    if (!name || !isToolName(name)) {
      res.status(404).json({ error: `unknown tool ${name ?? ""}`, code: "not_found" });
      return;
    }
    try {
      const result = await callTool(scoped(req), name, req.body);
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
    try {
      const result = await ingest(scoped(req), new MetaClient(), parsed.data);
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
