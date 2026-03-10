import { SQL } from "bun";

let db: InstanceType<typeof SQL>;

export function initWorkerDb(): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  db = new SQL(url);
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
 * Update audit progress (pages analyzed count).
 */
export async function updateAuditProgress(auditId: string, pagesAnalyzed: number): Promise<void> {
  await db`
    UPDATE audits SET summary = jsonb_set(
      COALESCE(summary, '{}'::jsonb),
      '{pagesAnalyzed}',
      ${pagesAnalyzed}::text::jsonb
    )
    WHERE id = ${auditId}
  `;
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
    VALUES (${auditId}, ${eventType}, ${JSON.stringify(data)})
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
): Promise<void> {
  await db`
    UPDATE audits
    SET status = 'completed',
        finished_at = now(),
        summary = ${JSON.stringify(summary)},
        discovery = ${JSON.stringify(discovery)},
        llm_usage = ${JSON.stringify(llmUsage)},
        duration_seconds = ${durationSeconds}
    WHERE id = ${auditId}
  `;
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
      ${JSON.stringify(page.issuesByImpact)},
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
  await db.begin(async (tx) => {
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
          ${JSON.stringify(issue.wcagTags)}, ${issue.selector}, ${issue.html},
          ${issue.xpath}, ${issue.checkSource}, ${issue.category},
          ${issue.suggestedFix}, ${issue.fixConfidence}
        )
      `;
    }
  });
}

/**
 * Insert shared issues for an audit.
 */
export async function insertSharedIssues(
  auditId: string,
  sharedIssues: Array<{
    rule: string;
    impact: string;
    normalizedHtml: string;
    pageCount: number;
    pageUrls: string[];
    suggestedFix: string | null;
    category: string;
  }>,
): Promise<void> {
  if (sharedIssues.length === 0) return;

  await db.begin(async (tx) => {
    for (const si of sharedIssues) {
      await tx`
        INSERT INTO shared_issues (
          audit_id, rule, impact, normalized_html, page_count,
          page_urls, suggested_fix, category
        )
        VALUES (
          ${auditId}, ${si.rule}, ${si.impact}, ${si.normalizedHtml},
          ${si.pageCount}, ${JSON.stringify(si.pageUrls)},
          ${si.suggestedFix}, ${si.category}
        )
      `;
    }
  });
}
