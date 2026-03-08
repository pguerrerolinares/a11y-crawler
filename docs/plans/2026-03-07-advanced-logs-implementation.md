# Advanced Logs System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the logs page to a full HTTP API inspector with advanced filtering, request/response detail modal, and live WebSocket streaming.

**Architecture:** Extend the existing `request_logs` table with response capture columns. Enhance the logs API with rich filtering. Add a dedicated WS channel for live log streaming. Rebuild the frontend logs page with a filter bar, enhanced table, detail modal, and live indicator.

**Tech Stack:** Bun.serve + Bun.sql (backend), React 19 + TanStack Query + shadcn/ui (frontend), existing WebSocket infrastructure.

---

### Task 1: Database Schema — Add response capture columns

**Files:**
- Modify: `src/server/db/schema.sql`

**Step 1: Add new columns to schema.sql**

Add after the existing `request_logs` table definition (before the CREATE INDEX statements):

```sql
-- In the CREATE TABLE request_logs block, these columns already exist:
--   response_size INT, request_body JSONB, error TEXT
-- Add these new columns to the CREATE TABLE:
--   response_body TEXT,
--   content_type TEXT,
--   query_params JSONB
```

Update the `CREATE TABLE IF NOT EXISTS request_logs` block to include the 3 new columns:

```sql
CREATE TABLE IF NOT EXISTS request_logs (
  id            SERIAL PRIMARY KEY,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  status_code   INT,
  duration_ms   INT,
  ip            TEXT,
  user_agent    TEXT,
  request_body  JSONB,
  response_size INT,
  error         TEXT,
  response_body TEXT,
  content_type  TEXT,
  query_params  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Step 2: Run ALTER TABLE on live database**

Since the table already exists, run the migration:

```bash
docker exec a11y-postgres psql -U postgres -d a11y -c "ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS response_body TEXT; ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS content_type TEXT; ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS query_params JSONB;"
```

**Step 3: Commit**

```bash
git add src/server/db/schema.sql
git commit -m "feat(db): add response_body, content_type, query_params to request_logs"
```

---

### Task 2: Middleware — Capture response data

**Files:**
- Modify: `src/server/middleware/logger.ts`

**Step 1: Update logRequest to accept Response and capture new fields**

The current signature is `logRequest(req, status, durationMs, error?)`. Change it to accept the full Response object so we can extract body, content-type, and size.

New signature: `logRequest(req: Request, response: Response, durationMs: number, error?: string)`

```typescript
import { getDb } from "../db/client.ts";

const MAX_RESPONSE_BODY = 2048;

