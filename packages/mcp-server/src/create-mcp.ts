// Builds an McpServer that exposes Contract tools via callTool, plus @ session
// resources (listContexts / readContext) when those exports are present.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  callTool,
  ToolError,
  toolDescriptions,
  toolInputs,
  type Store,
  type ToolName,
} from "./tools/index.js";
import * as tools from "./tools/index.js";
import { z } from "zod";

type ContextEntry = {
  uri: string;
  name: string;
  description?: string;
  source_id?: string;
  project_id?: string;
  tool?: string;
  title?: string;
  last_at?: string;
};

type ListContextsFn = (
  store: Store,
  input: { project_id?: string; query?: string; limit?: number },
) => Promise<{ contexts: ContextEntry[] } | ContextEntry[]>;

type ReadContextFn = (
  store: Store,
  input: { uri: string },
) => Promise<{ uri: string; name: string; markdown: string }>;

function asListContexts(): ListContextsFn | undefined {
  const fn = (tools as { listContexts?: ListContextsFn }).listContexts;
  return typeof fn === "function" ? fn : undefined;
}

function asReadContext(): ReadContextFn | undefined {
  const fn = (tools as { readContext?: ReadContextFn }).readContext;
  return typeof fn === "function" ? fn : undefined;
}

async function listedContexts(store: Store, query?: string): Promise<ContextEntry[]> {
  const list = asListContexts();
  if (!list) return [];
  // Newest first from the store; keep that order for completion.
  const result = await list(store, { query, limit: 50 });
  return Array.isArray(result) ? result : (result.contexts ?? []);
}

function uriScheme(uri: string): string {
  const i = uri.indexOf("://");
  return i > 0 ? uri.slice(0, i) : "";
}

function uriSlug(uri: string): string {
  const i = uri.indexOf("://");
  return i >= 0 ? uri.slice(i + 3) : uri;
}

// Claude Desktop and claude.ai have no custom slash commands, so /plumb lives
// here: every MCP client gets these instructions, nobody pastes anything (Oct 30).
const INSTRUCTIONS = `Plumb brings in context from the user's other AI tools, corrected for what changed since.
When a message starts with /plumb, or the user refers to work done in another tool:
1. If there are no words after /plumb, call list_projects, pick the project this work belongs to, and call get_project_state with its project_id. Say what changed (OUT, or May be out of date) with the one-line reason, then what is current. Stop.
2. If they ask about a span of time across sessions ("what did I build this week"), call recent_work and summarize. Stop.
2b. Otherwise call find_context with the user's words as typed, not keywords.
3. If the first why starts "Not a clear match", or there are no results, don't call get_context. Say it wasn't found and list any near misses with their why.
4. If the first why starts "Basic search", the smart search is down: say so in one line, show the results and let the user pick.
5. Otherwise call get_context on the first result, say in one line why it fits, and list the others in one line each.
Present get_context as: what happened, what is still true, what is no longer true and why, and what may be out of date. Keep it short and plain.`;

export function createPlumbMcp(store: Store): McpServer {
  const server = new McpServer({ name: "plumb", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  // Shows in Claude Desktop's + menu as well.
  server.registerPrompt(
    "plumb",
    { description: "Bring in context from your other AI tools", argsSchema: { request: z.string().optional() } },
    ({ request }) => ({ messages: [{ role: "user", content: { type: "text", text: `/plumb ${request ?? ""}`.trim() } }] }),
  );

  for (const name of Object.keys(toolInputs) as ToolName[]) {
    server.registerTool(
      name,
      {
        description: toolDescriptions[name],
        inputSchema: toolInputs[name],
      },
      async (args: unknown) => {
        try {
          const result = await callTool(store, name, args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof ToolError) {
            return { content: [{ type: "text" as const, text: message }], isError: true };
          }
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }

  const listContexts = asListContexts();
  const readContext = asReadContext();
  if (listContexts && readContext) {
    // URI shape: cursor://auth-refactor-3f9a1c2d (scheme + title slug + source id prefix).
    // resources/list returns full names for "@plumb:" with no scheme.
    // complete.tool / complete.slug return bare strings for "@plumb:cursor://…".
    const template = new ResourceTemplate("{tool}://{slug}", {
      list: async () => {
        const contexts = await listedContexts(store);
        return {
          resources: contexts.map((c) => ({
            uri: c.uri,
            name: c.name,
            description: c.description,
            mimeType: "text/markdown",
          })),
        };
      },
      complete: {
        tool: async (value: string) => {
          const contexts = await listedContexts(store);
          const q = value.toLowerCase();
          // Schemes only ("cursor", "claude-code"), not display labels ("Claude Code").
          const schemes = [
            ...new Set(contexts.map((c) => uriScheme(c.uri)).filter(Boolean)),
          ];
          return schemes
            .filter((s) => !q || s.toLowerCase().includes(q))
            .slice(0, 20);
        },
        slug: async (value: string, context?: { arguments?: Record<string, string> }) => {
          const contexts = await listedContexts(store);
          const toolTyped = context?.arguments?.tool?.trim() ?? "";
          const toolPrefix = toolTyped ? `${toolTyped.toLowerCase()}://` : "";
          const q = value.toLowerCase();
          // Newest first (listContexts order). Filter by scheme already typed.
          return contexts
            .filter((c) => {
              if (!toolPrefix) return true;
              return c.uri.toLowerCase().startsWith(toolPrefix);
            })
            .map((c) => uriSlug(c.uri))
            .filter((s) => !q || s.toLowerCase().includes(q))
            .slice(0, 20);
        },
      },
    });

    server.registerResource(
      "plumb-context",
      template,
      {
        title: "Plumb session context",
        description:
          "A recent Claude Code, Cursor, Claude chat, doc or email session. Read returns what happened, what is still true, and what changed; never the raw transcript.",
        mimeType: "text/markdown",
      },
      async (uri) => {
        const result = await readContext(store, { uri: uri.href });
        // markdown from readContext already starts with the name heading.
        return {
          contents: [
            {
              uri: result.uri,
              mimeType: "text/markdown",
              text: result.markdown,
            },
          ],
        };
      },
    );
  }

  return server;
}
