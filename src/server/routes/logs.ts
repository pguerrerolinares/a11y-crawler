import { getDb } from "../db/client.ts";
import { LogFilterSchema } from "../types.ts";

function mapLogSummary(row: any) {
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    statusCode: row.status_code,
    durationMs: row.duration_ms,
    ip: row.ip,
    responseSize: row.response_size,
    contentType: row.content_type,
    createdAt: row.created_at,
  };
}

function mapLogRow(row: any) {
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    statusCode: row.status_code,
    durationMs: row.duration_ms,
    ip: row.ip,
    userAgent: row.user_agent,
    requestBody: row.request_body,
    responseSize: row.response_size,
    responseBody: row.response_body,
    contentType: row.content_type,
    queryParams: row.query_params,
    error: row.error,
    createdAt: row.created_at,
  };
}

export async function handleLogs(req: Request, url: URL): Promise<Response> {
  const db = getDb();

  // GET /api/logs/:id — detail
  const detailMatch = url.pathname.match(/^\/api\/logs\/(\d+)$/);
  if (detailMatch) {
    if (req.method !== "GET") return Response.json({ error: "Method Not Allowed" }, { status: 405 });
    const logId = parseInt(detailMatch[1], 10);
    const [row] = await db`SELECT * FROM request_logs WHERE id = ${logId}`;
    if (!row) return Response.json({ error: "Not Found" }, { status: 404 });
    return Response.json(mapLogRow(row));
  }

  // GET /api/logs — list with filters
  if (req.method !== "GET") return Response.json({ error: "Method Not Allowed" }, { status: 405 });

  const params = Object.fromEntries(url.searchParams);
  const { limit, offset, path, method, status, ip, from, to, minDuration } = LogFilterSchema.parse(params);

  const conditions: string[] = [];
  const values: any[] = [];
  let paramIdx = 1;

  if (path) {
    conditions.push(`path LIKE $${paramIdx}`);
    values.push(`%${path}%`);
    paramIdx++;
  }
  if (method) {
    const methods = method.split(",").map((m: string) => m.trim().toUpperCase());
    const placeholders = methods.map((_: string, i: number) => `$${paramIdx + i}`).join(", ");
    conditions.push(`method IN (${placeholders})`);
    values.push(...methods);
    paramIdx += methods.length;
  }
  if (status) {
    if (status.endsWith("xx")) {
      const base = parseInt(status[0], 10) * 100;
      conditions.push(`status_code >= $${paramIdx} AND status_code < $${paramIdx + 1}`);
      values.push(base, base + 100);
      paramIdx += 2;
    } else {
      const code = parseInt(status, 10);
      if (!isNaN(code)) {
        conditions.push(`status_code = $${paramIdx}`);
        values.push(code);
        paramIdx++;
      }
    }
  }
  if (ip) {
    conditions.push(`ip = $${paramIdx}`);
    values.push(ip);
    paramIdx++;
  }
  if (from) {
    conditions.push(`created_at >= $${paramIdx}`);
    values.push(from);
    paramIdx++;
  }
  if (to) {
    conditions.push(`created_at <= $${paramIdx}`);
    values.push(to);
    paramIdx++;
  }
  if (minDuration !== undefined) {
    conditions.push(`duration_ms >= $${paramIdx}`);
    values.push(minDuration);
    paramIdx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const logs = await db.unsafe(
    `SELECT id, method, path, status_code, duration_ms, ip, response_size, content_type, created_at FROM request_logs ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, limit, offset]
  );
  const [{ count: total }] = await db.unsafe(
    `SELECT COUNT(*)::int as count FROM request_logs ${where}`,
    values
  );

  return Response.json({
    data: logs.map(mapLogSummary),
    total,
    limit,
    offset,
  });
}