export async function logRequest(req: Request, response: Response, durationMs: number, error?: string) {
  const db = getDb();
  const url = new URL(req.url);

  if (!url.pathname.startsWith("/api/")) return;

  // Parse request body for POST/PUT
  let requestBody = null;
  if (req.method === "POST" || req.method === "PUT") {
    try {
      requestBody = await req.clone().json();
    } catch {}
  }

  // Parse query params
  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });
  const hasQueryParams = Object.keys(queryParams).length > 0;

  // Capture response body (truncated) and metadata
  const contentType = response.headers.get("content-type") || null;
  let responseBody: string | null = null;
  let responseSize: number | null = null;
  try {
    const cloned = response.clone();
    const text = await cloned.text();
    responseSize = text.length;
    responseBody = text.length > MAX_RESPONSE_BODY ? text.slice(0, MAX_RESPONSE_BODY) : text;
  } catch {}

  await db`INSERT INTO request_logs (method, path, status_code, duration_ms, ip, user_agent, request_body, response_size, error, response_body, content_type, query_params)
    VALUES (
      ${req.method},
      ${url.pathname},
      ${response.status},
      ${durationMs},
      ${req.headers.get("x-forwarded-for") || "unknown"},
      ${req.headers.get("user-agent") || ""},
      ${requestBody},
      ${responseSize},
      ${error || null},
      ${responseBody},
      ${contentType},
      ${hasQueryParams ? queryParams : null}
    )`.catch(console.error);
}
```

**Step 2: Update caller in `src/server/index.ts`**

The caller currently passes `response.status` as second arg. Change to pass the full response:

In `src/server/index.ts`, line ~39:
```typescript
// Before:
logRequest(reqClone, response.status, Date.now() - start);
// After:
logRequest(reqClone, response, Date.now() - start);
```

In the catch block, line ~65:
```typescript
// Before:
logRequest(req, 500, Date.now() - start, message);
// After:
const errResponse = Response.json({ error: "Internal Server Error" }, { status: 500 });
logRequest(req, errResponse.clone(), Date.now() - start, message);
return errResponse;
```

**Step 3: Verify the server starts**

```bash
cd /home/paul/Documentos/proyectos/a11y-crawler-v2 && bun run src/server/index.ts
```

Expected: "Server running on http://localhost:3000" and no errors.

**Step 4: Commit**

```bash
git add src/server/middleware/logger.ts src/server/index.ts
git commit -m "feat(middleware): capture response body, content-type, query params in logs"
```

---

### Task 3: Backend — Enhanced log filters and detail endpoint

**Files:**
- Modify: `src/server/types.ts` (LogFilterSchema)
- Modify: `src/server/routes/logs.ts`

**Step 1: Update LogFilterSchema in types.ts**

```typescript
export const LogFilterSchema = PaginationSchema.extend({
  path: z.string().optional(),
  method: z.string().optional(),      // comma-separated: "GET,POST"
  status: z.string().optional(),      // exact "404" or range "4xx"
  ip: z.string().optional(),
  from: z.string().optional(),        // ISO datetime
  to: z.string().optional(),          // ISO datetime
  minDuration: z.coerce.number().optional(), // minimum ms
});
```

**Step 2: Rewrite routes/logs.ts with enhanced filters + detail endpoint**

```typescript
import { getDb } from "../db/client.ts";
import { LogFilterSchema } from "../types.ts";

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
    const methods = method.split(",").map(m => m.trim().toUpperCase());
    const placeholders = methods.map((_, i) => `$${paramIdx + i}`).join(", ");
    conditions.push(`method IN (${placeholders})`);
    values.push(...methods);
    paramIdx += methods.length;
  }
  if (status) {
    if (status.endsWith("xx")) {
      // Range: "4xx" means 400-499
      const base = parseInt(status[0], 10) * 100;
      conditions.push(`status_code >= $${paramIdx} AND status_code < $${paramIdx + 1}`);
      values.push(base, base + 100);
      paramIdx += 2;
    } else {
      conditions.push(`status_code = $${paramIdx}`);
      values.push(parseInt(status, 10));
      paramIdx++;
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
  if (minDuration) {
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
```

**Step 3: Add route for `/api/logs/:id` in index.ts**

In `src/server/index.ts`, update the routing in `handleApiRoute`:

```typescript
// Before:
if (url.pathname === "/api/logs") {
  return handleLogs(req, url);
}
// After:
if (url.pathname === "/api/logs" || url.pathname.match(/^\/api\/logs\/\d+$/)) {
  return handleLogs(req, url);
}
```

**Step 4: Verify with curl**

```bash
curl -s http://localhost:3000/api/logs | head -c 200
```

Expected: JSON response with `data`, `total`, `limit`, `offset`.

**Step 5: Commit**

```bash
git add src/server/types.ts src/server/routes/logs.ts src/server/index.ts
git commit -m "feat(api): enhanced log filters + detail endpoint GET /api/logs/:id"
```

---

### Task 4: Backend — WebSocket log streaming

**Files:**
- Modify: `src/server/ws.ts`
- Modify: `src/server/middleware/logger.ts`
- Modify: `src/server/index.ts`

**Step 1: Add log subscribers and broadcast to ws.ts**

Add a separate set for log-watching clients and a broadcast function. Add a new WS route `/ws/logs`:

```typescript
// Add at top of ws.ts, after existing client map:
const logClients = new Set<ServerWebSocket<WsData>>();

// Paths to exclude from live log streaming (noise filter)
const LOG_NOISE_PATHS = ["/api/logs", "/ws", "/health"];
const LOG_NOISE_EXTENSIONS = [".js", ".css", ".svg", ".ico", ".png", ".jpg", ".woff", ".woff2"];

function isNoisyLog(path: string): boolean {
  if (LOG_NOISE_PATHS.some(p => path.startsWith(p))) return true;
  if (LOG_NOISE_EXTENSIONS.some(ext => path.endsWith(ext))) return true;
  if (path.startsWith("/assets/")) return true;
  return false;
}

export function broadcastLog(log: Record<string, unknown>) {
  if (logClients.size === 0) return;
  const path = log.path as string;
  if (isNoisyLog(path)) return;
  const msg = JSON.stringify({ type: "new_log", data: log });
  for (const ws of logClients) {
    ws.send(msg);
  }
}
```

Update `WsData` to support both audit and log modes:

```typescript
interface WsData {
  auditId?: string;
  mode: "audit" | "logs";
}
```

Update `handleWsUpgrade` to also handle `/ws/logs`:

```typescript
export function handleWsUpgrade(req: Request, server: any): Response | undefined {
  const url = new URL(req.url);

  // /ws/logs — log streaming
  if (url.pathname === "/ws/logs") {
    const success = server.upgrade<WsData>(req, { data: { mode: "logs" } });
    if (success) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  // /ws/audits/:id — audit progress
  const match = url.pathname.match(/^\/ws\/audits\/([^/]+)$/);
  if (!match) return undefined;
  const auditId = match[1];
  const success = server.upgrade<WsData>(req, { data: { auditId, mode: "audit" } });
  if (success) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}
```

Update `wsOpen` and `wsClose` to handle log clients:

```typescript
export function wsOpen(ws: ServerWebSocket<WsData>) {
  if (ws.data.mode === "logs") {
    logClients.add(ws);
    return;
  }
  const { auditId } = ws.data;
  if (!auditId) return;
  if (!clients.has(auditId)) clients.set(auditId, new Set());
  clients.get(auditId)!.add(ws);
}

export function wsClose(ws: ServerWebSocket<WsData>) {
  if (ws.data.mode === "logs") {
    logClients.delete(ws);
    return;
  }
  const { auditId } = ws.data;
  if (!auditId) return;
  clients.get(auditId)?.delete(ws);
  if (clients.get(auditId)?.size === 0) clients.delete(auditId);
}
```

**Step 2: Call broadcastLog from middleware**

In `src/server/middleware/logger.ts`, after the INSERT, call `broadcastLog`:

```typescript
import { broadcastLog } from "../ws.ts";

// At the end of logRequest, after the db insert, add:
broadcastLog({
  id: null, // We don't have the inserted ID without RETURNING
  method: req.method,
  path: url.pathname,
  statusCode: response.status,
  durationMs: durationMs,
  ip: req.headers.get("x-forwarded-for") || "unknown",
  responseSize: responseSize,
  contentType: contentType,
  createdAt: new Date().toISOString(),
});
```

Actually, to get the real ID, change the INSERT to use RETURNING:

```typescript
const [inserted] = await db`INSERT INTO request_logs (...)
  VALUES (...)
  RETURNING id, created_at`.catch(err => {
    console.error(err);
    return [null];
  });

if (inserted) {
  broadcastLog({
    id: inserted.id,
    method: req.method,
    path: url.pathname,
    statusCode: response.status,
    durationMs,
    ip: req.headers.get("x-forwarded-for") || "unknown",
    responseSize,
    contentType,
    createdAt: inserted.created_at,
  });
}
```

**Step 3: Verify server starts and WS connects**

```bash
cd /home/paul/Documentos/proyectos/a11y-crawler-v2 && bun run src/server/index.ts
```

Test WS with websocat or curl (just verify no crash).

**Step 4: Commit**

```bash
git add src/server/ws.ts src/server/middleware/logger.ts
git commit -m "feat(ws): add live log streaming via /ws/logs with noise filter"
```

---

### Task 5: Frontend — Update API client types

**Files:**
- Modify: `frontend/src/lib/api.ts`

**Step 1: Update LogEntry and add LogDetail interfaces**

```typescript
// Replace existing LogEntry:
export interface LogEntry {
  id: number;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip: string;
  responseSize: number | null;
  contentType: string | null;
  createdAt: string;
}

// Add new interface for detail view:
export interface LogDetail extends LogEntry {
  userAgent: string | null;
  requestBody: Record<string, unknown> | null;
  responseBody: string | null;
  queryParams: Record<string, string> | null;
  error: string | null;
}
```

**Step 2: Add logs.get method to api object**

```typescript
logs: {
  list: (params?: string) => request<PaginatedResponse<LogEntry>>(`/logs${params ? `?${params}` : ""}`),
  get: (id: number) => request<LogDetail>(`/logs/${id}`),
},
```

**Step 3: Commit**

```bash
cd /home/paul/Documentos/proyectos/a11y-crawler-v2/frontend && git add src/lib/api.ts
git commit -m "feat(frontend): update LogEntry types and add logs.get API method"
```

---

### Task 6: Frontend — Log filter bar component

**Files:**
- Create: `frontend/src/components/log-filters.tsx`

**Step 1: Create the filter bar component**

```tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, X } from "lucide-react";

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;

export interface LogFilters {
  method: string[];
  path: string;
  status: string;
  ip: string;
  from: string;
  to: string;
  minDuration: string;
}

export const emptyFilters: LogFilters = {
  method: [],
  path: "",
  status: "",
  ip: "",
  from: "",
  to: "",
  minDuration: "",
};

interface LogFilterBarProps {
  filters: LogFilters;
  onChange: (filters: LogFilters) => void;
  onRefresh: () => void;
}

export function LogFilterBar({ filters, onChange, onRefresh }: LogFilterBarProps) {
  const toggleMethod = (m: string) => {
    const next = filters.method.includes(m)
      ? filters.method.filter(x => x !== m)
      : [...filters.method, m];
    onChange({ ...filters, method: next });
  };

  const hasFilters = filters.method.length > 0 || filters.path || filters.status || filters.ip || filters.from || filters.to || filters.minDuration;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium shrink-0">Method:</span>
        {METHODS.map(m => (
          <Badge
            key={m}
            variant={filters.method.includes(m) ? "default" : "outline"}
            className="cursor-pointer select-none"
            onClick={() => toggleMethod(m)}
          >
            {m}
          </Badge>
        ))}
      </div>

      <div className="grid gap-2 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <Input
          placeholder="Path..."
          value={filters.path}
          onChange={e => onChange({ ...filters, path: e.target.value })}
          className="text-sm"
        />
        <Input
          placeholder="Status (404, 4xx...)"
          value={filters.status}
          onChange={e => onChange({ ...filters, status: e.target.value })}
          className="text-sm"
        />
        <Input
          placeholder="IP..."
          value={filters.ip}
          onChange={e => onChange({ ...filters, ip: e.target.value })}
          className="text-sm"
        />
        <Input
          type="datetime-local"
          value={filters.from}
          onChange={e => onChange({ ...filters, from: e.target.value })}
          className="text-sm"
          title="From"
        />
        <Input
          type="datetime-local"
          value={filters.to}
          onChange={e => onChange({ ...filters, to: e.target.value })}
          className="text-sm"
          title="To"
        />
        <Input
          type="number"
          placeholder="Min duration (ms)"
          value={filters.minDuration}
          onChange={e => onChange({ ...filters, minDuration: e.target.value })}
          className="text-sm"
        />
      </div>

      <div className="flex items-center gap-2">
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => onChange(emptyFilters)}>
            <X className="h-3 w-3 mr-1" /> Clear
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-3 w-3 mr-1" /> Refresh
        </Button>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
cd /home/paul/Documentos/proyectos/a11y-crawler-v2/frontend && git add src/components/log-filters.tsx
git commit -m "feat(frontend): add LogFilterBar component"
```

---

### Task 7: Frontend — Log detail modal component

**Files:**
- Create: `frontend/src/components/log-detail-modal.tsx`

**Step 1: Create the detail modal**

```tsx
import { useQuery } from "@tanstack/react-query";
import { api, type LogDetail } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface LogDetailModalProps {
  logId: number | null;
  onClose: () => void;
}

function statusColor(code: number) {
  if (code < 300) return "bg-green-500/15 text-green-700 dark:text-green-400";
  if (code < 400) return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
  if (code < 500) return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400";
  return "bg-red-500/15 text-red-700 dark:text-red-400";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function JsonBlock({ data }: { data: unknown }) {
  if (!data) return <p className="text-sm text-muted-foreground">No data</p>;
  return (
    <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-80 overflow-y-auto">
      {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground w-24 shrink-0">{label}</span>
      <span className="text-sm break-all">{value ?? "—"}</span>
    </div>
  );
}

export function LogDetailModal({ logId, onClose }: LogDetailModalProps) {
  const { data: log, isLoading } = useQuery({
    queryKey: ["log-detail", logId],
    queryFn: () => api.logs.get(logId!),
    enabled: logId !== null,
  });

  return (
    <Dialog open={logId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm">
            {log && (
              <>
                <Badge className={statusColor(log.statusCode)} variant="secondary">{log.statusCode}</Badge>
                <span>{log.method}</span>
                <span className="text-muted-foreground truncate">{log.path}</span>
              </>
            )}
            {!log && "Log Detail"}
          </DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}

        {log && (
          <Tabs defaultValue="general">
            <TabsList>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="request">Request</TabsTrigger>
              <TabsTrigger value="response">Response</TabsTrigger>
              {log.error && <TabsTrigger value="error">Error</TabsTrigger>}
            </TabsList>

            <TabsContent value="general" className="mt-3 space-y-1">
              <InfoRow label="Method" value={log.method} />
              <InfoRow label="Path" value={<span className="font-mono">{log.path}</span>} />
              <InfoRow label="Status" value={<Badge className={statusColor(log.statusCode)} variant="secondary">{log.statusCode}</Badge>} />
              <InfoRow label="Duration" value={`${log.durationMs}ms`} />
              <InfoRow label="IP" value={log.ip} />
              <InfoRow label="User-Agent" value={log.userAgent} />
              <InfoRow label="Time" value={new Date(log.createdAt).toLocaleString()} />
            </TabsContent>

            <TabsContent value="request" className="mt-3 space-y-4">
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2">Query Parameters</h4>
                {log.queryParams && Object.keys(log.queryParams).length > 0 ? (
                  <div className="bg-muted/50 rounded-md p-3 space-y-1">
                    {Object.entries(log.queryParams).map(([k, v]) => (
                      <div key={k} className="flex gap-2 text-xs">
                        <span className="font-mono font-medium">{k}:</span>
                        <span className="font-mono text-muted-foreground">{v}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No query parameters</p>
                )}
              </div>
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2">Request Body</h4>
                <JsonBlock data={log.requestBody} />
              </div>
            </TabsContent>

            <TabsContent value="response" className="mt-3 space-y-4">
              <div className="flex gap-4">
                <InfoRow label="Content-Type" value={log.contentType} />
                <InfoRow label="Size" value={formatBytes(log.responseSize)} />
              </div>
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2">
                  Response Body
                  {log.responseBody && log.responseBody.length >= 2048 && (
                    <span className="ml-2 text-yellow-600">(truncated to 2KB)</span>
                  )}
                </h4>
                <JsonBlock data={log.responseBody} />
              </div>
            </TabsContent>

            {log.error && (
              <TabsContent value="error" className="mt-3">
                <div className="bg-red-500/10 border border-red-500/20 rounded-md p-4">
                  <p className="text-sm text-red-700 dark:text-red-400 font-mono whitespace-pre-wrap">{log.error}</p>
                </div>
              </TabsContent>
            )}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Commit**

```bash
cd /home/paul/Documentos/proyectos/a11y-crawler-v2/frontend && git add src/components/log-detail-modal.tsx
git commit -m "feat(frontend): add LogDetailModal component with tabs"
```

---

### Task 8: Frontend — Live WebSocket hook for logs

**Files:**
- Create: `frontend/src/hooks/use-log-stream.ts`

**Step 1: Create the WebSocket hook**

```typescript
import { useState, useEffect, useRef, useCallback } from "react";
import type { LogEntry } from "@/lib/api";

type ConnectionStatus = "connected" | "disconnected" | "connecting";

export function useLogStream() {
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/logs`);

    ws.onopen = () => setStatus("connected");

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "new_log" && msg.data) {
          setLiveLogs(prev => [msg.data as LogEntry, ...prev].slice(0, 100));
        }
      } catch {}
    };

    ws.onclose = () => {
      setStatus("disconnected");
      wsRef.current = null;
      // Auto-reconnect after 3 seconds
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();

    wsRef.current = ws;
  }, []);

  const disconnect = useCallback(() => {
    clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("disconnected");
  }, []);

  const clearLive = useCallback(() => setLiveLogs([]), []);

  useEffect(() => {
    connect();
    return disconnect;
  }, [connect, disconnect]);

  return { liveLogs, status, clearLive };
}
```

**Step 2: Commit**

```bash
cd /home/paul/Documentos/proyectos/a11y-crawler-v2/frontend && git add src/hooks/use-log-stream.ts
git commit -m "feat(frontend): add useLogStream WebSocket hook"
```

---

### Task 9: Frontend — Rewrite logs page

**Files:**
- Modify: `frontend/src/pages/logs.tsx`

**Step 1: Rewrite the full logs page**

```tsx
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type LogEntry } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { LogFilterBar, type LogFilters, emptyFilters } from "@/components/log-filters";
import { LogDetailModal } from "@/components/log-detail-modal";
import { useLogStream } from "@/hooks/use-log-stream";

const methodColors: Record<string, string> = {
  GET: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  POST: "bg-green-500/15 text-green-700 dark:text-green-400",
  DELETE: "bg-red-500/15 text-red-700 dark:text-red-400",
  PUT: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  PATCH: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
};

function statusColor(code: number) {
  if (code < 300) return "bg-green-500/15 text-green-700 dark:text-green-400";
  if (code < 400) return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
  if (code < 500) return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400";
  return "bg-red-500/15 text-red-700 dark:text-red-400";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function buildParams(filters: LogFilters, limit: number, offset: number): string {
  const p = new URLSearchParams();
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  if (filters.method.length > 0) p.set("method", filters.method.join(","));
  if (filters.path) p.set("path", filters.path);
  if (filters.status) p.set("status", filters.status);
  if (filters.ip) p.set("ip", filters.ip);
  if (filters.from) p.set("from", new Date(filters.from).toISOString());
  if (filters.to) p.set("to", new Date(filters.to).toISOString());
  if (filters.minDuration) p.set("minDuration", filters.minDuration);
  return p.toString();
}

export default function Logs() {
  const [filters, setFilters] = useState<LogFilters>(emptyFilters);
  const [offset, setOffset] = useState(0);
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const limit = 30;

  const queryParams = useMemo(() => buildParams(filters, limit, offset), [filters, limit, offset]);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["logs", queryParams],
    queryFn: () => api.logs.list(queryParams),
  });

  const { liveLogs, status: wsStatus } = useLogStream();

  // Merge live logs with fetched data (only on first page, no active filters)
  const hasFilters = filters.method.length > 0 || filters.path || filters.status || filters.ip || filters.from || filters.to || filters.minDuration;
  const displayLogs = useMemo(() => {
    if (offset > 0 || hasFilters || !data?.data) return data?.data ?? [];
    // Prepend live logs that aren't already in data
    const existingIds = new Set(data.data.map(l => l.id));
    const newLive = liveLogs.filter(l => l.id && !existingIds.has(l.id));
    return [...newLive, ...data.data];
  }, [data, liveLogs, offset, hasFilters]);

  const handleFilterChange = (f: LogFilters) => {
    setFilters(f);
    setOffset(0);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Request Logs</h1>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div className={`h-2 w-2 rounded-full ${wsStatus === "connected" ? "bg-green-500 animate-pulse" : wsStatus === "connecting" ? "bg-yellow-500" : "bg-gray-400"}`} />
            <span className="text-xs text-muted-foreground">
              {wsStatus === "connected" ? "Live" : wsStatus === "connecting" ? "Connecting..." : "Disconnected"}
            </span>
          </div>
        </div>
      </div>

      <LogFilterBar filters={filters} onChange={handleFilterChange} onRefresh={() => refetch()} />

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {!isLoading && (
        <>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayLogs.map((log: LogEntry) => (
                  <TableRow
                    key={log.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setSelectedLogId(log.id)}
                  >
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge className={methodColors[log.method] ?? ""} variant="secondary">
                        {log.method}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs max-w-xs truncate">{log.path}</TableCell>
                    <TableCell>
                      <Badge className={statusColor(log.statusCode)} variant="secondary">
                        {log.statusCode}
                      </Badge>
                    </TableCell>
                    <TableCell className={`text-xs ${log.durationMs > 1000 ? "text-red-600 dark:text-red-400 font-medium" : ""}`}>
                      {log.durationMs}ms
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{log.ip}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatBytes(log.responseSize)}</TableCell>
                  </TableRow>
                ))}
                {displayLogs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      No logs found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{data?.total ?? 0} total logs</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" disabled={!data || offset + limit >= data.total} onClick={() => setOffset(offset + limit)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}

      <LogDetailModal logId={selectedLogId} onClose={() => setSelectedLogId(null)} />
    </div>
  );
}
```

**Step 2: Verify frontend compiles**

```bash
cd /home/paul/Documentos/proyectos/a11y-crawler-v2/frontend && bunx vite build
```

Expected: Build succeeds with no errors.

**Step 3: Commit**

```bash
cd /home/paul/Documentos/proyectos/a11y-crawler-v2/frontend && git add src/pages/logs.tsx
git commit -m "feat(frontend): rewrite logs page with filters, live streaming, detail modal"
```

---

### Task 10: Integration testing and polish

**Step 1: Start servers and test end-to-end**

```bash
cd /home/paul/Documentos/proyectos/a11y-crawler-v2 && bun run src/server/index.ts
```

In another terminal:
```bash
cd /home/paul/Documentos/proyectos/a11y-crawler-v2/frontend && bunx vite --port 5173
```

**Step 2: Generate some test logs**

```bash
curl http://localhost:3000/api/audits
curl http://localhost:3000/api/logs
curl -X POST http://localhost:3000/api/audits -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
```

**Step 3: Manual verification checklist**

- [ ] Filter bar renders with method chips, inputs, clear/refresh buttons
- [ ] Method chip toggles work (multi-select)
- [ ] Path filter works
- [ ] Status filter works (exact and range like "4xx")
- [ ] Date range filters work
- [ ] Min duration filter works
- [ ] Clear button resets all filters
- [ ] Refresh button re-fetches data
- [ ] Table shows all 7 columns (Time, Method, Path, Status, Duration, IP, Size)
- [ ] Clicking a row opens the detail modal
- [ ] Modal shows 3-4 tabs (General, Request, Response, Error if applicable)
- [ ] General tab shows all metadata
- [ ] Request tab shows query params and body
- [ ] Response tab shows content-type, size, truncated body
- [ ] Live indicator shows green dot when WS connected
- [ ] New requests appear at top when on first page with no filters
- [ ] Pagination works correctly
- [ ] Slow requests (>1000ms) are highlighted in red

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: polish advanced logs system"
```

---

### Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | DB schema — add response columns | `schema.sql` |
| 2 | Middleware — capture response data | `logger.ts`, `index.ts` |
| 3 | API — enhanced filters + detail endpoint | `types.ts`, `logs.ts`, `index.ts` |
| 4 | WS — live log streaming | `ws.ts`, `logger.ts` |
| 5 | Frontend API types | `api.ts` |
| 6 | Filter bar component | `log-filters.tsx` (new) |
| 7 | Detail modal component | `log-detail-modal.tsx` (new) |
| 8 | WS hook | `use-log-stream.ts` (new) |
| 9 | Logs page rewrite | `logs.tsx` |
| 10 | Integration test + polish | all |
