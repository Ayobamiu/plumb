// Bearer auth for the remote MCP server. One token per tool so a leaked token
// can be revoked alone (tab 6). Any configured token unlocks the same tools;
// the matched label is only for logs.
import type { NextFunction, Request, Response } from "express";

export const TOOL_LABELS = [
  "claude_code",
  "cursor",
  "claude_chat",
  "watchers",
  "web",
] as const;

export type ToolLabel = (typeof TOOL_LABELS)[number];

const ENV_KEYS: Record<ToolLabel, string> = {
  claude_code: "PLUMB_TOKEN_CLAUDE_CODE",
  cursor: "PLUMB_TOKEN_CURSOR",
  claude_chat: "PLUMB_TOKEN_CLAUDE_CHAT",
  watchers: "PLUMB_TOKEN_WATCHERS",
  web: "PLUMB_TOKEN_WEB",
};

export type TokenMap = Map<string, ToolLabel>;

/** Build the token → tool map from env. Empty map means auth is misconfigured. */
export function loadTokens(env: NodeJS.ProcessEnv = process.env): TokenMap {
  const map: TokenMap = new Map();
  for (const label of TOOL_LABELS) {
    const raw = env[ENV_KEYS[label]]?.trim();
    if (!raw) continue;
    if (map.has(raw)) {
      throw new Error(`duplicate bearer token for ${label} and ${map.get(raw)}`);
    }
    map.set(raw, label);
  }
  return map;
}

export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

declare global {
  namespace Express {
    interface Request {
      plumbTool?: ToolLabel;
    }
  }
}

/** Reject requests with no matching bearer token. */
export function requireBearer(tokens: TokenMap) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (tokens.size === 0) {
      res.status(503).json({ error: "no bearer tokens configured" });
      return;
    }
    const token = parseBearer(req.header("authorization"));
    if (!token) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="plumb"');
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    const label = tokens.get(token);
    if (!label) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="plumb"');
      res.status(401).json({ error: "invalid bearer token" });
      return;
    }
    req.plumbTool = label;
    next();
  };
}
