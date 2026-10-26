import { NextResponse } from "next/server";
import { exchangeCode, gmailOAuthConfigured } from "@/lib/gmail-oauth";
import { hasServerDb } from "@/lib/env";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * OAuth callback. Exchanges the code, then stores the refresh token via
 * vault.create_secret when the Vault helpers exist. Until Claude Code adds
 * that migration/RPC, we return the outcome without persisting secrets.
 */
export async function GET(request: Request) {
  if (!gmailOAuthConfigured()) {
    return NextResponse.json({ error: "Gmail OAuth is not configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.json({ error: `Google returned: ${error}` }, { status: 400 });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)plumb_gmail_oauth_state=([^;]+)/.exec(cookieHeader);
  const expected = match?.[1] ? decodeURIComponent(match[1]) : null;

  if (!code || !state || !expected || state !== expected) {
    return NextResponse.json({ error: "Invalid OAuth state or missing code" }, { status: 400 });
  }

  try {
    const tokens = await exchangeCode(code);
    const res = NextResponse.redirect(new URL("/?gmail=connected", request.url));
    res.cookies.set("plumb_gmail_oauth_state", "", { path: "/", maxAge: 0 });

    if (!tokens.refresh_token) {
      // Still redirect; access token alone is not enough for the watcher.
      res.headers.set(
        "x-plumb-gmail",
        "no-refresh-token; revoke prior grant and retry with prompt=consent",
      );
      return res;
    }

    if (!hasServerDb()) {
      return NextResponse.json(
        {
          error:
            "Got a refresh token but cannot store it: SUPABASE_SERVICE_ROLE_KEY is missing.",
          next: "Add the key, then ask Claude Code for a Vault store helper for gmail_refresh_token.",
        },
        { status: 503 },
      );
    }

    // Prefer Vault when available. Claude Code owns migrations; this RPC may not exist yet.
    const db = getServerSupabase();
    const { error: vaultError } = await db.rpc("plumb_store_gmail_refresh_token", {
      token: tokens.refresh_token,
    });

    if (vaultError) {
      return NextResponse.json(
        {
          ok: false,
          message:
            "OAuth succeeded, but storing the refresh token failed. Need Claude Code to add Vault helper plumb_store_gmail_refresh_token.",
          detail: vaultError.message,
        },
        { status: 501 },
      );
    }

    return res;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
