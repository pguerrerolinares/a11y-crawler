import { getDb } from "../db/client.ts";

export async function logRequest(req: Request, status: number, durationMs: number, error?: string) {
  const db = getDb();
  const url = new URL(req.url);

  if (!url.pathname.startsWith("/api/")) return;

  let requestBody = null;
  if (req.method === "POST" || req.method === "PUT") {
    try {
      requestBody = await req.clone().json();
    } catch {}
  }

  await db`INSERT INTO request_logs (method, path, status_code, duration_ms, ip, user_agent, request_body, error)
    VALUES (
      ${req.method},
      ${url.pathname},
      ${status},
      ${durationMs},
      ${req.headers.get("x-forwarded-for") || "unknown"},
      ${req.headers.get("user-agent") || ""},
      ${requestBody ? JSON.stringify(requestBody) : null},
      ${error || null}
    )`.catch(console.error);
}
