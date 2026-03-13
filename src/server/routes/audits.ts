import { getDb } from "../db/client.ts";
import { CreateAuditSchema, PaginationSchema } from "../types.ts";
import type { AuditResponse } from "../types.ts";
import { computeWcagScore } from "../../reporter/wcag-score.ts";


export async function handleAudits(req: Request, url: URL): Promise<Response> {
  const method = req.method;
  const pathParts = url.pathname.replace("/api/audits", "").split("/").filter(Boolean);

  if (method === "POST" && pathParts.length === 0) {
    return createAudit(req);
  }
  if (method === "GET" && pathParts.length === 0) {
    return listAudits(url);
  }
  if (method === "GET" && pathParts.length === 1) {
    return getAudit(pathParts[0]);
  }
  if (method === "DELETE" && pathParts.length === 1) {
    return deleteAudit(pathParts[0]);
  }
  if (pathParts.length === 2) {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  return Response.json({ error: "Method Not Allowed" }, { status: 405 });
}

async function createAudit(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const parsed = CreateAuditSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }

  const db = getDb();
  const { url: auditUrl, ...config } = parsed.data;

  const [audit] = await db`
    INSERT INTO audits (url, config) VALUES (${auditUrl}, ${config})
    RETURNING id, url, status, created_at
  `;

  // Worker will pick up the pending audit from the queue
  return Response.json({
    id: audit.id,
    url: audit.url,
    status: audit.status,
    createdAt: audit.created_at,
  }, { status: 201 });
}

async function listAudits(url: URL): Promise<Response> {
  const db = getDb();
  const params = Object.fromEntries(url.searchParams);
  const { limit, offset } = PaginationSchema.parse(params);
  const VALID_STATUSES = ["pending", "running", "completed", "failed"] as const;
  const status = url.searchParams.get("status");
  if (status && !VALID_STATUSES.includes(status as any)) {
    return Response.json({ error: "Invalid status filter" }, { status: 400 });
  }

  let audits, total;
  if (status) {
    audits = await db`
      SELECT * FROM audits WHERE status = ${status}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
    [{ count: total }] = await db`SELECT COUNT(*)::int as count FROM audits WHERE status = ${status}`;
  } else {
    audits = await db`
      SELECT * FROM audits ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
    [{ count: total }] = await db`SELECT COUNT(*)::int as count FROM audits`;
  }

  return Response.json({
    data: audits.map(mapAuditRow),
    total,
    limit,
    offset,
  });
}

async function getAudit(id: string): Promise<Response> {
  const db = getDb();
  const [audit] = await db`SELECT * FROM audits WHERE id = ${id}`;
  if (!audit) return Response.json({ error: "Not Found" }, { status: 404 });

  const mapped = mapAuditRow(audit);

  // Enrich summary with issue counts from DB if missing (v4.0 audits)
  if (mapped.status === "completed" && mapped.summary) {
    const summary = mapped.summary as Record<string, unknown>;
    if (summary.totalIssues === undefined || summary.issuesByImpact === undefined) {
      const rows = await db`
        SELECT impact, COUNT(*)::int as count
        FROM issues WHERE audit_id = ${id}
        GROUP BY impact
      `;
      const issuesByImpact: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      let totalIssues = 0;
      for (const row of rows) {
        issuesByImpact[row.impact] = row.count;
        totalIssues += row.count;
      }
      summary.totalIssues = totalIssues;
      summary.issuesByImpact = issuesByImpact;

      // Compute wcagScore if missing
      if (mapped.wcagScore === null) {
        const totalPages = (summary.totalPages as number) ?? 0;
        mapped.wcagScore = computeWcagScore(
          issuesByImpact as { critical: number; serious: number; moderate: number; minor: number },
          totalPages,
        );
      }
    }
  }

  return Response.json(mapped);
}

async function deleteAudit(id: string): Promise<Response> {
  const db = getDb();
  await db`DELETE FROM audits WHERE id = ${id}`;
  return new Response(null, { status: 204 });
}

function mapAuditRow(row: Record<string, unknown>): AuditResponse {
  return {
    id: row.id,
    url: row.url,
    config: row.config,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    summary: row.summary,
    discovery: row.discovery,
    llmUsage: row.llm_usage,
    wcagScore: row.wcag_score,
    durationSeconds: row.duration_seconds,
    crawlErrors: row.crawl_errors,
    templateClusters: row.template_clusters,
    regression: row.regression,
  } as AuditResponse;
}
