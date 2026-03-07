import { resolve } from "node:path";
import { validateEnv } from "./env.ts";
import { initDb } from "./db/client.ts";
import { logRequest } from "./middleware/logger.ts";

const env = validateEnv();

await initDb();
console.log("Database initialized");

const STATIC_ROOT = resolve(import.meta.dir, "../../dist/frontend");

Bun.serve({
  port: env.PORT,

  async fetch(req) {
    const start = Date.now();
    const url = new URL(req.url);

    try {
      // API routes — clone request before consuming body for logging
      if (url.pathname.startsWith("/api/")) {
        const reqClone = req.clone();
        const response = await handleApiRoute(req, url);
        logRequest(reqClone, response.status, Date.now() - start);
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
      logRequest(req, 500, Date.now() - start, message);
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    }
  },

  websocket: {
    open(ws) {},
    message(ws, message) {},
    close(ws) {},
  },
});

async function handleApiRoute(req: Request, url: URL): Promise<Response> {
  return Response.json({ error: "Not Found" }, { status: 404 });
}

console.log(`Server running on http://localhost:${env.PORT}`);
