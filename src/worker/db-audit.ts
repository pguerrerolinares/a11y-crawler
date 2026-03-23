import { getWorkerDb, json } from "./db";

export interface AuditJob {
  id: string;
  url: string;
  config: Record<string, unknown>;
}

/**
 * Claim the next queued audit atomically.
 * Uses FOR UPDATE SKIP LOCKED to support multiple workers.
 */
export async function claimNextAudit(): Promise<AuditJob | null> {
  const db = getWorkerDb();
  const rows = await db`
    UPDATE audits
    SET status = 'running', started_at = now()
    WHERE id = (
      SELECT id FROM audits
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, url, config
  `;

  if (rows.length === 0) return null;

  return {
    id: rows[0].id,
    url: rows[0].url,
    config: typeof rows[0].config === "string" ? JSON.parse(rows[0].config) : rows[0].config,
  };
}

/**
 * Emit an audit event for SSE consumers.
 */
export async function emitAuditEvent(
  auditId: string,
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  const db = getWorkerDb();
  await db`
    INSERT INTO audit_events (audit_id, event_type, data)
    VALUES (${auditId}, ${eventType}, ${json(data)})
  `;
}

/**
 * Mark audit as completed with summary data.
 */
export async function markAuditCompleted(
  auditId: string,
  summary: Record<string, unknown>,
  discovery: Record<string, unknown>,
  llmUsage: Record<string, unknown>,
  durationSeconds: number,
  wcagScore: number | null,
  crawlErrors: unknown[] | null,
  templateClusters: unknown[] | null,
): Promise<void> {
  const db = getWorkerDb();
  await db`
    UPDATE audits
    SET status = 'completed',
        finished_at = now(),
        summary = ${json(summary)},
        discovery = ${json(discovery)},
        llm_usage = ${json(llmUsage)},
        duration_seconds = ${durationSeconds},
        wcag_score = ${wcagScore},
        crawl_errors = ${crawlErrors ? json(crawlErrors) : null},
        template_clusters = ${templateClusters ? json(templateClusters) : null}
    WHERE id = ${auditId}
  `;
}

/**
 * Get distinct violated-rule counts by impact level for WCAG score computation.
 */
export async function getIssueCountsByImpact(
  auditId: string,
): Promise<{ critical: number; serious: number; moderate: number; minor: number }> {
  const db = getWorkerDb();
  const rows = await db`
    SELECT impact, COUNT(DISTINCT rule)::int as count
    FROM issues
    WHERE audit_id = ${auditId}
      AND check_source != 'scan-light'
    GROUP BY impact
  `;
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const row of rows) {
    if (row.impact in counts) {
      counts[row.impact as keyof typeof counts] = row.count;
    }
  }
  return counts;
}

/**
 * Mark audit as failed.
 */
export async function markAuditFailed(auditId: string, error: string): Promise<void> {
  const db = getWorkerDb();
  await db`
    UPDATE audits
    SET status = 'failed', finished_at = now(), error = ${error}
    WHERE id = ${auditId}
  `;
}

export async function markAuditCompletedBase(auditId: string, summary: unknown, discovery: unknown, llmUsage: unknown, durationSeconds: number, wcagScore: number, crawlErrors: unknown, templateClusters: unknown, regression: unknown): Promise<void> {
  const db = getWorkerDb();
  await db`
    UPDATE audits SET
      status = 'completed-base',
      summary = ${json(summary)},
      discovery = ${json(discovery)},
      llm_usage = ${json(llmUsage)},
      duration_seconds = ${durationSeconds},
      wcag_score = ${wcagScore},
      crawl_errors = ${json(crawlErrors)},
      template_clusters = ${json(templateClusters)},
      regression = ${json(regression)},
      finished_at = now()
    WHERE id = ${auditId}
  `;
}

export async function markAuditFullyCompleted(auditId: string): Promise<void> {
  const db = getWorkerDb();
  await db`UPDATE audits SET status = 'completed' WHERE id = ${auditId}`;
}
