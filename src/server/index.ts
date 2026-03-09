import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { validateEnv } from "./env.ts";
import { initDb } from "./db/client.ts";
import { logRequest } from "./middleware/logger.ts";
import { handleAudits } from "./routes/audits.ts";
import { handlePages } from "./routes/pages.ts";
import { handleIssues } from "./routes/issues.ts";
import { handleLogs } from "./routes/logs.ts";
import { handleExport } from "./routes/export.ts";
import { handleWsUpgrade, wsOpen, wsClose, wsMessage, startNotifyListener } from "./ws.ts";

const env = validateEnv();

await initDb();
console.log("Database initialized");

mkdirSync(env.REPORTS_DIR, { recursive: true });
console.log(`Reports directory: ${env.REPORTS_DIR}`);

await startNotifyListener();

const STATIC_ROOT = resolve(import.meta.dir, "../../dist/frontend");

Bun.serve({
  port: env.PORT,

  async fetch(req, server) {
    const start = Date.now();
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname.startsWith("/ws/")) {
      const upgraded = handleWsUpgrade(req, server);
      if (upgraded !== undefined) return upgraded;
      return undefined as any;
    }

    // Clone request before anything consumes the body
    const reqClone = req.clone();
    try {
      // API routes
      if (url.pathname.startsWith("/api/")) {
        const response = await handleApiRoute(req, url);
        const responseClone = response.clone();
        logRequest(reqClone, responseClone, Date.now() - start);
        return response;
      }

      // Static files (frontend) — prevent path traversal
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const resolved = resolve(STATIC_ROOT, `.${filePath}`);
      if (!resolved.startsWith(STATIC_ROOT)) {
        return new Response("Forbidden", { status: 403 });
      }

      const file = Bun.file(resolved);
      if (await file.exists()) {
        return new Response(file);
      }

      // SPA fallback
      const index = Bun.file(resolve(STATIC_ROOT, "index.html"));
      if (await index.exists()) {
        return new Response(index, { headers: { "content-type": "text/html" } });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errResponse = Response.json({ error: "Internal Server Error" }, { status: 500 });
      logRequest(reqClone, errResponse.clone(), Date.now() - start, message);
      return errResponse;
    }
  },

  websocket: {
    open: wsOpen,
    message: wsMessage,
    close: wsClose,
  },
});

async function handleApiRoute(req: Request, url: URL): Promise<Response> {
  // Order matters: more specific patterns first
  if (url.pathname.match(/^\/api\/audits\/[^/]+\/(pages|issues|shared)$/)) {
    if (url.pathname.endsWith("/pages")) return handlePages(req, url);
    return handleIssues(req, url);
  }
  // Export routes — before the /api/audits catch-all
  if (url.pathname.match(/^\/api\/audits\/[^/]+\/export\/(csv|pdf)$/)) {
    return handleExport(req, url);
  }
  if (url.pathname.startsWith("/api/pages/")) {
    if (url.pathname.match(/\/issues$/)) return handleIssues(req, url);
    return handlePages(req, url);
  }
  if (url.pathname.startsWith("/api/audits")) {
    return handleAudits(req, url);
  }
  if (url.pathname === "/api/logs" || url.pathname.match(/^\/api\/logs\/\d+$/)) {
    return handleLogs(req, url);
  }
  return Response.json({ error: "Not Found" }, { status: 404 });
}

console.log(`Server running on http://localhost:${env.PORT}`);
