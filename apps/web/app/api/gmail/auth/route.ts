import { NextResponse } from "next/server";
import { buildAuthUrl, gmailOAuthConfigured, newOAuthState } from "@/lib/gmail-oauth";

/**
 * Starts Gmail OAuth (gmail.readonly). Visit /api/gmail/auth while signed in locally.
 * Google Cloud: OAuth consent in testing mode, Usman as the only test user.
 */
export async function GET() {
  if (!gmailOAuthConfigured()) {
    return NextResponse.json(
      {
        error:
          "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI in .env",
        setup: [
          "Create a Google Cloud project (or reuse one).",
          "Configure OAuth consent screen in Testing; add Usman as the only test user.",
          "Create an OAuth client (Web). Redirect URI: http://localhost:3000/api/gmail/callback",
          "Enable Gmail API. Scope is gmail.readonly only.",
        ],
      },
      { status: 503 },
    );
  }

  const state = newOAuthState();
  const url = buildAuthUrl(state);
  const res = NextResponse.redirect(url);
  res.cookies.set("plumb_gmail_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return res;
}
