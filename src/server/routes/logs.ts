import { getDb } from "../db/client.ts";
import { LogFilterSchema } from "../types.ts";

export async function handleLogs(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return Response.json({ error: "Method Not Allowed" }, { status: 405 });

  const db = getDb();
  const params = Object.fromEntries(url.searchParams);
  const { limit, offset, path, status, from } = LogFilterSchema.parse(params);

  const conditions: string[] = [];
  const values: any[] = [];
  let paramIdx = 1;

  if (path) {
    conditions.push(`path LIKE $${paramIdx}`);
    values.push(`%${path}%`);
    paramIdx++;
  }
  if (status) {
    conditions.push(`status_code = $${paramIdx}`);
    values.push(status);
    paramIdx++;
  }
  if (from) {
    conditions.push(`created_at >= $${paramIdx}`);
    values.push(from);
    paramIdx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const logs = await db.unsafe(
    `SELECT * FROM request_logs ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, limit, offset]
  );
  const [{ count: total }] = await db.unsafe(
    `SELECT COUNT(*)::int as count FROM request_logs ${where}`,
    values
  );

  return Response.json({ data: logs, total, limit, offset });
}
