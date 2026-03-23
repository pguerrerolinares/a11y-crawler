import { getWorkerDb, json } from "./db";

export async function insertTier3Job(
  auditId: string, templateId: string,
  elements: unknown[], priority: number,
): Promise<string> {
  const db = getWorkerDb();
  const [row] = await db`
    INSERT INTO tier3_jobs (audit_id, template_id, elements, priority)
    VALUES (${auditId}, ${templateId}, ${json(elements)}, ${priority})
    RETURNING id
  `;
  return row.id;
}

export async function claimNextTier3Job(auditId: string): Promise<Record<string, unknown> | null> {
  const db = getWorkerDb();
  const [job] = await db`
    UPDATE tier3_jobs SET status = 'running', started_at = now()
    WHERE id = (
      SELECT id FROM tier3_jobs
      WHERE audit_id = ${auditId} AND status = 'pending'
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  return job ?? null;
}

export async function completeTier3Job(jobId: string, result: unknown): Promise<void> {
  const db = getWorkerDb();
  await db`
    UPDATE tier3_jobs SET status = 'completed', result = ${json(result)}, completed_at = now()
    WHERE id = ${jobId}
  `;
}

export async function failTier3Job(jobId: string, error: string): Promise<void> {
  const db = getWorkerDb();
  await db`
    UPDATE tier3_jobs SET status = 'failed', error = ${error}, completed_at = now()
    WHERE id = ${jobId}
  `;
}

export async function allTier3JobsDone(auditId: string): Promise<boolean> {
  const db = getWorkerDb();
  const [{ count }] = await db`
    SELECT COUNT(*)::int as count FROM tier3_jobs
    WHERE audit_id = ${auditId} AND status IN ('pending', 'running')
  `;
  return count === 0;
}

export async function tier3CacheLookup(key: string): Promise<unknown | null> {
  const db = getWorkerDb();
  const [row] = await db`
    SELECT result, cache_type, created_at FROM tier3_cache WHERE cache_key = ${key}
  `;
  if (!row) return null;
  // TTL: 24h for vision, 7d for text
  const ttlMs = row.cache_type === "vision" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - new Date(row.created_at).getTime() > ttlMs) return null;
  return row.result;
}

export async function tier3CacheSet(
  key: string, result: unknown, cacheType: "text" | "vision", auditId: string,
): Promise<void> {
  const db = getWorkerDb();
  await db`
    INSERT INTO tier3_cache (cache_key, result, cache_type, audit_id)
    VALUES (${key}, ${json(result)}, ${cacheType}, ${auditId})
    ON CONFLICT (cache_key) DO UPDATE SET result = ${json(result)}, created_at = now()
  `;
}
