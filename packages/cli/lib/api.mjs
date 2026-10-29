// Talking to the Plumb server. Every call but sign-in carries the personal token.
export class PlumbError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function post(api, path, body, token) {
  let res;
  try {
    res = await fetch(`${api.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    throw new PlumbError(`can't reach Plumb at ${api} (${err.message})`, 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new PlumbError(json.error || `HTTP ${res.status}`, res.status);
  return json;
}

// Index mode reads only a session's start and end (packages/core index-session.ts),
// so only those are sent: less to upload, and well under the server's body limit.
const HEAD_CHARS = 10_000;
const TAIL_CHARS = 30_000;

export function excerpt(text) {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text;
  return `${text.slice(0, HEAD_CHARS)}\n\n[... ${text.length - HEAD_CHARS - TAIL_CHARS} characters left out ...]\n\n${text.slice(-TAIL_CHARS)}`;
}

const FULL_CHARS = 180_000; // full mode reads the most recent 200k characters at most

/**
 * Save one session. Full mode (the default, Oct 29): Plumb writes down what the
 * session decided and planned, so it can tell later what stopped being true.
 * Index mode: only a title, a summary and personal or work. The workspace (the
 * folder it ran in, or "chats") picks the project.
 */
export function saveSession(config, { kind, external_id, title, text, at, workspace, index }) {
  const body = {
    ...(index && { index_only: true }),
    ...(workspace && { workspace }),
    source: { kind, external_id: String(external_id).slice(0, 200), ...(title && { title: title.slice(0, 200) }) },
    text: index ? excerpt(text) : text.length > FULL_CHARS ? text.slice(-FULL_CHARS) : text,
    ...(at && { at }),
  };
  return post(config.api, "/ingest", body, config.token);
}
