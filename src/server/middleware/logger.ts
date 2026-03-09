import { getDb } from "../db/client.ts";

const MAX_RESPONSE_BODY = 2048;
const MAX_ARRAY_ITEMS = 5;
const MAX_STRING_LEN = 200;

const SENSITIVE_KEYS = /^(password|token|secret|authorization|cookie|api.?key)$/i;

function sanitize(obj: unknown): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = SENSITIVE_KEYS.test(k) ? "[REDACTED]" : v;
  }
  return result;
}

/**
 * Truncate a parsed JSON value to fit within MAX_RESPONSE_BODY when serialized.
 * Arrays are capped to MAX_ARRAY_ITEMS with a "[N more items]" marker.
 * Long strings are shortened with a "…[truncated]" suffix.
 * Always produces valid JSON.
 */
function truncateJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING_LEN
      ? value.slice(0, MAX_STRING_LEN) + "…[truncated]"
      : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const truncated = value.slice(0, MAX_ARRAY_ITEMS).map(truncateJson);
    if (value.length > MAX_ARRAY_ITEMS) {
      truncated.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return truncated;
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = truncateJson(v);
  }
  return result;
}

function smartTruncateBody(text: string, contentType: string | null): string {
  if (text.length <= MAX_RESPONSE_BODY) return text;
  // Only attempt smart truncation for JSON
  if (contentType && contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(text);
      const truncated = truncateJson(parsed);
      return JSON.stringify(truncated);
    } catch {
      // Fallback: raw slice (shouldn't happen for valid JSON responses)
    }
  }
  return text.slice(0, MAX_RESPONSE_BODY);
}

function isNoisyPath(pathname: string): boolean {
  return pathname.startsWith("/api/logs") || pathname === "/health";
}

export async function logRequest(req: Request, response: Response, durationMs: number, error?: string) {
  const db = getDb();
  const url = new URL(req.url);

  if (!url.pathname.startsWith("/api/")) return;
  if (isNoisyPath(url.pathname)) return;

  // Parse request body for POST/PUT/PATCH
  let requestBody = null;
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
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
    responseBody = smartTruncateBody(text, contentType);
  } catch (e) {
    console.warn("[logger] parse failed:", (e as Error).message);
  }

  db`INSERT INTO request_logs (method, path, status_code, duration_ms, ip, user_agent, request_body, response_size, error, response_body, content_type, query_params)
    VALUES (
      ${req.method},
      ${url.pathname},
      ${response.status},
      ${durationMs},
      ${req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown"},
      ${req.headers.get("user-agent") || ""},
      ${requestBody},
      ${responseSize},
      ${error || null},
      ${responseBody},
      ${contentType},
      ${hasQueryParams ? queryParams : null}
    )
    RETURNING id, created_at`
    .catch(console.error);
}
