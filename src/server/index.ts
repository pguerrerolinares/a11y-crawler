import { validateEnv } from "./env.ts";
import { initDb } from "./db/client.ts";
import { logRequest } from "./middleware/logger.ts";

const env = validateEnv();

await initDb();
console.log("Database initialized");

Bun.serve({
  port: env.PORT,

  async fetch(req) {
    const start = Date.now();
    const url = new URL(req.url);

    try {
      // API routes
      if (url.pathname.startsWith("/api/")) {
        const response = await handleApiRoute(req, url);
        logRequest(req, response.status, Date.now() - start);
        return response;
      }

      // Static files (frontend)
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(`${import.meta.dir}/../../dist/frontend${filePath}`);
      if (await file.exists()) {
        return new Response(file);
      }

      // SPA fallback
      const index = Bun.file(`${import.meta.dir}/../../dist/frontend/index.html`);
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
