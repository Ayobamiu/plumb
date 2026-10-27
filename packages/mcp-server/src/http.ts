// HTTP surface for Plumb: Streamable MCP at /mcp, REST at /tools/:name,
// POST /ingest for write-back, GET /health for the host.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { IngestInput, MetaClient } from "@plumb/core";
import type { Express, Request, Response } from "express";
import { loadTokens, requireBearer, type TokenMap } from "./auth.js";
import { createPlumbMcp } from "./create-mcp.js";
import {
  callTool,
  ingest,
  isToolName,
  SupabaseStore,
  ToolError,
  type Store,
} from "./tools/index.js";

export interface HttpOptions {
  store?: Store;
  tokens?: TokenMap;
  /** Host for DNS-rebinding checks; use 0.0.0.0 in deploy. */
  host?: string;
}

function statusFor(err: ToolError): number {
  return err.code === "bad_input" ? 400 : 404;
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
  const store = opts.store ?? SupabaseStore.fromEnv();
  const tokens = opts.tokens ?? loadTokens();
  const host = opts.host ?? process.env.HOST ?? "0.0.0.0";
  const app = createMcpExpressApp({ host });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "plumb-mcp" });
  });

  // Auth for every mutating / listing surface. Health stays open for the host.
  app.use(["/mcp", "/tools", "/ingest"], requireBearer(tokens));

  app.post("/tools/:name", async (req: Request, res: Response) => {
    const raw = req.params.name;
    const name = Array.isArray(raw) ? raw[0] : raw;
    if (!name || !isToolName(name)) {
      res.status(404).json({ error: `unknown tool ${name ?? ""}`, code: "not_found" });
      return;
    }
    try {
      const result = await callTool(store, name, req.body);
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
      const result = await ingest(store, new MetaClient(), parsed.data);
      res.json(result);
    } catch (err) {
      sendToolError(res, err);
    }
  });

  // Stateless Streamable HTTP: one server + transport per request (Railway-safe).
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createPlumbMcp(store);
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
