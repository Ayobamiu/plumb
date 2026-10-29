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

const MAX_CHARS = 180_000; // the server reads at most 200k

/** Save one session in index mode: a title, a summary and personal or work. */
export function indexSession(config, { kind, external_id, title, text, at }) {
  const body = {
    index_only: true,
    source: { kind, external_id: String(external_id).slice(0, 200), ...(title && { title: title.slice(0, 200) }) },
    text: text.length > MAX_CHARS ? text.slice(-MAX_CHARS) : text,
    ...(at && { at }),
  };
  return post(config.api, "/ingest", body, config.token);
}
