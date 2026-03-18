import { getDb } from "../db/client.ts";
import { IssueFilterSchema } from "../types.ts";
import type { IssueResponse } from "../types.ts";
import { extractWcagCriterion } from "../utils.ts";

export async function handleIssues(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return Response.json({ error: "Method Not Allowed" }, { status: 405 });

  // /api/audits/:id/issues
  const auditMatch = url.pathname.match(/^\/api\/audits\/([^/]+)\/issues$/);
  if (auditMatch) return listIssues("audit_id", auditMatch[1], url);

  // /api/pages/:id/issues
  const pageMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/issues$/);
  if (pageMatch) return listIssues("page_id", pageMatch[1], url);

  // /api/audits/:id/shared
  const sharedMatch = url.pathname.match(/^\/api\/audits\/([^/]+)\/shared$/);
  if (sharedMatch) return listSharedIssues(sharedMatch[1]);

  return Response.json({ error: "Not Found" }, { status: 404 });
}

async function listIssues(filterCol: "audit_id" | "page_id", filterVal: string, url: URL): Promise<Response> {
  const db = getDb();
  const params = Object.fromEntries(url.searchParams);
  const { limit, offset, impact, rule, category, source } = IssueFilterSchema.parse(params);

  const conditions = [`${filterCol} = $1`];
  const values: (string | number)[] = [filterVal];
  let paramIdx = 2;

  if (impact) {
    const impacts = impact.split(",");
    const placeholders = impacts.map((_, i) => `$${paramIdx + i}`).join(", ");
    conditions.push(`impact IN (${placeholders})`);
    values.push(...impacts);
    paramIdx += impacts.length;
  }
  if (rule) {
    conditions.push(`rule = $${paramIdx}`);
    values.push(rule);
    paramIdx++;
  }
  if (category) {
    conditions.push(`category = $${paramIdx}`);
    values.push(category);
    paramIdx++;
  }
  if (source) {
    conditions.push(`check_source = $${paramIdx}`);
    values.push(source);
    paramIdx++;
  }

  const where = conditions.join(" AND ");
  const issues = await db.unsafe(
    `SELECT * FROM issues WHERE ${where} ORDER BY created_at ASC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, limit, offset]
  );
  const [{ count: total }] = await db.unsafe(
    `SELECT COUNT(*)::int as count FROM issues WHERE ${where}`,
    values
  );

  return Response.json({ data: issues.map(mapIssueRow), total, limit, offset });
}

async function listSharedIssues(auditId: string): Promise<Response> {
  const db = getDb();

  const issues = await db`
    SELECT i.rule, i.impact, i.template_id,
           COUNT(DISTINCT i.page_id)::int as page_count,
           array_agg(DISTINCT p.url) as page_urls,
           MAX(i.description) as description,
           MAX(i.help) as help,
           MAX(i.help_url) as help_url,
           MAX(i.suggested_fix) as suggested_fix,
           MAX(i.category) as category
    FROM issues i
    JOIN pages p ON p.id = i.page_id
    WHERE i.audit_id = ${auditId}
      AND i.template_id IS NOT NULL
    GROUP BY i.rule, i.impact, i.template_id
    HAVING COUNT(DISTINCT i.page_id) > 1
    ORDER BY page_count DESC
  `;

  return Response.json({
    data: issues.map((row: Record<string, unknown>) => ({
      rule: row.rule,
      impact: row.impact,
      templateId: row.template_id,
      description: row.description,
      help: row.help,
      helpUrl: row.help_url,
      pageCount: row.page_count,
      pageUrls: row.page_urls,
      suggestedFix: row.suggested_fix,
      category: row.category,
    })),
  });
}

function mapIssueRow(row: Record<string, unknown>): IssueResponse {
  return {
    id: row.id,
    pageId: row.page_id,
    auditId: row.audit_id,
    rule: row.rule,
    impact: row.impact,
    description: row.description,
    help: row.help,
    helpUrl: row.help_url,
    wcagTags: row.wcag_tags,
    selector: row.selector,
    html: row.html,
    xpath: row.xpath,
    checkSource: row.check_source,
    category: row.category,
    suggestedFix: row.suggested_fix,
    fixConfidence: row.fix_confidence,
    llmConfidence: (row.llm_confidence as string | null) ?? null,
    wcagCriterion: extractWcagCriterion(row.wcag_tags),
    createdAt: row.created_at,
  };
}
