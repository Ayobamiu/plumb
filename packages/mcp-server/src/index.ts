// Entrypoint for the remote MCP server (Cursor owns transport + deploy).
import { createHttpApp } from "./http.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

const app = createHttpApp({ host });

app.listen(port, host, (err?: Error) => {
  if (err) {
    console.error("failed to start", err);
    process.exit(1);
  }
  console.log(`plumb mcp listening on http://${host}:${port}`);
  console.log("  GET  /health");
  console.log("  POST /mcp          (Streamable HTTP, bearer)");
  console.log("  POST /tools/:name  (REST, bearer)");
  console.log("  POST /ingest       (extraction, bearer)");
});
