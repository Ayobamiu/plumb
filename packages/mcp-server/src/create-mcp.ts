// Builds an McpServer that exposes the six Contract tools via callTool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  callTool,
  ToolError,
  toolDescriptions,
  toolInputs,
  type Store,
  type ToolName,
} from "./tools/index.js";

export function createPlumbMcp(store: Store): McpServer {
  const server = new McpServer({ name: "plumb", version: "0.1.0" });

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

  return server;
}
