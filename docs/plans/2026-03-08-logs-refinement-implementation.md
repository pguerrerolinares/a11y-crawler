# Logs Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refine the Request Logs screen: backend WS cleanup, IP fix, content-based filters, icon columns for data presence, and improved filter bar.

**Architecture:** Backend cleans up unused WS log streaming and adds content-search filters. Frontend adds 3 icon columns (Params/Req/Res), a collapsible "advanced filters" row, and modal initialTab support.

**Tech Stack:** Bun + PostgreSQL (`bun:sql`), React 19, TanStack Query v5, Tailwind, lucide-react, @base-ui/react

---

### Task 1: Remove WebSocket log streaming from logger.ts

**Files:**
- Modify: `src/server/middleware/logger.ts`

**Context:** The logger currently calls `broadcastLog()` from `ws.ts` after every request. Since the frontend no longer uses WS for logs, this is dead code.

**Step 1: Remove the broadcastLog import and call**

Replace the entire file content with a cleaned version:

```ts
import { getDb } from "../db/client.ts";

const MAX_RESPONSE_BODY = 2048;

const SENSITIVE_KEYS = /^(password|token|secret|authorization|cookie|api.?key)$/i;

function sanitize(obj: unknown): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = SENSITIVE_KEYS.test(k) ? "[REDACTED]" : v;
  }
  return result;
}

const LOG_NOISE_PATHS = ["/api/logs", "/health"];

function isNoisyPath(pathname: string): boolean {
  return LOG_NOISE_PATHS.some(p => pathname.startsWith(p));
}

export async function logRequest(req: Request, response: Response, durationMs: number, error?: string) {
  const db = getDb();
  const url = new URL(req.url);

  if (!url.pathname.startsWith("/api/")) return;
  if (isNoisyPath(url.pathname)) return;

  const ip = req.headers.get("x-forwarded-for")
    || req.headers.get("x-real-ip")
    || "unknown";

  // Parse request body for POST/PUT/PATCH
  let requestBody = null;
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    try {
      requestBody = sanitize(await req.clone().json());
    } catch (e) {
      console.warn("[logger] parse failed:", (e as Error).message);
    }
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
    responseSize = new TextEncoder().encode(text).byteLength;
    responseBody = text.length > MAX_RESPONSE_BODY ? text.slice(0, MAX_RESPONSE_BODY) : text;
  } catch (e) {
    console.warn("[logger] parse failed:", (e as Error).message);
  }

  db`INSERT INTO request_logs (method, path, status_code, duration_ms, ip, user_agent, request_body, response_size, error, response_body, content_type, query_params)
    VALUES (
      ${req.method},
      ${url.pathname},
      ${response.status},
      ${durationMs},
      ${ip},
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

**Step 2: Verify no TypeScript errors**

Run: `bun build src/server/index.ts --outdir /tmp/check 2>&1 | head -20`
Expected: No errors (or warnings only)

**Step 3: Commit**

```bash
git add src/server/middleware/logger.ts
git commit -m "refactor: remove WS log broadcasting, fix IP extraction, add noise filter"
```

---

### Task 2: Remove WebSocket log streaming from ws.ts

**Files:**
- Modify: `src/server/ws.ts`

**Context:** ws.ts has two modes: audit WS (keep) and log WS (remove). Remove everything related to `logClients` and `broadcastLog`.

**Step 1: Replace ws.ts with a cleaned version (audit WS only)**

```ts
import type { ServerWebSocket } from "bun";
import { getDb } from "./db/client.ts";

interface WsData {
  auditId?: string;
  mode: "audit";
}

const clients = new Map<string, Set<ServerWebSocket<WsData>>>();

export function handleWsUpgrade(req: Request, server: any): Response | undefined {
  // /ws/audits/:id — audit progress
  const match = new URL(req.url).pathname.match(/^\/ws\/audits\/([^/]+)$/);
  if (!match) return undefined;
  const auditId = match[1];
  const success = server.upgrade<WsData>(req, { data: { auditId, mode: "audit" } });
  if (success) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}

export function wsOpen(ws: ServerWebSocket<WsData>) {
  const { auditId } = ws.data;
  if (!auditId) return;
  if (!clients.has(auditId)) clients.set(auditId, new Set());
  clients.get(auditId)!.add(ws);
}

export function wsClose(ws: ServerWebSocket<WsData>) {
  const { auditId } = ws.data;
  if (!auditId) return;
  clients.get(auditId)?.delete(ws);
  if (clients.get(auditId)?.size === 0) clients.delete(auditId);
}

export function wsMessage(_ws: ServerWebSocket<WsData>, _message: string | Buffer) {}

export function broadcastToAudit(auditId: string, event: { type: string; data: unknown }) {
  const subs = clients.get(auditId);
  if (!subs || subs.size === 0) return;
  const msg = JSON.stringify(event);
  for (const ws of subs) {
    ws.send(msg);
  }
}

const lastSentId = new Map<string, number>();

export async function startNotifyListener() {
  const db = getDb();

  setInterval(async () => {
    for (const auditId of clients.keys()) {
      try {
        const lastId = lastSentId.get(auditId) ?? 0;
        const events = await db`
          SELECT * FROM audit_events
          WHERE audit_id = ${auditId} AND id > ${lastId}
          ORDER BY id ASC
        `;
        for (const event of events) {
          broadcastToAudit(auditId, { type: event.event_type, data: event.data });
          lastSentId.set(auditId, event.id);
        }
      } catch (err) {
        console.error(`WS poll error for audit ${auditId}:`, err);
      }
    }
    for (const auditId of lastSentId.keys()) {
      if (!clients.has(auditId)) lastSentId.delete(auditId);
    }
  }, 1000);
}
```

**Step 2: Run tests to verify audit WS code still compiles**

Run: `bun test src/server/__tests__/api.test.ts 2>&1 | tail -5`
Expected: All pass (tests don't cover WS directly)

**Step 3: Commit**

```bash
git add src/server/ws.ts
git commit -m "refactor: remove log WebSocket streaming, keep audit WS intact"
```

---

### Task 3: Update LogFilterSchema — remove minDuration, add content filters

**Files:**
- Modify: `src/server/types.ts`

**Step 1: Update LogFilterSchema**

In `src/server/types.ts`, replace the `LogFilterSchema` definition (lines 25–36):

```ts
export const LogFilterSchema = PaginationSchema.extend({
  path: z.string().optional(),
  method: z.string().optional(),         // comma-separated: "GET,POST"
  status: z.string().refine(
    (v) => /^[1-5]xx$/.test(v) || /^\d{3}$/.test(v),
    { message: "status must be a 3-digit code or range like 2xx" }
  ).optional(),
  ip: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  params: z.string().optional(),     // text search in query_params
  reqBody: z.string().optional(),    // text search in request_body
  resBody: z.string().optional(),    // text search in response_body
});
```

**Step 2: Run tests**

Run: `bun test src/server/__tests__/api.test.ts 2>&1 | tail -5`
Expected: All pass

**Step 3: Commit**

```bash
git add src/server/types.ts
git commit -m "feat: update LogFilterSchema — remove minDuration, add params/reqBody/resBody"
```

---

### Task 4: Update GET /api/logs — noise filter, has_* fields, content search

**Files:**
- Modify: `src/server/routes/logs.ts`
- Modify: `src/server/__tests__/api.test.ts`

**Context:**
- The list query must always exclude `/api/logs*` paths.
- Add `has_query_params`, `has_request_body`, `has_response_body` to the SELECT.
- Add ILIKE conditions for params/reqBody/resBody filters.
- Remove minDuration condition.

**Step 1: Write the failing test first**

Add to `src/server/__tests__/api.test.ts`:

```ts
describe("GET /api/logs", () => {
  test("returns paginated logs", async () => {
    const res = await fetch(`${BASE}/api/logs?limit=5&offset=0`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
  });

  test("never returns /api/logs* paths in results", async () => {
    const res = await fetch(`${BASE}/api/logs?limit=100`);
    expect(res.status).toBe(200);
    const body = await res.json();
    body.data.forEach((log: any) => {
      expect(log.path.startsWith("/api/logs")).toBe(false);
    });
  });

  test("response rows include has_query_params, has_request_body, has_response_body", async () => {
    const res = await fetch(`${BASE}/api/logs?limit=5`);
    const body = await res.json();
    if (body.data.length > 0) {
      const row = body.data[0];
      expect(typeof row.hasQueryParams).toBe("boolean");
      expect(typeof row.hasRequestBody).toBe("boolean");
      expect(typeof row.hasResponseBody).toBe("boolean");
    }
  });
});
```

**Step 2: Run tests — verify the new tests fail**

Run: `bun test src/server/__tests__/api.test.ts --test-name-pattern "GET /api/logs" 2>&1 | tail -10`
Expected: FAIL (hasQueryParams undefined)

**Step 3: Update logs.ts**

Replace the full `handleLogs` function and `mapLogSummary` in `src/server/routes/logs.ts`:

```ts
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
    hasQueryParams: Boolean(row.has_query_params),
    hasRequestBody: Boolean(row.has_request_body),
    hasResponseBody: Boolean(row.has_response_body),
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
  const parsed = LogFilterSchema.safeParse(params);
  if (!parsed.success) {
    return Response.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }
  const { limit, offset, path, method, status, ip, from, to, params: paramsSearch, reqBody, resBody } = parsed.data;

  const conditions: string[] = [];
  const values: any[] = [];
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
```

**Step 4: Run tests — verify they pass**

Run: `bun test src/server/__tests__/api.test.ts 2>&1 | tail -10`
Expected: All pass

**Step 5: Commit**

```bash
git add src/server/routes/logs.ts src/server/__tests__/api.test.ts
git commit -m "feat: logs API — noise filter, has_* fields, content search filters"
```

---

### Task 5: Update frontend LogEntry type and buildParams

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/pages/logs.tsx` (buildParams only)

**Step 1: Add has_* fields to LogEntry in api.ts**

In `frontend/src/lib/api.ts`, replace the `LogEntry` interface (lines 67–77):

```ts
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
  hasQueryParams: boolean;
  hasRequestBody: boolean;
  hasResponseBody: boolean;
}
```

**Step 2: Update buildParams in logs.tsx to include new filters**

In `frontend/src/pages/logs.tsx`, replace the `buildParams` function (lines 26–44):

```ts
function buildParams(filters: LogFilters, limit: number, offset: number): string {
  const p = new URLSearchParams();
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  if (filters.method.length > 0) p.set("method", filters.method.join(","));
  if (filters.path) p.set("path", filters.path);
  if (filters.status) p.set("status", filters.status);
  if (filters.ip) p.set("ip", filters.ip);
  if (filters.from) {
    const d = new Date(filters.from);
    if (!isNaN(d.getTime())) p.set("from", d.toISOString());
  }
  if (filters.to) {
    const d = new Date(filters.to);
    if (!isNaN(d.getTime())) p.set("to", d.toISOString());
  }
  if (filters.params) p.set("params", filters.params);
  if (filters.reqBody) p.set("reqBody", filters.reqBody);
  if (filters.resBody) p.set("resBody", filters.resBody);
  return p.toString();
}
```

**Step 3: Run full test suite**

Run: `bun test 2>&1 | tail -5`
Expected: 85+ pass, 0 fail

**Step 4: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/pages/logs.tsx
git commit -m "feat: add hasQueryParams/hasRequestBody/hasResponseBody to LogEntry type"
```

---

### Task 6: Update LogFilters interface and filter bar component

**Files:**
- Modify: `frontend/src/components/log-filters.tsx`

**Context:** Remove `minDuration`. Add `params`, `reqBody`, `resBody`. Add a collapsible "Filters+" row that reveals the 3 new inputs.

**Step 1: Replace log-filters.tsx entirely**

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, X, SlidersHorizontal, Braces, ArrowUpFromLine, ArrowDownToLine } from "lucide-react";

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;

