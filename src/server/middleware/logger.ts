import { getDb } from "../db/client.ts";

const MAX_RESPONSE_BODY = 2048;

const SENSITIVE_KEYS = /^(password|token|secret|authorization|cookie|api.?key)$/i;

function sanitize(obj: unknown): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = SENSITIVE_KEYS.test(k) ? "[REDACTED]" : v;
  }
  return result;
}

export async function logRequest(req: Request, response: Response, durationMs: number, error?: string) {
  const db = getDb();
  const url = new URL(req.url);

  if (!url.pathname.startsWith("/api/")) return;

  // Parse request body for POST/PUT
  let requestBody = null;
  if (req.method === "POST" || req.method === "PUT") {
    try {
      requestBody = sanitize(await req.clone().json());
    } catch (e) {
      console.warn("[logger] parse failed:", (e as Error).message);
    }
  }

  // Parse query params
  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });
  const hasQueryParams = Object.keys(queryParams).length > 0;

  // Capture response body (truncated) and metadata
  const contentType = response.headers.get("content-type") || null;
  let responseBody: string | null = null;
  let responseSize: number | null = null;
  try {
    const cloned = response.clone();
    const text = await cloned.text();
    responseSize = new TextEncoder().encode(text).byteLength;
    responseBody = text.length > MAX_RESPONSE_BODY ? text.slice(0, MAX_RESPONSE_BODY) : text;
  } catch (e) {
    console.warn("[logger] parse failed:", (e as Error).message);
  }

  await db`INSERT INTO request_logs (method, path, status_code, duration_ms, ip, user_agent, request_body, response_size, error, response_body, content_type, query_params)
    VALUES (
      ${req.method},
      ${url.pathname},
      ${response.status},
      ${durationMs},
      ${req.headers.get("x-forwarded-for") || "unknown"},
      ${req.headers.get("user-agent") || ""},
      ${requestBody},
      ${responseSize},
      ${error || null},
      ${responseBody},
      ${contentType},
      ${hasQueryParams ? queryParams : null}
    )`.catch(console.error);
}
