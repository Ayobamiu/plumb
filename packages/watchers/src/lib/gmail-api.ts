/** Thin Gmail API client (fetch only). Never logs tokens or full bodies. */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export type AccessToken = { access_token: string; expires_at: number };

export async function refreshAccessToken(refreshToken: string): Promise<AccessToken> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description ?? json.error ?? `token refresh HTTP ${res.status}`);
  }
  const expiresIn = Number(json.expires_in ?? 3600);
  return {
    access_token: json.access_token,
    expires_at: Date.now() + Math.max(60, expiresIn - 60) * 1000,
  };
}

async function gmailGet<T>(accessToken: string, path: string): Promise<{ ok: true; data: T } | { ok: false; status: number; body: string }> {
  const res = await fetch(`${GMAIL}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body };
  return { ok: true, data: JSON.parse(body) as T };
}

export type GmailProfile = { emailAddress: string; historyId: string };

export async function getProfile(accessToken: string): Promise<GmailProfile> {
  const r = await gmailGet<GmailProfile>(accessToken, "/profile");
  if (!r.ok) throw new Error(`gmail profile HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  return r.data;
}

export type HistoryList = {
  history?: Array<{
    id: string;
    messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }>;
  }>;
  historyId: string;
  nextPageToken?: string;
};

/** List history since startHistoryId. Returns status 404 when the id is too old. */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
  pageToken?: string,
): Promise<{ status: number; data?: HistoryList; body?: string }> {
  const qs = new URLSearchParams({
    startHistoryId,
    historyTypes: "messageAdded",
  });
  if (pageToken) qs.set("pageToken", pageToken);
  const r = await gmailGet<HistoryList>(accessToken, `/history?${qs}`);
  if (!r.ok) return { status: r.status, body: r.body };
  return { status: 200, data: r.data };
}

export type MessageMeta = {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
};

export async function getMessageMeta(accessToken: string, id: string): Promise<MessageMeta> {
  // Repeated metadataHeaders: Subject + From. Avoid URLSearchParams (it collapses dup keys).
  const path = `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`;
  const r = await gmailGet<MessageMeta>(accessToken, path);
  if (!r.ok) throw new Error(`gmail message ${id} HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  return r.data;
}

export function header(msg: MessageMeta, name: string): string | undefined {
  const found = msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found?.value;
}
