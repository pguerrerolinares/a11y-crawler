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
import { handleSSE } from "./routes/sse.ts";
import { handleScreenshots } from "./routes/screenshots.ts";
import { handlePerformance } from "./routes/performance.ts";
import { getCached, setCached, getTtlForPath } from "./middleware/cache.ts";

const env = validateEnv();

// Retry DB init with backoff — Coolify may take a moment to attach the network
for (let attempt = 1; attempt <= 10; attempt++) {
  try {
    await initDb();
    console.log("Database initialized");
    break;
  } catch (err) {
    console.warn(`DB init attempt ${attempt}/10 failed:`, err instanceof Error ? err.message : err);
    if (attempt === 10) throw err;
    await new Promise(r => setTimeout(r, attempt * 2000));
  }
}

mkdirSync(env.REPORTS_DIR, { recursive: true });
console.log(`Reports directory: ${env.REPORTS_DIR}`);

const STATIC_ROOT = resolve(import.meta.dir, "../../dist/frontend");

Bun.serve({
  port: env.PORT,
  idleTimeout: 255, // max — SSE connections are long-lived

  async fetch(req, server) {
    const start = Date.now();
    const url = new URL(req.url);

    // Health check — fast, no logging
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return new Response("OK", { status: 200 });
    }

    // Clone request before anything consumes the body
    const reqClone = req.clone();
    try {
      // API routes
      if (url.pathname.startsWith("/api/")) {
        // Cache layer: only GET requests, only cacheable paths
        if (req.method === "GET") {
          const cacheKey = url.pathname + url.search;
          const ttl = getTtlForPath(url.pathname);

          if (ttl !== null) {
            const cached = getCached(cacheKey);
            if (cached) {
              logRequest(reqClone, cached.clone(), Date.now() - start);
              return cached;
            }

            const response = await handleApiRoute(req, url);
            // Only cache successful JSON responses for completed audits
            // (running/pending audits change state and must not be cached)
            // Skip cache for binary responses (PDF, CSV) — text() corrupts binary data
            const isJson = response.headers.get("content-type")?.includes("application/json");
            if (response.status === 200 && isJson) {
              const body = await response.text();
              let shouldCache = true;
              let effectiveTtl = ttl;
              if (isJson) {
                try {
                  const json = JSON.parse(body);
                  if (json.status && json.status !== "completed" && json.status !== "completed-base") {
                    shouldCache = false;
                  }
                  if (json.status === "completed-base") effectiveTtl = 30_000;
                } catch { /* not JSON or no status field */ }
              }
              const rebuilt = new Response(body, { status: response.status, headers: response.headers });
              if (shouldCache) {
                const cachedResponse = await setCached(cacheKey, rebuilt, effectiveTtl);
                logRequest(reqClone, cachedResponse.clone(), Date.now() - start);
                return cachedResponse;
              }
              logRequest(reqClone, rebuilt.clone(), Date.now() - start);
              return rebuilt;
            }
            logRequest(reqClone, response.clone(), Date.now() - start);
            return response;
          }
        }

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

});

async function handleApiRoute(req: Request, url: URL): Promise<Response> {
  // SSE endpoint for audit progress
  if (url.pathname.match(/^\/api\/audits\/[^/]+\/events$/)) {
    const sseResponse = handleSSE(req, url);
    if (sseResponse) return sseResponse;
  }
  // Order matters: more specific patterns first
  if (url.pathname.match(/^\/api\/audits\/[^/]+\/(pages|issues|shared)$/)) {
    if (url.pathname.endsWith("/pages")) return handlePages(req, url);
    return handleIssues(req, url);
  }
  // Export routes — after pages/issues/shared, before /api/audits catch-all
  if (url.pathname.match(/^\/api\/audits\/[^/]+\/export\/(csv|pdf)$/)) {
    return handleExport(req, url);
  }
  // Screenshot routes
  if (url.pathname.match(/^\/api\/audits\/[^/]+\/screenshots/)) {
    return handleScreenshots(req, url);
  }
  if (url.pathname.startsWith("/api/pages/")) {
    if (url.pathname.match(/\/issues$/)) return handleIssues(req, url);
    return handlePages(req, url);
  }
  if (url.pathname.match(/^\/api\/audits\/[^/]+\/performance$/)) {
    return handlePerformance(req, url);
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
