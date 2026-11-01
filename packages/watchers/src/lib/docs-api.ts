/**
 * Docs MCP client (Usman's text-editor / docs app).
 * Calls Streamable HTTP MCP: list_documents and read_document.
 */
import { createHash } from "node:crypto";

export type DocListEntry = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
};

export type DocTab = {
  id: string;
  title: string;
  body: string;
};

export type DocRead = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  tabs: DocTab[];
};

function docsUrl(): string {
  const raw = process.env.PLUMB_DOCS_URL?.trim();
  if (!raw) throw new Error("PLUMB_DOCS_URL is not set");
  return raw.replace(/\/$/, "");
}

function docsToken(): string {
  const t = process.env.PLUMB_DOCS_TOKEN?.trim();
  if (!t) throw new Error("PLUMB_DOCS_TOKEN is not set");
  return t.startsWith("Bearer ") ? t.slice(7).trim() : t;
}

/** True when env points at a docs MCP the worker can call. */
export function docsConfigured(): boolean {
  return Boolean(process.env.PLUMB_DOCS_URL?.trim() && process.env.PLUMB_DOCS_TOKEN?.trim());
}

export function tabBodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

async function mcpCall(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
  const res = await fetch(`${docsUrl()}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${docsToken()}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`docs MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = parseMcpResponse(text);
  if (json.error) {
    throw new Error(`docs MCP error: ${JSON.stringify(json.error)}`);
  }
  const result = json.result as
    | { content?: { type: string; text?: string }[]; isError?: boolean }
    | undefined;
  if (!result) throw new Error("docs MCP: empty result");
  if (result.isError) {
    throw new Error(`docs tool error: ${result.content?.map((c) => c.text).join(" ") ?? ""}`);
  }
  const blob = result.content?.find((c) => c.type === "text" && c.text)?.text;
  if (!blob) throw new Error("docs MCP: no text content");
  return JSON.parse(blob) as unknown;
}

function parseMcpResponse(raw: string): {
  result?: unknown;
  error?: unknown;
} {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as { result?: unknown; error?: unknown };
  }
  // SSE: take the last data: line
  let last: string | undefined;
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) last = line.slice(5).trim();
  }
  if (!last) throw new Error(`docs MCP: unparseable response ${trimmed.slice(0, 200)}`);
  return JSON.parse(last) as { result?: unknown; error?: unknown };
}

export async function listDocuments(): Promise<DocListEntry[]> {
  const raw = (await mcpCall("list_documents")) as { documents?: DocListEntry[] };
  return raw.documents ?? [];
}

export async function readDocument(id: string): Promise<DocRead> {
  const raw = (await mcpCall("read_document", { id })) as {
    id?: string;
    title?: string;
    revision?: number;
    updatedAt?: string;
    tabs?: DocTab[];
  };
  if (!raw.id || !raw.title || typeof raw.revision !== "number" || !Array.isArray(raw.tabs)) {
    throw new Error(`docs read_document: unexpected shape for ${id}`);
  }
  return {
    id: raw.id,
    title: raw.title,
    revision: raw.revision,
    updatedAt: String(raw.updatedAt ?? ""),
    tabs: raw.tabs.map((t) => ({
      id: String(t.id),
      title: String(t.title ?? ""),
      body: String(t.body ?? ""),
    })),
  };
}
