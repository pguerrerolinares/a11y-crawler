/**
 * In-memory response cache for completed audit data.
 *
 * Completed audits are immutable — their issues, pages, and metadata never change.
 * Cache keyed by full URL (path + query params). Entries evicted by:
 * - TTL (default 5 min for audit list, indefinite for completed audit data)
 * - Manual invalidation when audit status changes
 * - Max entries limit (LRU eviction)
 */

interface CacheEntry {
  body: string;
  headers: Record<string, string>;
  status: number;
  timestamp: number;
  ttl: number; // ms, 0 = indefinite (until eviction)
}

const MAX_ENTRIES = 500;
const DEFAULT_TTL = 0; // indefinite for completed audit data
const LIST_TTL = 30_000; // 30s for audit list (can change with new audits)

const cache = new Map<string, CacheEntry>();
const accessOrder: string[] = []; // LRU tracking

function evictOldest(): void {
  while (cache.size >= MAX_ENTRIES && accessOrder.length > 0) {
    const oldest = accessOrder.shift()!;
    cache.delete(oldest);
  }
}

function touch(key: string): void {
  const idx = accessOrder.indexOf(key);
  if (idx !== -1) accessOrder.splice(idx, 1);
  accessOrder.push(key);
}

export function getCached(key: string): Response | null {
  const entry = cache.get(key);
  if (!entry) return null;

  // Check TTL
  if (entry.ttl > 0 && Date.now() - entry.timestamp > entry.ttl) {
    cache.delete(key);
    return null;
  }

  touch(key);
  return new Response(entry.body, {
    status: entry.status,
    headers: { ...entry.headers, "X-Cache": "HIT" },
  });
}

export async function setCached(key: string, response: Response, ttl = DEFAULT_TTL): Promise<Response> {
  const body = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => { headers[k] = v; });

  evictOldest();
  cache.set(key, { body, headers, status: response.status, timestamp: Date.now(), ttl });
  touch(key);

  // Return a new Response since the original was consumed
  return new Response(body, {
    status: response.status,
    headers: { ...headers, "X-Cache": "MISS" },
  });
}

/**
 * Invalidate all cache entries for a given audit ID.
 * Call this when an audit's status changes (e.g., running → completed).
 */
export function invalidateAudit(auditId: string): void {
  const keysToDelete: string[] = [];
  for (const key of cache.keys()) {
    if (key.includes(auditId)) keysToDelete.push(key);
  }
  for (const key of keysToDelete) {
    cache.delete(key);
    const idx = accessOrder.indexOf(key);
    if (idx !== -1) accessOrder.splice(idx, 1);
  }
  // Also invalidate the audit list
  for (const key of cache.keys()) {
    if (key.startsWith("/api/audits") && !key.includes("/")) {
      cache.delete(key);
    }
  }
}

/** Invalidate entire cache. */
export function invalidateAll(): void {
  cache.clear();
  accessOrder.length = 0;
}

/** Cache stats for debugging. */
export function cacheStats(): { entries: number; maxEntries: number } {
  return { entries: cache.size, maxEntries: MAX_ENTRIES };
}

/**
 * Determine the appropriate TTL for a request path.
 * Completed audit data = indefinite. Audit list = 30s. Everything else = no cache.
 */
export function getTtlForPath(path: string): number | null {
  // Audit list — short TTL (new audits can appear)
  if (path === "/api/audits" || path === "/api/audits/") return LIST_TTL;

  // Audit detail, issues, pages, shared, screenshots — cache indefinitely for completed audits
  if (path.match(/^\/api\/audits\/[^/]+/)) return DEFAULT_TTL;

  // Don't cache other endpoints (logs, SSE, exports)
  return null;
}
