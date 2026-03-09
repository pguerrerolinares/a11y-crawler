import { getDb } from "../db/client.ts";
import { CreateAuditSchema, PaginationSchema } from "../types.ts";
import type { AuditResponse } from "../types.ts";
import { startCrawl } from "../jobs/manager.ts";

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

  startCrawl(audit.id, auditUrl, config);

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
  return Response.json(mapAuditRow(audit));
}

async function deleteAudit(id: string): Promise<Response> {
  const db = getDb();
  await db`DELETE FROM audits WHERE id = ${id}`;
  return new Response(null, { status: 204 });
}

function mapAuditRow(row: any): AuditResponse {
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
  };
}
