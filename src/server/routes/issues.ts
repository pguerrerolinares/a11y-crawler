import { getDb } from "../db/client.ts";
import { IssueFilterSchema } from "../types.ts";

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
  const { limit, offset, impact, rule, category } = IssueFilterSchema.parse(params);

  const conditions = [`${filterCol} = $1`];
  const values: any[] = [filterVal];
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

  const where = conditions.join(" AND ");
  const issues = await db.unsafe(
    `SELECT * FROM issues WHERE ${where} ORDER BY created_at ASC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, limit, offset]
  );
  const [{ count: total }] = await db.unsafe(
    `SELECT COUNT(*)::int as count FROM issues WHERE ${where}`,
    values
  );

  return Response.json({ data: issues, total, limit, offset });
}

async function listSharedIssues(auditId: string): Promise<Response> {
  const db = getDb();
  const issues = await db`SELECT * FROM shared_issues WHERE audit_id = ${auditId} ORDER BY page_count DESC`;
  return Response.json({ data: issues });
}