const methodActiveColors: Record<string, string> = {
  GET: "bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-500/40",
  POST: "bg-green-500/20 text-green-700 dark:text-green-300 border-green-500/40",
  PUT: "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300 border-yellow-500/40",
  DELETE: "bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/40",
  PATCH: "bg-purple-500/20 text-purple-700 dark:text-purple-300 border-purple-500/40",
};

export interface LogFilters {
  method: string[];
  path: string;
  status: string;
  ip: string;
  from: string;
  to: string;
  params: string;
  reqBody: string;
  resBody: string;
}

export const emptyFilters: LogFilters = {
  method: [],
  path: "",
  status: "",
  ip: "",
  from: "",
  to: "",
  params: "",
  reqBody: "",
  resBody: "",
};

interface LogFilterBarProps {
  filters: LogFilters;
  onChange: (filters: LogFilters) => void;
  onRefresh: () => void;
  isFetching?: boolean;
}

export function LogFilterBar({ filters, onChange, onRefresh, isFetching }: LogFilterBarProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const toggleMethod = (m: string) => {
    const next = filters.method.includes(m)
      ? filters.method.filter(x => x !== m)
      : [...filters.method, m];
    onChange({ ...filters, method: next });
  };

  const hasBasicFilters = filters.method.length > 0 || filters.path || filters.status ||
    filters.ip || filters.from || filters.to;
  const hasAdvancedFilters = !!(filters.params || filters.reqBody || filters.resBody);
  const hasFilters = hasBasicFilters || hasAdvancedFilters;

  return (
    <div className="space-y-2">
      {/* Row 1: Method chips + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium shrink-0">Method</span>
        {METHODS.map(m => {
          const active = filters.method.includes(m);
          return (
            <button
              key={m}
              onClick={() => toggleMethod(m)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleMethod(m); } }}
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                active
                  ? methodActiveColors[m]
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
              }`}
            >
              {m}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 px-2 text-xs ${hasAdvancedFilters ? "text-foreground" : "text-muted-foreground"}`}
            onClick={() => setShowAdvanced(v => !v)}
          >
            <SlidersHorizontal className="h-3 w-3 mr-1" />
            Filters
            {hasAdvancedFilters && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-blue-500 inline-block" />}
          </Button>
          {hasFilters && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onChange(emptyFilters)}>
              <X className="h-3 w-3 mr-1" /> Clear
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onRefresh}>
            <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {/* Row 2: Basic filters */}
      <div className="grid gap-2 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        <Input
          placeholder="Path..."
          value={filters.path}
          onChange={e => onChange({ ...filters, path: e.target.value })}
          className="h-8 text-xs"
        />
        <Input
          placeholder="Status (404, 4xx…)"
          value={filters.status}
          onChange={e => onChange({ ...filters, status: e.target.value })}
          className="h-8 text-xs"
        />
        <Input
          placeholder="IP…"
          value={filters.ip}
          onChange={e => onChange({ ...filters, ip: e.target.value })}
          className="h-8 text-xs"
        />
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none leading-none">From</span>
          <Input
            type="datetime-local"
            value={filters.from}
            onChange={e => onChange({ ...filters, from: e.target.value })}
            className="h-8 text-xs pl-9"
            aria-label="From date"
          />
        </div>
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none leading-none">To</span>
          <Input
            type="datetime-local"
            value={filters.to}
            onChange={e => onChange({ ...filters, to: e.target.value })}
            className="h-8 text-xs pl-7"
            aria-label="To date"
          />
        </div>
      </div>

      {/* Row 3: Advanced filters (collapsible) */}
      {showAdvanced && (
        <div className="grid gap-2 grid-cols-1 md:grid-cols-3">
          <div className="relative">
            <Braces className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search params…"
              value={filters.params}
              onChange={e => onChange({ ...filters, params: e.target.value })}
              className="h-8 text-xs pl-7"
            />
          </div>
          <div className="relative">
            <ArrowUpFromLine className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search req body…"
              value={filters.reqBody}
              onChange={e => onChange({ ...filters, reqBody: e.target.value })}
              className="h-8 text-xs pl-7"
            />
          </div>
          <div className="relative">
            <ArrowDownToLine className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search res body…"
              value={filters.resBody}
              onChange={e => onChange({ ...filters, resBody: e.target.value })}
              className="h-8 text-xs pl-7"
            />
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Run tests**

Run: `bun test 2>&1 | tail -5`
Expected: All pass

**Step 3: Commit**

```bash
git add frontend/src/components/log-filters.tsx
git commit -m "feat: filter bar — remove minDuration, add collapsible advanced filters (params/reqBody/resBody)"
```

---

### Task 7: Update logs.tsx — icon columns, duration colors, isFetching, tabular-nums

**Files:**
- Modify: `frontend/src/pages/logs.tsx`

**Context:** Add 3 icon columns at the end. Pass `isFetching` to filter bar. Improve duration coloring. Add `tabular-nums` and `title` to cells.

**Step 1: Replace the full logs.tsx**

```tsx
import { useState, useMemo, useCallback, memo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type LogEntry } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight, Braces, ArrowUpFromLine, ArrowDownToLine } from "lucide-react";
import { LogFilterBar, type LogFilters, emptyFilters } from "@/components/log-filters";
import { LogDetailModal } from "@/components/log-detail-modal";
import { statusColor, formatBytes } from "@/lib/format";

const methodColors: Record<string, string> = {
  GET: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  POST: "bg-green-500/15 text-green-700 dark:text-green-400",
  DELETE: "bg-red-500/15 text-red-700 dark:text-red-400",
  PUT: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  PATCH: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "medium",
});

function durationClass(ms: number): string {
  if (ms >= 1000) return "text-red-600 dark:text-red-400 font-medium";
  if (ms >= 500) return "text-yellow-600 dark:text-yellow-400";
  return "";
}

function buildParams(filters: LogFilters, limit: number, offset: number): string {
  const p = new URLSearchParams();
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  if (filters.method.length > 0) p.set("method", filters.method.join(","));
  if (filters.path) p.set("path", filters.path);
  if (filters.status) p.set("status", filters.status);
  if (filters.ip) p.set("ip", filters.ip);
  if (filters.from) {
    const d = new Date(filters.from);
    if (!isNaN(d.getTime())) p.set("from", d.toISOString());
  }
  if (filters.to) {
    const d = new Date(filters.to);
    if (!isNaN(d.getTime())) p.set("to", d.toISOString());
  }
  if (filters.params) p.set("params", filters.params);
  if (filters.reqBody) p.set("reqBody", filters.reqBody);
  if (filters.resBody) p.set("resBody", filters.resBody);
  return p.toString();
}

type InitialTab = "general" | "request" | "response";

interface LogSelection {
  id: number;
  initialTab: InitialTab;
}

const LogRow = memo(function LogRow({
  log,
  onSelect,
}: {
  log: LogEntry;
  onSelect: (id: number, tab: InitialTab) => void;
}) {
  return (
    <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => onSelect(log.id, "general")}>
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
        {dateFormatter.format(new Date(log.createdAt))}
      </TableCell>
      <TableCell className="min-w-[64px]">
        <Badge className={methodColors[log.method] ?? ""} variant="secondary">
          {log.method}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs max-w-xs truncate" title={log.path}>{log.path}</TableCell>
      <TableCell>
        <Badge className={statusColor(log.statusCode)} variant="secondary">
          {log.statusCode}
        </Badge>
      </TableCell>
      <TableCell className={`text-xs tabular-nums ${durationClass(log.durationMs)}`}>
        {log.durationMs}ms
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{log.ip}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{formatBytes(log.responseSize)}</TableCell>
      {/* Icon columns */}
      <TableCell className="w-8 text-center" onClick={e => { if (log.hasQueryParams) { e.stopPropagation(); onSelect(log.id, "request"); } }}>
        {log.hasQueryParams
          ? <Braces className="h-3 w-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 mx-auto" />
          : <span className="text-muted-foreground/30 text-xs">—</span>
        }
      </TableCell>
      <TableCell className="w-8 text-center" onClick={e => { if (log.hasRequestBody) { e.stopPropagation(); onSelect(log.id, "request"); } }}>
        {log.hasRequestBody
          ? <ArrowUpFromLine className="h-3 w-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 mx-auto" />
          : <span className="text-muted-foreground/30 text-xs">—</span>
        }
      </TableCell>
      <TableCell className="w-8 text-center" onClick={e => { if (log.hasResponseBody) { e.stopPropagation(); onSelect(log.id, "response"); } }}>
        {log.hasResponseBody
          ? <ArrowDownToLine className="h-3 w-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 mx-auto" />
          : <span className="text-muted-foreground/30 text-xs">—</span>
        }
      </TableCell>
    </TableRow>
  );
});

export default function Logs() {
  const [filters, setFilters] = useState<LogFilters>(emptyFilters);
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<LogSelection | null>(null);
  const limit = 30;

  const queryParams = useMemo(() => buildParams(filters, limit, offset), [filters, offset]);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["logs", queryParams],
    queryFn: () => api.logs.list(queryParams),
  });

  const handleFilterChange = useCallback((f: LogFilters) => {
    setFilters(f);
    setOffset(0);
  }, []);

  const handleSelect = useCallback((id: number, initialTab: InitialTab) => {
    setSelection({ id, initialTab });
  }, []);

  const handleCloseModal = useCallback(() => setSelection(null), []);

  const logs = data?.data ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Request Logs</h1>

      <LogFilterBar
        filters={filters}
        onChange={handleFilterChange}
        onRefresh={() => refetch()}
        isFetching={isFetching}
      />

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
                  <TableHead className="w-8 text-center" title="Query Params">
                    <Braces className="h-3 w-3 text-muted-foreground mx-auto" />
                  </TableHead>
                  <TableHead className="w-8 text-center" title="Request Body">
                    <ArrowUpFromLine className="h-3 w-3 text-muted-foreground mx-auto" />
                  </TableHead>
                  <TableHead className="w-8 text-center" title="Response Body">
                    <ArrowDownToLine className="h-3 w-3 text-muted-foreground mx-auto" />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log: LogEntry) => (
                  <LogRow key={log.id} log={log} onSelect={handleSelect} />
                ))}
                {logs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
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

      {selection !== null && (
        <LogDetailModal logId={selection.id} initialTab={selection.initialTab} onClose={handleCloseModal} />
      )}
    </div>
  );
}
```

**Step 2: Run tests**

Run: `bun test 2>&1 | tail -5`
Expected: All pass

**Step 3: Commit**

```bash
git add frontend/src/pages/logs.tsx
git commit -m "feat: logs table — icon columns, 3-zone duration, tabular-nums, path tooltip, isFetching spin"
```

---

### Task 8: Update LogDetailModal — initialTab prop

**Files:**
- Modify: `frontend/src/components/log-detail-modal.tsx`

**Context:** Add `initialTab` prop. Change Tabs from uncontrolled (`defaultValue`) to controlled (`value` + `onValueChange`).

**Step 1: Replace the modal component**

```tsx
import { memo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { statusColor, formatBytes } from "@/lib/format";

type InitialTab = "general" | "request" | "response";

interface LogDetailModalProps {
  logId: number | null;
  initialTab?: InitialTab;
  onClose: () => void;
}

function tryPrettyJson(data: unknown): string {
  if (typeof data === "string") {
    try { return JSON.stringify(JSON.parse(data), null, 2); } catch { return data; }
  }
  return JSON.stringify(data, null, 2);
}

function JsonBlock({ data }: { data: unknown }) {
  if (!data) return <p className="text-sm text-muted-foreground">No data</p>;
  return (
    <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all max-h-80 w-full">
      {tryPrettyJson(data)}
    </pre>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground w-24 shrink-0">{label}</span>
      <span className="text-sm break-words min-w-0">{value ?? "—"}</span>
    </div>
  );
}

export const LogDetailModal = memo(function LogDetailModal({ logId, initialTab = "general", onClose }: LogDetailModalProps) {
  const [activeTab, setActiveTab] = useState<string>(initialTab);

  const { data: log, isLoading } = useQuery({
    queryKey: ["log-detail", logId],
    queryFn: () => api.logs.get(logId!),
    enabled: logId !== null,
  });

  // Reset tab when a new log is opened
  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
    else setActiveTab(initialTab);
  };

  return (
    <Dialog open={logId !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
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
          <Tabs value={activeTab} onValueChange={setActiveTab}>
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
                        <span className="font-mono text-muted-foreground">{String(v)}</span>
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
              <div className="flex flex-col gap-1">
                <InfoRow label="Content-Type" value={log.contentType} />
                <InfoRow label="Size" value={formatBytes(log.responseSize)} />
              </div>
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2">
                  Response Body
                  {log.responseBody && log.responseBody.length >= 2048 && (
                    <span className="ml-2 text-yellow-600 dark:text-yellow-400">(truncated to 2KB)</span>
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
});
```

**Step 2: Run full test suite**

Run: `bun test 2>&1 | tail -5`
Expected: All pass

**Step 3: Commit**

```bash
git add frontend/src/components/log-detail-modal.tsx
git commit -m "feat: log modal — initialTab prop, controlled tabs for direct tab navigation"
```

---

### Task 9: Visual verification with Playwright

**Step 1: Open the app in Playwright**

```bash
# Make sure the dev server is running:
# Terminal 1: cd /home/paul/Documentos/proyectos/a11y-crawler-v2 && bun run src/server/index.ts
# Terminal 2: cd frontend && bun run dev
```

Navigate to `http://localhost:5173/logs` and verify:
- [ ] `/api/logs` requests are NOT visible in the table
- [ ] Method chips filter correctly and show active colors
- [ ] "Filters" button appears; clicking it reveals Params/Req body/Res body inputs
- [ ] A blue dot appears on "Filters" button when any advanced filter is active
- [ ] Icon columns (Braces, ArrowUpFromLine, ArrowDownToLine) appear at the end of rows
- [ ] Rows with no query params show `—` in P column
- [ ] Clicking a Braces icon opens the modal on the Request tab
- [ ] Clicking an ArrowDownToLine icon opens the modal on the Response tab
- [ ] Clicking a row opens the modal on the General tab
- [ ] Duration shows amber for 500-999ms, red for 1000ms+
- [ ] Refresh button spins while loading

**Step 2: Final test run**

Run: `bun test 2>&1 | tail -5`
Expected: All pass, 0 fail

**Step 3: Final commit if any fix needed, then done**
