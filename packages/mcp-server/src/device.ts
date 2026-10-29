// Device sign-in for `npx plumb init` (Oct 28, Usman OK'd). The same shape as
// OAuth device flow (RFC 8628), kept small:
// 1. POST /auth/device: the CLI gets a device_code (secret) and a user_code
//    (shown to the user) and opens the homepage at /device.
// 2. The user signs in on the homepage and approves the user_code. The web app
//    calls POST /auth/device/approve with the user's Supabase session token.
// 3. The CLI polls POST /auth/device/token with its device_code and gets a
//    personal token once. Only hashes of the device code and token are stored.
import { randomBytes, randomInt } from "node:crypto";
import type { Request, Response } from "express";
import { hashToken } from "./auth.js";
import type { AuthStore, Store } from "./tools/store.js";

const TTL_MS = 10 * 60 * 1000;
const POLL_SECONDS = 3;
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels: no words, no 0/O or 1/I mix-ups
export const DEFAULT_PROJECT = "My work";

export interface DeviceOptions {
  store: Store;
  auth: AuthStore;
  webUrl: string; // where /device lives
  /** The Supabase Auth user behind a session access token, or undefined if it isn't valid. */
  verifySession: (accessToken: string) => Promise<string | undefined>;
}

function userCode(): string {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${pick()}-${pick()}`;
}

const normalize = (code: unknown) => (typeof code === "string" ? code.trim().toUpperCase().replace(/[^A-Z]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2") : "");
const tool = (t: unknown) => (typeof t === "string" && /^[a-z_]{1,32}$/.test(t) ? t : "cli");

export function deviceRoutes(opts: DeviceOptions) {
  return {
    async start(req: Request, res: Response) {
      const device_code = randomBytes(32).toString("hex");
      const user_code = userCode();
      await opts.auth.createDeviceLogin({
        device_code_hash: hashToken(device_code),
        user_code,
        tool: tool(req.body?.tool),
        expires_at: new Date(Date.now() + TTL_MS).toISOString(),
      });
      res.json({
        device_code,
        user_code,
        verification_url: `${opts.webUrl.replace(/\/$/, "")}/device?code=${user_code}`,
        expires_in: TTL_MS / 1000,
        interval: POLL_SECONDS,
      });
    },

    async approve(req: Request, res: Response) {
      const session = /^Bearer\s+(\S+)$/i.exec(req.header("authorization") ?? "")?.[1];
      const userId = session ? await opts.verifySession(session) : undefined;
      if (!userId) {
        res.status(401).json({ error: "sign in first" });
        return;
      }
      const login = await opts.auth.findDeviceLogin({ user_code: normalize(req.body?.user_code) });
      if (!login || Date.parse(login.expires_at) < Date.now()) {
        res.status(404).json({ error: "that code is wrong or expired; run `npx plumb init` again" });
        return;
      }
      if (!(await opts.auth.approveDeviceLogin(login.id, userId, new Date().toISOString()))) {
        res.status(409).json({ error: "that code was already used" });
        return;
      }
      // A new user starts with one project, so full extraction has somewhere to go.
      const projects = (await opts.store.listProjects()).filter((p) => p.user_id === userId);
      if (projects.length === 0) await opts.store.createProject(DEFAULT_PROJECT, userId);
      res.json({ ok: true, tool: login.tool });
    },

    async token(req: Request, res: Response) {
      const code = typeof req.body?.device_code === "string" ? req.body.device_code : "";
      const login = code ? await opts.auth.findDeviceLogin({ device_code_hash: hashToken(code) }) : undefined;
      if (!login || Date.parse(login.expires_at) < Date.now()) {
        res.status(400).json({ error: "expired_token" });
        return;
      }
      if (!login.approved_at || !login.user_id) {
        res.status(400).json({ error: "authorization_pending" });
        return;
      }
      if (!(await opts.auth.markDeviceTokenIssued(login.id, new Date().toISOString()))) {
        res.status(400).json({ error: "already_used" });
        return;
      }
      const access_token = `plumb_${randomBytes(32).toString("base64url")}`;
      await opts.auth.createToken({ user_id: login.user_id, tool: login.tool, token_hash: hashToken(access_token) });
      res.json({ access_token, user_id: login.user_id });
    },
  };
}
