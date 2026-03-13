import postgres, { type JSONValue } from "postgres";
import type { SpanRecord, PageCapabilities } from "../types/pipeline";

let db: ReturnType<typeof postgres>;

const json = (value: unknown) => db.json(value as JSONValue);

export function initWorkerDb(): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  db = postgres(url);
}

export function getWorkerDb() {
  if (!db) throw new Error("Worker DB not initialized. Call initWorkerDb() first.");
  return db;
}

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
 * Uses COUNT(DISTINCT rule) so that a single rule with many node violations
 * (e.g. 30 color-contrast nodes) counts as 1, not 30 — matching how
 * Lighthouse and similar tools score accessibility.
 * Excludes scan-light issues (overlap with axe-full on representative pages).
 */
export async function getIssueCountsByImpact(
  auditId: string,
): Promise<{ critical: number; serious: number; moderate: number; minor: number }> {
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
  await db`
    UPDATE audits
    SET status = 'failed', finished_at = now(), error = ${error}
    WHERE id = ${auditId}
  `;
}

/**
 * Insert a page result.
 */
export async function insertPage(
  auditId: string,
  page: {
    url: string;
    title: string;
    issueCount: number;
    issuesByImpact: Record<string, number>;
    durationMs: number;
  },
): Promise<string> {
  const rows = await db`
    INSERT INTO pages (audit_id, url, title, issue_count, issues_by_impact, duration_ms)
    VALUES (
      ${auditId},
      ${page.url},
      ${page.title},
      ${page.issueCount},
      ${json(page.issuesByImpact)},
      ${page.durationMs}
    )
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * Insert issues for a page.
 */
export async function insertIssues(
  auditId: string,
  pageId: string,
  issues: Array<{
    rule: string;
    impact: string;
    description: string;
    help: string;
    helpUrl: string;
    wcagTags: string[];
    selector: string;
    html: string;
    xpath: string;
    checkSource: string;
    category: string;
    suggestedFix: string | null;
    fixConfidence: string | null;
  }>,
): Promise<void> {
  if (issues.length === 0) return;

  // Batch insert in a single transaction
  await db.begin(async (tx: ReturnType<typeof postgres>) => {
    for (const issue of issues) {
      await tx`
        INSERT INTO issues (
          audit_id, page_id, rule, impact, description, help, help_url,
          wcag_tags, selector, html, xpath, check_source, category,
          suggested_fix, fix_confidence
        )
        VALUES (
          ${auditId}, ${pageId}, ${issue.rule}, ${issue.impact},
          ${issue.description}, ${issue.help}, ${issue.helpUrl},
          ${json(issue.wcagTags)}, ${issue.selector}, ${issue.html},
          ${issue.xpath}, ${issue.checkSource}, ${issue.category},
          ${issue.suggestedFix}, ${issue.fixConfidence}
        )
      `;
    }
  });
}


/**
 * Persist observability spans for an audit.
 */
export async function persistSpans(spans: SpanRecord[]): Promise<void> {
  if (spans.length === 0) return;
  for (const s of spans) {
    await db`
      INSERT INTO audit_spans
        (audit_id, trace_id, span_id, parent_span_id, name,
         started_at, ended_at, status, error_message, metadata)
      VALUES
        (${s.auditId}, ${s.traceId}, ${s.spanId}, ${s.parentSpanId}, ${s.name},
         ${s.startedAt}, ${s.endedAt}, ${s.status}, ${s.errorMessage}, ${json(s.metadata)})
    `;
  }
}

/**
 * Insert a page result for the v4 pipeline (with template/fingerprint/capabilities support).
 */
export async function insertPageV4(
  auditId: string,
  page: {
    url: string;
    title?: string;
    templateId?: string;
    isRepresentative?: boolean;
    fingerprint?: string;
    elementCount?: number;
    capabilities?: PageCapabilities;
    issueCount?: number;
    issuesByImpact?: Record<string, number>;
    durationMs?: number;
  },
): Promise<string> {
  const [row] = await db`
    INSERT INTO pages (audit_id, url, title, template_id, is_representative,
                       fingerprint, element_count, capabilities,
                       issue_count, issues_by_impact, duration_ms)
    VALUES (${auditId}, ${page.url}, ${page.title ?? ""},
            ${page.templateId ?? null}, ${page.isRepresentative ?? false},
            ${page.fingerprint ?? null}, ${page.elementCount ?? null},
            ${page.capabilities ? json(page.capabilities) : null},
            ${page.issueCount ?? 0}, ${json(page.issuesByImpact ?? {})},
            ${page.durationMs ?? 0})
    ON CONFLICT (audit_id, url) DO UPDATE SET
      title = COALESCE(NULLIF(EXCLUDED.title, ''), pages.title),
      template_id = COALESCE(EXCLUDED.template_id, pages.template_id),
      is_representative = EXCLUDED.is_representative OR pages.is_representative,
      issue_count = EXCLUDED.issue_count,
      issues_by_impact = EXCLUDED.issues_by_impact
    RETURNING id
  `;
  return row.id;
}

/**
 * Insert issues for the v4 pipeline (with template amplification support).
 */
export async function insertIssuesV4(
  auditId: string,
  pageId: string,
  issues: Array<{
    rule: string;
    impact: string;
    description?: string;
    help?: string;
    helpUrl?: string;
    wcagTags?: string[];
    selector?: string;
    html?: string;
    xpath?: string;
    checkSource: string;
    category?: string;
    suggestedFix?: string;
    fixConfidence?: number | null;
    templateId?: string | null;
    affectedPages?: number;
    amplifiedFrom?: string | null;
  }>,
): Promise<void> {
  if (issues.length === 0) return;
  for (const i of issues) {
    await db`
      INSERT INTO issues
        (audit_id, page_id, rule, impact, description, help, help_url,
         wcag_tags, selector, html, xpath, check_source, category,
         suggested_fix, fix_confidence, template_id, affected_pages, amplified_from)
      VALUES
        (${auditId}, ${pageId}, ${i.rule}, ${i.impact},
         ${i.description ?? ""}, ${i.help ?? ""}, ${i.helpUrl ?? ""},
         ${json(i.wcagTags ?? [])}, ${i.selector ?? ""}, ${i.html ?? ""},
         ${i.xpath ?? ""}, ${i.checkSource}, ${i.category ?? "structural"},
         ${i.suggestedFix ?? ""}, ${i.fixConfidence ?? null},
         ${i.templateId ?? null}, ${i.affectedPages ?? 1}, ${i.amplifiedFrom ?? null})
    `;
  }
}

/**
 * Count actual pages persisted for an audit.
 */
export async function getPageCount(auditId: string): Promise<number> {
  const [row] = await db`SELECT COUNT(*)::int as count FROM pages WHERE audit_id = ${auditId}`;
  return row.count;
}

/**
 * Get the most recent completed audit for the same domain (excluding current).
 */
export async function getPreviousAudit(
  auditId: string,
  domain: string,
): Promise<{ id: string; templateClusters: unknown[]; wcagScore: number | null; finishedAt: string } | null> {
  const rows = await db`
    SELECT id, template_clusters, wcag_score, finished_at
    FROM audits
    WHERE url LIKE ${"%" + domain + "%"}
      AND status = 'completed'
      AND id != ${auditId}
      AND template_clusters IS NOT NULL
    ORDER BY finished_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return {
    id: rows[0].id,
    templateClusters: rows[0].template_clusters,
    wcagScore: rows[0].wcag_score,
    finishedAt: rows[0].finished_at,
  };
}

/**
 * Get all issues grouped by template_id for an audit.
 */
export async function getIssuesByTemplateId(
  auditId: string,
): Promise<Map<string, Array<{ rule: string; impact: string }>>> {
  const rows = await db`
    SELECT template_id, rule, impact
    FROM issues
    WHERE audit_id = ${auditId} AND template_id IS NOT NULL
  `;
  const map = new Map<string, Array<{ rule: string; impact: string }>>();
  for (const row of rows) {
    const key = row.template_id as string;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push({ rule: row.rule, impact: row.impact });
  }
  return map;
}

/**
 * Persist regression diff to an audit.
 */
export async function updateAuditRegression(
  auditId: string,
  regression: unknown,
): Promise<void> {
  await db`
    UPDATE audits SET regression = ${json(regression)} WHERE id = ${auditId}
  `;
}
