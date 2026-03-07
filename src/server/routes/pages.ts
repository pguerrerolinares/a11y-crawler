import { getDb } from "../db/client.ts";
import { PaginationSchema } from "../types.ts";

export async function handlePages(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return Response.json({ error: "Method Not Allowed" }, { status: 405 });

  // /api/audits/:id/pages
  const auditMatch = url.pathname.match(/^\/api\/audits\/([^/]+)\/pages$/);
  if (auditMatch) return listPagesByAudit(auditMatch[1], url);

  // /api/pages/:id
  const pageMatch = url.pathname.match(/^\/api\/pages\/([^/]+)$/);
  if (pageMatch) return getPage(pageMatch[1]);

  return Response.json({ error: "Not Found" }, { status: 404 });
}

async function listPagesByAudit(auditId: string, url: URL): Promise<Response> {
  const db = getDb();
  const params = Object.fromEntries(url.searchParams);
  const { limit, offset } = PaginationSchema.parse(params);
  const sort = url.searchParams.get("sort") === "issues_desc" ? "issue_count DESC" : "created_at ASC";

  const pages = await db.unsafe(
    `SELECT * FROM pages WHERE audit_id = $1 ORDER BY ${sort} LIMIT $2 OFFSET $3`,
    [auditId, limit, offset]
  );
  const [{ count: total }] = await db`SELECT COUNT(*)::int as count FROM pages WHERE audit_id = ${auditId}`;

  return Response.json({ data: pages, total, limit, offset });
}

async function getPage(id: string): Promise<Response> {
  const db = getDb();
  const [page] = await db`SELECT * FROM pages WHERE id = ${id}`;
  if (!page) return Response.json({ error: "Not Found" }, { status: 404 });
  return Response.json(page);
}
