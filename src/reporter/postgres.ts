import type { SiteReport } from "../types/report.ts";

export async function writeReportToPostgres(
  db: any,
  auditId: string,
  report: SiteReport,
): Promise<void> {
  await db.begin(async (tx: any) => {
    await writeReport(tx, auditId, report);
  });
}

async function writeReport(db: any, auditId: string, report: SiteReport): Promise<void> {
  for (const page of report.pages) {
    const issuesByImpact: Record<string, number> = {};
    for (const issue of page.issues) {
      issuesByImpact[issue.impact] = (issuesByImpact[issue.impact] || 0) + 1;
    }

    const [insertedPage] = await db`
      INSERT INTO pages (audit_id, url, title, issue_count, issues_by_impact, duration_ms)
      VALUES (${auditId}, ${page.url}, ${page.title}, ${page.issues.length}, ${issuesByImpact}, ${page.processingMs})
      RETURNING id
    `;

    for (const issue of page.issues) {
      await db`
        INSERT INTO issues (page_id, audit_id, rule, impact, description, help, help_url, wcag_tags, selector, html, xpath, check_source, category, suggested_fix, fix_confidence)
        VALUES (
          ${insertedPage.id}, ${auditId}, ${issue.rule}, ${issue.impact},
          ${issue.description}, ${issue.help}, ${issue.helpUrl},
          ${issue.wcagTags}, ${issue.selector}, ${issue.html},
          ${issue.xpath}, ${issue.checkSource}, ${issue.violationCategory},
          ${issue.suggestedFix}, ${issue.fixConfidence}
        )
      `;
    }
  }

  for (const shared of report.sharedIssues) {
    await db`
      INSERT INTO shared_issues (audit_id, rule, impact, normalized_html, page_count, page_urls, suggested_fix)
      VALUES (
        ${auditId}, ${shared.rule}, ${"serious"}, /* SharedIssue type lacks impact field */
        ${shared.html}, ${shared.pageCount}, ${shared.affectedPages},
        ${shared.suggestedFix}
      )
    `;
  }

  await db`
    UPDATE audits SET
      status = 'completed',
      finished_at = NOW(),
      summary = ${report.summary},
      discovery = ${report.discovery},
      llm_usage = ${report.llmUsage}
    WHERE id = ${auditId}
  `;
}
