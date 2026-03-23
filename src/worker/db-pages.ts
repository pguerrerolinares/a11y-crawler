import { getWorkerDb, json } from "./db";
import type { SpanRecord, PageCapabilities } from "../types/pipeline";
import { getReportCategory } from "../reporter/wcag-metadata";
import { extractWcagCriterion } from "../server/utils/wcag.ts";

/**
 * Persist observability spans for an audit.
 */
export async function persistSpans(spans: SpanRecord[]): Promise<void> {
  if (spans.length === 0) return;
  const db = getWorkerDb();
  for (const s of spans) {
    try {
      await db`
        INSERT INTO audit_spans
          (audit_id, trace_id, span_id, parent_span_id, name,
           started_at, ended_at, status, error_message, metadata)
        VALUES
          (${s.auditId}, ${s.traceId}, ${s.spanId}, ${s.parentSpanId}, ${s.name},
           ${s.startedAt}, ${s.endedAt}, ${s.status}, ${s.errorMessage}, ${json(s.metadata)})
      `;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as { code: string }).code === "23503") {
        console.warn(`persistSpans: audit ${s.auditId} no longer exists, skipping spans`);
        return;
      }
      throw err;
    }
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
  const db = getWorkerDb();
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
    wcagCriterion?: string | null;
  }>,
): Promise<void> {
  if (issues.length === 0) return;
  const db = getWorkerDb();
  // PostgreSQL rejects null bytes (\0) in TEXT columns — strip them
  const sanitize = (s: string | undefined | null) => (s ?? "").replace(/\0/g, "");

  for (const i of issues) {
    const reportCategory = getReportCategory(i.rule);
    const wcagCriterion = i.wcagCriterion
      ?? extractWcagCriterion(i.wcagTags, i.rule)
      ?? "";
    await db`
      INSERT INTO issues
        (audit_id, page_id, rule, impact, description, help, help_url,
         wcag_tags, selector, html, xpath, check_source, category,
         suggested_fix, fix_confidence, template_id, affected_pages, amplified_from,
         report_category, wcag_criterion)
      VALUES
        (${auditId}, ${pageId}, ${i.rule}, ${i.impact},
         ${sanitize(i.description)}, ${sanitize(i.help)}, ${sanitize(i.helpUrl)},
         ${json(i.wcagTags ?? [])}, ${sanitize(i.selector)}, ${sanitize(i.html)},
         ${sanitize(i.xpath)}, ${i.checkSource}, ${i.category ?? "structural"},
         ${sanitize(i.suggestedFix)}, ${i.fixConfidence ?? null},
         ${i.templateId ?? null}, ${i.affectedPages ?? 1}, ${i.amplifiedFrom ?? null},
         ${reportCategory}, ${wcagCriterion})
    `;
  }
}

/**
 * Count actual pages persisted for an audit.
 */
export async function getPageCount(auditId: string): Promise<number> {
  const db = getWorkerDb();
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
  const db = getWorkerDb();
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
  const db = getWorkerDb();
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
  const db = getWorkerDb();
  await db`
    UPDATE audits SET regression = ${json(regression)} WHERE id = ${auditId}
  `;
}
