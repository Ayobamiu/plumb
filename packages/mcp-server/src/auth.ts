// Bearer auth for the remote MCP server. Per user (Oct 28): a token belongs to
// a user, and every request is scoped to that user. Two kinds of token:
// - Personal tokens from `npx plumb init` (table api_tokens, hash only).
// - The env tokens below, one per tool, which belong to the owner
//   (PLUMB_OWNER_USER_ID). The tool label is only for logs.
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AuthStore } from "./tools/store.js";

export const TOOL_LABELS = [
  "claude_code",
  "cursor",
  "claude_chat",
  "muse_code",
  "watchers",
  "web",
] as const;

export type ToolLabel = (typeof TOOL_LABELS)[number];

const ENV_KEYS: Record<ToolLabel, string> = {
  claude_code: "PLUMB_TOKEN_CLAUDE_CODE",
  cursor: "PLUMB_TOKEN_CURSOR",
  claude_chat: "PLUMB_TOKEN_CLAUDE_CHAT",
  muse_code: "PLUMB_TOKEN_MUSE_CODE",
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

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

declare global {
  namespace Express {
    interface Request {
      plumbTool?: string;
      plumbUserId?: string;
    }
  }
}

export interface BearerOptions {
  tokens: TokenMap; // env tokens, owner's
  ownerUserId?: string; // PLUMB_OWNER_USER_ID
  auth?: AuthStore; // personal tokens
}

/** Reject requests with no valid bearer token; set req.plumbUserId and req.plumbTool. */
export function requireBearer(opts: BearerOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const deny = (error: string) => {
      res.setHeader("WWW-Authenticate", 'Bearer realm="plumb"');
      res.status(401).json({ error });
    };
    const token = parseBearer(req.header("authorization"));
    if (!token) return deny("missing bearer token");

    const label = opts.tokens.get(token);
    if (label) {
      if (!opts.ownerUserId) {
        res.status(503).json({ error: "PLUMB_OWNER_USER_ID is not set" });
        return;
      }
      req.plumbTool = label;
      req.plumbUserId = opts.ownerUserId;
      return next();
    }

    try {
      const found = opts.auth ? await opts.auth.findToken(hashToken(token)) : undefined;
      if (!found || found.revoked_at) return deny("invalid bearer token");
      req.plumbTool = found.tool;
      req.plumbUserId = found.user_id;
      void opts.auth!.touchToken(found.id, new Date().toISOString()).catch(() => {});
      next();
    } catch (err) {
      console.error("token lookup failed", err);
      res.status(503).json({ error: "could not check the token, try again" });
    }
  };
}
