import { getDb } from "../db/client.ts";
import { LogFilterSchema } from "../types.ts";

function mapLogSummary(row: Record<string, unknown>) {
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
    hasQueryParams: Boolean(row.has_query_params),
    hasRequestBody: Boolean(row.has_request_body),
    hasResponseBody: Boolean(row.has_response_body),
  };
}

function mapLogRow(row: Record<string, unknown>) {
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
  const parsed = LogFilterSchema.safeParse(params);
  if (!parsed.success) {
    return Response.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }
  const { limit, offset, path, method, status, ip, from, to, params: paramsSearch, reqBody, resBody } = parsed.data;

  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let paramIdx = 1;

  // Permanent noise filter — never show /api/logs* entries
  conditions.push(`path NOT LIKE $${paramIdx}`);
  values.push("/api/logs%");
  paramIdx++;

  if (path) {
    conditions.push(`path ILIKE $${paramIdx}`);
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
    if (/^[1-5]xx$/.test(status)) {
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
  if (paramsSearch) {
    conditions.push(`query_params::text ILIKE $${paramIdx}`);
    values.push(`%${paramsSearch}%`);
    paramIdx++;
  }
  if (reqBody) {
    conditions.push(`request_body::text ILIKE $${paramIdx}`);
    values.push(`%${reqBody}%`);
    paramIdx++;
  }
  if (resBody) {
    conditions.push(`response_body ILIKE $${paramIdx}`);
    values.push(`%${resBody}%`);
    paramIdx++;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const logs = await db.unsafe(
    `SELECT id, method, path, status_code, duration_ms, ip, response_size, content_type, created_at,
      (query_params IS NOT NULL) AS has_query_params,
      (request_body IS NOT NULL) AS has_request_body,
      (response_body IS NOT NULL) AS has_response_body
     FROM request_logs ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, limit, offset]
  );
  const [{ count: total }] = await db.unsafe(
    `SELECT COUNT(*)::int as count FROM request_logs ${where}`,
    values
  );

  return Response.json({ data: logs.map(mapLogSummary), total, limit, offset });
}
