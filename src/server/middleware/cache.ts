/**
 * In-memory response cache for completed audit data.
 *
 * Completed audits are immutable — their issues, pages, and metadata never change.
 * Uses lru-cache for LRU eviction, TTL, and size management.
 */
import { LRUCache } from "lru-cache";

interface CacheEntry {
  body: string;
  headers: Record<string, string>;
  status: number;
}

const LIST_TTL = 30_000; // 30s for audit list (can change with new audits)
const DATA_TTL = 5 * 60_000; // 5 min for completed audit data (effectively indefinite within a session)

const cache = new LRUCache<string, CacheEntry>({
  max: 500,
  ttl: DATA_TTL,
  allowStale: false,
});

export function getCached(key: string): Response | null {
  const entry = cache.get(key);
  if (!entry) return null;

  return new Response(entry.body, {
    status: entry.status,
    headers: { ...entry.headers, "X-Cache": "HIT" },
  });
}

export async function setCached(key: string, response: Response, ttl?: number): Promise<Response> {
  const body = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => { headers[k] = v; });

  cache.set(key, { body, headers, status: response.status }, { ttl });

  return new Response(body, {
    status: response.status,
    headers: { ...headers, "X-Cache": "MISS" },
  });
}

/** Invalidate entire cache (on create/delete audit). */
export function invalidateAll(): void {
  cache.clear();
}

/**
 * Determine the appropriate TTL for a request path.
 * Returns TTL in ms, or null if the path should not be cached.
 */
export function getTtlForPath(path: string): number | null {
  // Audit list — short TTL (new audits can appear)
  if (path === "/api/audits" || path === "/api/audits/") return LIST_TTL;

  // Audit detail, issues, pages, shared, screenshots
  if (path.match(/^\/api\/audits\/[^/]+/)) return DATA_TTL;

  // Don't cache other endpoints (logs, SSE, exports)
  return null;
}
