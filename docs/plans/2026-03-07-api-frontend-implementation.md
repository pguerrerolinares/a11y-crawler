# API & Frontend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose the a11y crawler as a REST API with WebSocket real-time progress, backed by PostgreSQL, with a React + shadcn/ui frontend — deployed via Coolify on a VPS.

**Architecture:** Monolith Bun.serve() serving API routes, WebSocket, and static React SPA. Crawler runs as child process via Bun.spawn(). PostgreSQL stores audits, pages, issues, and events. LISTEN/NOTIFY for real-time progress forwarding.

**Tech Stack:** Bun, PostgreSQL (Bun.sql), React 19, Vite, Tailwind CSS 4, shadcn/ui, Lucide React, Framer Motion, TanStack Query, React Router, Zod, Docker.

**Design doc:** `docs/plans/2026-03-07-api-frontend-design.md`

---

## Phase 1: Database & Server Foundation

### Task 1: PostgreSQL Schema + DB Client

**Files:**
- Create: `src/server/db/schema.sql`
- Create: `src/server/db/client.ts`

**Step 1: Create the schema file**

```sql
-- src/server/db/schema.sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE audits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url           TEXT NOT NULL,
  config        JSONB,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error         TEXT,
  summary       JSONB,
  discovery     JSONB,
  llm_usage     JSONB
);

CREATE TABLE pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id        UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  title           TEXT,
  status_code     INT,
  issue_count     INT DEFAULT 0,
  issues_by_impact JSONB,
  duration_ms     INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE issues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  audit_id        UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  rule            TEXT NOT NULL,
  impact          TEXT NOT NULL,
  description     TEXT,
  help            TEXT,
  help_url        TEXT,
  wcag_tags       TEXT[],
  selector        TEXT,
  html            TEXT,
  xpath           TEXT,
  check_source    TEXT DEFAULT 'axe',
  category        TEXT,
  suggested_fix   TEXT,
  fix_confidence  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE shared_issues (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id        UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  rule            TEXT,
  impact          TEXT,
  normalized_html TEXT,
  page_count      INT,
  page_urls       TEXT[],
  suggested_fix   TEXT,
  category        TEXT
);

CREATE TABLE audit_events (
  id          SERIAL PRIMARY KEY,
  audit_id    UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE request_logs (
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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audits_status ON audits(status);
CREATE INDEX idx_audits_created ON audits(created_at DESC);
CREATE INDEX idx_pages_audit ON pages(audit_id);
CREATE INDEX idx_issues_audit ON issues(audit_id);
CREATE INDEX idx_issues_impact ON issues(audit_id, impact);
CREATE INDEX idx_issues_rule ON issues(audit_id, rule);
CREATE INDEX idx_events_audit ON audit_events(audit_id);
CREATE INDEX idx_logs_created ON request_logs(created_at DESC);
CREATE INDEX idx_logs_path ON request_logs(path);
```

**Step 2: Create DB client**

```typescript
// src/server/db/client.ts
import { SQL } from "bun";

let db: ReturnType<typeof SQL.init> | null = null;

export function getDb() {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    db = new SQL(url);
  }
  return db;
}

export async function initDb() {
  const db = getDb();
  const schema = await Bun.file(
    new URL("./schema.sql", import.meta.url)
  ).text();
  await db.unsafe(schema);
}
```

> **Note on Bun.sql**: Check `node_modules/bun-types/docs/` for latest Bun.sql API. The `SQL` constructor may differ — consult Bun docs via context7 if needed. The key is: tagged template syntax `db\`SELECT ...\`` for parameterized queries.

**Step 3: Run test — verify schema applies cleanly**

Run: `bun run src/server/db/client.ts` (add a quick `initDb().then(() => console.log("OK"))` call temporarily)
Expected: "OK" (requires a running Postgres with DATABASE_URL set)

**Step 4: Commit**

```bash
git add src/server/db/
git commit -m "feat(server): add PostgreSQL schema and DB client"
```

---

### Task 2: Environment Validation

**Files:**
- Create: `src/server/env.ts`

**Step 1: Create env validation with Zod**

```typescript
// src/server/env.ts
import { z } from "zod/v4";

const envSchema = z.object({
  DATABASE_URL: z.url(),
  LLM_API_KEY: z.string().min(1),
  LLM_API_BASE_URL: z.url().default("https://api.moonshot.ai/v1"),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}
```

> **Note on Zod version**: This project uses zod ^4.3.6. Import from `"zod/v4"` if using Zod 4 mini, or `"zod"` if using the full build. Check `node_modules/zod/package.json` to confirm the export map.

**Step 2: Commit**

```bash
git add src/server/env.ts
git commit -m "feat(server): add environment validation with Zod"
```

---

### Task 3: Bun.serve() Entry Point + Request Logger Middleware

**Files:**
- Create: `src/server/index.ts`
- Create: `src/server/middleware/logger.ts`

**Step 1: Create request logger**

```typescript
// src/server/middleware/logger.ts
import { getDb } from "../db/client.ts";

export async function logRequest(req: Request, status: number, durationMs: number, error?: string) {
  const db = getDb();
  const url = new URL(req.url);

  // Don't log WebSocket upgrades or static file requests
  if (!url.pathname.startsWith("/api/")) return;

  let requestBody = null;
  if (req.method === "POST" || req.method === "PUT") {
    try {
      requestBody = await req.clone().json();
    } catch {}
  }

  await db`INSERT INTO request_logs (method, path, status_code, duration_ms, ip, user_agent, request_body, error)
    VALUES (
      ${req.method},
      ${url.pathname},
      ${status},
      ${durationMs},
      ${req.headers.get("x-forwarded-for") || "unknown"},
      ${req.headers.get("user-agent") || ""},
      ${requestBody ? JSON.stringify(requestBody) : null},
      ${error || null}
    )`.catch(console.error); // fire-and-forget, don't block response
}
```

**Step 2: Create server entry point**

```typescript
// src/server/index.ts
import { validateEnv } from "./env.ts";
import { initDb } from "./db/client.ts";
import { logRequest } from "./middleware/logger.ts";

const env = validateEnv();

await initDb();
console.log("Database initialized");

Bun.serve({
  port: env.PORT,

  async fetch(req) {
    const start = Date.now();
    const url = new URL(req.url);

    try {
      // API routes
      if (url.pathname.startsWith("/api/")) {
        const response = await handleApiRoute(req, url);
        logRequest(req, response.status, Date.now() - start);
        return response;
      }

      // Static files (frontend)
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(`${import.meta.dir}/../../dist/frontend${filePath}`);
      if (await file.exists()) {
        return new Response(file);
      }

      // SPA fallback — serve index.html for client-side routing
      const index = Bun.file(`${import.meta.dir}/../../dist/frontend/index.html`);
      if (await index.exists()) {
        return new Response(index, { headers: { "content-type": "text/html" } });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logRequest(req, 500, Date.now() - start, message);
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    }
  },

  websocket: {
    open(ws) {},
    message(ws, message) {},
    close(ws) {},
  },
});

async function handleApiRoute(req: Request, url: URL): Promise<Response> {
  // Placeholder — routes will be added in Task 5
  return Response.json({ error: "Not Found" }, { status: 404 });
}

console.log(`Server running on http://localhost:${env.PORT}`);
```

**Step 3: Add server script to package.json**

Add to scripts: `"server": "bun run src/server/index.ts"`

**Step 4: Test manually**

Run: `DATABASE_URL=postgresql://... bun run src/server/index.ts`
Expected: "Database initialized" + "Server running on http://localhost:3000"
Test: `curl http://localhost:3000/api/test` → `{"error":"Not Found"}`

**Step 5: Commit**

```bash
git add src/server/index.ts src/server/middleware/logger.ts package.json
git commit -m "feat(server): add Bun.serve() entry point with request logging"
```

---

### Task 4: API Types (shared between server and frontend)

**Files:**
- Create: `src/server/types.ts`

**Step 1: Define API request/response types**

```typescript
// src/server/types.ts
import { z } from "zod/v4";

// Request schemas
export const CreateAuditSchema = z.object({
  url: z.url(),
  wcagLevel: z.enum(["A", "AA", "AAA"]).default("AA"),
  maxPages: z.number().int().min(1).max(500).default(100),
  maxDepth: z.number().int().min(1).max(10).default(5),
  concurrency: z.number().int().min(1).max(5).default(2),
  skipSitemap: z.boolean().default(false),
  noEnrich: z.boolean().default(false),
});

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const IssueFilterSchema = PaginationSchema.extend({
  impact: z.string().optional(),    // comma-separated: "critical,serious"
  rule: z.string().optional(),
  category: z.string().optional(),
});

export const LogFilterSchema = PaginationSchema.extend({
  path: z.string().optional(),
  status: z.coerce.number().optional(),
  from: z.string().optional(), // ISO date
});

// Response types
export interface AuditResponse {
  id: string;
  url: string;
  config: Record<string, unknown> | null;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  summary: Record<string, unknown> | null;
  discovery: Record<string, unknown> | null;
  llmUsage: Record<string, unknown> | null;
}

export interface PageResponse {
  id: string;
  auditId: string;
  url: string;
  title: string | null;
  statusCode: number | null;
  issueCount: number;
  issuesByImpact: Record<string, number> | null;
  durationMs: number | null;
  createdAt: string;
}

export interface IssueResponse {
  id: string;
  pageId: string;
  auditId: string;
  rule: string;
  impact: string;
  description: string | null;
  help: string | null;
  helpUrl: string | null;
  wcagTags: string[];
  selector: string | null;
  html: string | null;
  xpath: string | null;
  checkSource: string;
  category: string | null;
  suggestedFix: string | null;
  fixConfidence: string | null;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// WebSocket event types
export interface WsEvent {
  type: "page_analyzed" | "progress" | "completed" | "error";
  data: Record<string, unknown>;
}
```

**Step 2: Commit**

```bash
git add src/server/types.ts
git commit -m "feat(server): add API request/response types with Zod schemas"
```

---

### Task 5: API Routes — Audits CRUD

**Files:**
- Create: `src/server/routes/audits.ts`
- Modify: `src/server/index.ts` — wire routes

**Step 1: Create audits route handler**

```typescript
// src/server/routes/audits.ts
import { getDb } from "../db/client.ts";
import { CreateAuditSchema, PaginationSchema } from "../types.ts";
import type { AuditResponse, PaginatedResponse } from "../types.ts";

export async function handleAudits(req: Request, url: URL): Promise<Response> {
  const method = req.method;
  const pathParts = url.pathname.replace("/api/audits", "").split("/").filter(Boolean);
  // pathParts: [] for /api/audits, ["<id>"] for /api/audits/:id, ["<id>", "pages"|"issues"|"shared"] for nested

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
  // Nested routes handled by other route files
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
  const config = { ...parsed.data };
  const auditUrl = config.url;
  delete (config as any).url;

  const [audit] = await db`
    INSERT INTO audits (url, config) VALUES (${auditUrl}, ${JSON.stringify(config)})
    RETURNING id, url, status, created_at
  `;

  // TODO: Task 8 — trigger job manager to spawn crawler

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
  const status = url.searchParams.get("status");

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
  const result = await db`DELETE FROM audits WHERE id = ${id}`;
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
  };
}
```

**Step 2: Wire routes in server/index.ts**

Update `handleApiRoute` in `src/server/index.ts`:

```typescript
import { handleAudits } from "./routes/audits.ts";

async function handleApiRoute(req: Request, url: URL): Promise<Response> {
  if (url.pathname.startsWith("/api/audits")) {
    return handleAudits(req, url);
  }
  if (url.pathname.startsWith("/api/logs")) {
    // TODO: Task 7
  }
  return Response.json({ error: "Not Found" }, { status: 404 });
}
```

**Step 3: Test manually**

```bash
# Create
curl -X POST http://localhost:3000/api/audits -H "Content-Type: application/json" -d '{"url":"https://example.com"}'
# List
curl http://localhost:3000/api/audits
# Get
curl http://localhost:3000/api/audits/<id>
# Delete
curl -X DELETE http://localhost:3000/api/audits/<id>
```

**Step 4: Commit**

```bash
git add src/server/routes/audits.ts src/server/index.ts
git commit -m "feat(server): add audits CRUD API routes"
```

---

### Task 6: API Routes — Pages, Issues, Shared Issues

**Files:**
- Create: `src/server/routes/pages.ts`
- Create: `src/server/routes/issues.ts`
- Modify: `src/server/index.ts` — wire routes

**Step 1: Create pages route**

```typescript
// src/server/routes/pages.ts
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
```

**Step 2: Create issues route**

```typescript
// src/server/routes/issues.ts
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
    conditions.push(`impact = ANY($${paramIdx})`);
    values.push(impacts);
    paramIdx++;
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
```

**Step 3: Wire routes in server/index.ts**

Update `handleApiRoute`:

```typescript
import { handlePages } from "./routes/pages.ts";
import { handleIssues } from "./routes/issues.ts";

async function handleApiRoute(req: Request, url: URL): Promise<Response> {
  // Order matters: more specific patterns first
  if (url.pathname.match(/^\/api\/audits\/[^/]+\/(pages|issues|shared)$/)) {
    if (url.pathname.endsWith("/pages")) return handlePages(req, url);
    return handleIssues(req, url);
  }
  if (url.pathname.startsWith("/api/pages/")) {
    if (url.pathname.match(/\/issues$/)) return handleIssues(req, url);
    return handlePages(req, url);
  }
  if (url.pathname.startsWith("/api/audits")) {
    return handleAudits(req, url);
  }
  if (url.pathname.startsWith("/api/logs")) {
    // TODO: Task 7
  }
  return Response.json({ error: "Not Found" }, { status: 404 });
}
```

**Step 4: Commit**

```bash
git add src/server/routes/pages.ts src/server/routes/issues.ts src/server/index.ts
git commit -m "feat(server): add pages, issues, and shared issues API routes"
```

---

### Task 7: API Routes — Request Logs

**Files:**
- Create: `src/server/routes/logs.ts`
- Modify: `src/server/index.ts` — wire route

**Step 1: Create logs route**

```typescript
// src/server/routes/logs.ts
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
```

**Step 2: Wire in server/index.ts**

```typescript
import { handleLogs } from "./routes/logs.ts";

// In handleApiRoute:
if (url.pathname === "/api/logs") {
  return handleLogs(req, url);
}
```

**Step 3: Commit**

```bash
git add src/server/routes/logs.ts src/server/index.ts
git commit -m "feat(server): add request logs API route"
```

---

## Phase 2: Crawler Integration

### Task 8: Orchestrator Progress Callback

**Files:**
- Modify: `src/orchestrator.ts` — add `onProgress` callback parameter
- Create: `src/types/events.ts` — define CrawlEvent type

**Step 1: Create event types**

```typescript
// src/types/events.ts
export interface CrawlEvent {
  type: "page_analyzed" | "progress" | "error" | "completed";
  data: Record<string, unknown>;
}

export type ProgressCallback = (event: CrawlEvent) => void | Promise<void>;
```

**Step 2: Modify orchestrator.ts**

Add `onProgress?: ProgressCallback` as second parameter to `audit()`. Emit events:

- After each page is analyzed in the requestHandler callback:
  ```typescript
  onProgress?.({
    type: "page_analyzed",
    data: { url: result.url, issueCount: result.issues.length, title: result.title }
  });
  onProgress?.({
    type: "progress",
    data: { pagesAnalyzed: pages.length, totalDiscovered: discoveredUrls.size, elapsedSeconds: Math.round((Date.now() - startTime) / 1000) }
  });
  ```

- On error:
  ```typescript
  onProgress?.({ type: "error", data: { url: context.request.url, message: msg } });
  ```

- After post-processing (before return):
  ```typescript
  onProgress?.({ type: "completed", data: { totalPages: pages.length, totalIssues: allIssues.length } });
  ```

**Important:** The existing `audit()` function signature changes from `audit(userConfig)` to `audit(userConfig, onProgress?)`. The CLI path doesn't pass `onProgress`, so it still works unchanged.

**Step 3: Verify CLI still works**

Run: `bun run cli -- --help`
Expected: Help text prints normally (no errors from the new optional parameter)

**Step 4: Commit**

```bash
git add src/orchestrator.ts src/types/events.ts
git commit -m "feat(crawler): add onProgress callback to orchestrator"
```

---

### Task 9: Postgres Reporter

**Files:**
- Create: `src/reporter/postgres.ts`

**Step 1: Create Postgres reporter**

This takes a `SiteReport` and an `auditId` and inserts all data into PostgreSQL.

```typescript
// src/reporter/postgres.ts
import type { SiteReport } from "../types/report.ts";
import type { PageResult } from "../types/page.ts";
import type { Issue } from "../types/issue.ts";

/**
 * Write a completed SiteReport to PostgreSQL.
 * Called by the crawler worker after the crawl finishes.
 */
export async function writeReportToPostgres(
  db: any, // Bun.sql instance
  auditId: string,
  report: SiteReport,
): Promise<void> {
  // Insert pages and their issues
  for (const page of report.pages) {
    const issuesByImpact: Record<string, number> = {};
    for (const issue of page.issues) {
      issuesByImpact[issue.impact] = (issuesByImpact[issue.impact] || 0) + 1;
    }

    const [insertedPage] = await db`
      INSERT INTO pages (audit_id, url, title, issue_count, issues_by_impact, duration_ms)
      VALUES (${auditId}, ${page.url}, ${page.title}, ${page.issues.length}, ${JSON.stringify(issuesByImpact)}, ${page.processingMs})
      RETURNING id
    `;

    // Batch insert issues for this page
    if (page.issues.length > 0) {
      for (const issue of page.issues) {
        await db`
          INSERT INTO issues (page_id, audit_id, rule, impact, description, help, help_url, wcag_tags, selector, html, xpath, check_source, category, suggested_fix, fix_confidence)
          VALUES (
            ${insertedPage.id}, ${auditId}, ${issue.rule}, ${issue.impact},
            ${issue.description}, ${issue.help}, ${issue.helpUrl},
            ${issue.wcagTags}, ${issue.selector}, ${issue.html},
            ${issue.xpath}, ${issue.checkSource}, ${issue.violationCategory},
            ${issue.suggestedFix}, ${issue.fixConfidence}
          )
        `;
      }
    }
  }

  // Insert shared issues
  for (const shared of report.sharedIssues) {
    await db`
      INSERT INTO shared_issues (audit_id, rule, impact, normalized_html, page_count, page_urls, suggested_fix)
      VALUES (
        ${auditId}, ${shared.rule}, ${"serious"},
        ${shared.html}, ${shared.pageCount}, ${shared.affectedPages},
        ${shared.suggestedFix}
      )
    `;
  }

  // Update audit with summary, discovery, llm_usage, and mark completed
  await db`
    UPDATE audits SET
      status = 'completed',
      finished_at = NOW(),
      summary = ${JSON.stringify(report.summary)},
      discovery = ${JSON.stringify(report.discovery)},
      llm_usage = ${JSON.stringify(report.llmUsage)}
    WHERE id = ${auditId}
  `;
}
```

> **Note:** Batch inserts could be optimized with `db.unsafe()` and multi-row VALUES if performance becomes an issue. For now, per-issue inserts are fine for internal use (< 500 issues per audit typically).

**Step 2: Commit**

```bash
git add src/reporter/postgres.ts
git commit -m "feat(reporter): add PostgreSQL reporter for writing audit results to DB"
```

---

### Task 10: Crawler Worker (Child Process Entry Point)

**Files:**
- Create: `src/crawler/worker.ts`

**Step 1: Create worker entry point**

This file is spawned as a child process by the job manager. It receives `auditId` and config via CLI args, runs the crawl, writes progress events to Postgres + NOTIFY, and writes final results.

```typescript
// src/crawler/worker.ts
import { SQL } from "bun";
import { audit } from "../orchestrator.ts";
import { writeReportToPostgres } from "../reporter/postgres.ts";
import type { CrawlConfig } from "../types/config.ts";
import type { ProgressCallback } from "../types/events.ts";

const auditId = process.argv[2];
const configJson = process.argv[3];

if (!auditId || !configJson) {
  console.error("Usage: bun run src/crawler/worker.ts <auditId> <configJson>");
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = new SQL(dbUrl);

// Parse config
const rawConfig = JSON.parse(configJson);
const crawlConfig: Partial<CrawlConfig> & { baseUrl: string; apiKey: string } = {
  baseUrl: rawConfig.url,
  apiKey: process.env.LLM_API_KEY || rawConfig.apiKey,
  wcagLevel: rawConfig.wcagLevel || "AA",
  maxPages: rawConfig.maxPages || 100,
  maxDepth: rawConfig.maxDepth || 5,
  concurrency: rawConfig.concurrency || 2,
  skipSitemap: rawConfig.skipSitemap || false,
};

// Mark audit as running
await db`UPDATE audits SET status = 'running', started_at = NOW() WHERE id = ${auditId}`;

// Progress callback — write events to Postgres and NOTIFY
const onProgress: ProgressCallback = async (event) => {
  await db`
    INSERT INTO audit_events (audit_id, event_type, data)
    VALUES (${auditId}, ${event.type}, ${JSON.stringify(event.data)})
  `;
  await db.unsafe(`NOTIFY audit_progress, '${auditId}'`);
};

try {
  const report = await audit(crawlConfig, onProgress);
  await writeReportToPostgres(db, auditId, report);
  console.log(`Audit ${auditId} completed: ${report.summary.totalPages} pages, ${report.summary.totalIssues} issues`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await db`UPDATE audits SET status = 'failed', finished_at = NOW(), error = ${message} WHERE id = ${auditId}`;
  console.error(`Audit ${auditId} failed: ${message}`);
  process.exit(1);
} finally {
  // Ensure the process exits cleanly
  process.exit(0);
}
```

**Step 2: Commit**

```bash
git add src/crawler/worker.ts
git commit -m "feat(crawler): add worker.ts child process entry point"
```

---

### Task 11: Job Manager

**Files:**
- Create: `src/server/jobs/manager.ts`
- Modify: `src/server/routes/audits.ts` — call job manager on POST

**Step 1: Create job manager**

```typescript
// src/server/jobs/manager.ts
import { getDb } from "../db/client.ts";

const activeJobs = new Map<string, { proc: ReturnType<typeof Bun.spawn> }>();

export function startCrawl(auditId: string, url: string, config: Record<string, unknown>) {
  const fullConfig = { ...config, url };

  const proc = Bun.spawn([
    "bun", "run", `${import.meta.dir}/../../crawler/worker.ts`,
    auditId,
    JSON.stringify(fullConfig),
  ], {
    env: { ...process.env },
    stdout: "inherit",
    stderr: "inherit",
  });

  activeJobs.set(auditId, { proc });

  proc.exited.then(async (code) => {
    activeJobs.delete(auditId);
    if (code !== 0) {
      const db = getDb();
      // Only update if not already updated by worker
      await db`
        UPDATE audits SET status = 'failed', finished_at = NOW(),
        error = COALESCE(error, ${'Process exited with code ' + code})
        WHERE id = ${auditId} AND status = 'running'
      `.catch(console.error);
    }
  });
}

export function getActiveJobs(): string[] {
  return [...activeJobs.keys()];
}
```

**Step 2: Wire into audits route**

In `src/server/routes/audits.ts`, after the INSERT in `createAudit`:

```typescript
import { startCrawl } from "../jobs/manager.ts";

// After INSERT RETURNING...
startCrawl(audit.id, auditUrl, config);
```

**Step 3: Test end-to-end**

```bash
# Start server
DATABASE_URL=... LLM_API_KEY=... bun run src/server/index.ts
# Create audit
curl -X POST http://localhost:3000/api/audits -H "Content-Type: application/json" -d '{"url":"https://example.com","maxPages":2}'
# Watch server logs for crawler output
# Check audit status
curl http://localhost:3000/api/audits/<id>
```

**Step 4: Commit**

```bash
git add src/server/jobs/manager.ts src/server/routes/audits.ts
git commit -m "feat(server): add job manager to spawn crawler child processes"
```

---

### Task 12: WebSocket — Real-Time Progress

**Files:**
- Create: `src/server/ws.ts`
- Modify: `src/server/index.ts` — wire WebSocket

**Step 1: Create WebSocket handler**

```typescript
// src/server/ws.ts
import type { ServerWebSocket } from "bun";
import { getDb } from "./db/client.ts";

interface WsData {
  auditId: string;
}

// Track connected clients per audit
const clients = new Map<string, Set<ServerWebSocket<WsData>>>();

export function handleWsUpgrade(req: Request, server: any): Response | undefined {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/ws\/audits\/([^/]+)$/);
  if (!match) return undefined;

  const auditId = match[1];
  const success = server.upgrade<WsData>(req, { data: { auditId } });
  if (success) return undefined; // Bun handles the upgrade
  return new Response("WebSocket upgrade failed", { status: 400 });
}

export function wsOpen(ws: ServerWebSocket<WsData>) {
  const { auditId } = ws.data;
  if (!clients.has(auditId)) clients.set(auditId, new Set());
  clients.get(auditId)!.add(ws);
}

export function wsClose(ws: ServerWebSocket<WsData>) {
  const { auditId } = ws.data;
  clients.get(auditId)?.delete(ws);
  if (clients.get(auditId)?.size === 0) clients.delete(auditId);
}

export function wsMessage(ws: ServerWebSocket<WsData>, message: string | Buffer) {
  // Client-to-server messages not needed for now
}

/**
 * Broadcast an event to all WebSocket clients subscribed to an audit.
 */
export function broadcastToAudit(auditId: string, event: { type: string; data: unknown }) {
  const subs = clients.get(auditId);
  if (!subs || subs.size === 0) return;
  const msg = JSON.stringify(event);
  for (const ws of subs) {
    ws.send(msg);
  }
}

/**
 * Start listening for Postgres NOTIFY events and forward to WebSocket clients.
 * Call this once on server startup.
 */
export async function startNotifyListener() {
  const db = getDb();
  // Use a dedicated connection for LISTEN
  await db.unsafe("LISTEN audit_progress");

  // Poll for notifications — Bun.sql may handle this differently.
  // Check Bun docs for notification API. Fallback: poll audit_events table.
  // This is implementation-dependent on Bun.sql's LISTEN support.
  //
  // Fallback approach: poll audit_events every 500ms for active audits
  setInterval(async () => {
    for (const auditId of clients.keys()) {
      try {
        const events = await db`
          SELECT * FROM audit_events
          WHERE audit_id = ${auditId}
          ORDER BY id DESC LIMIT 1
        `;
        if (events.length > 0) {
          broadcastToAudit(auditId, {
            type: events[0].event_type,
            data: events[0].data,
          });
        }
      } catch {}
    }
  }, 1000);
}
```

> **Implementation note on LISTEN/NOTIFY:** Bun.sql's LISTEN support may vary. The fallback polling approach (checking audit_events every 1s) is reliable and sufficient for internal use. If Bun.sql supports `db.listen()` or similar, replace the polling with native LISTEN. Check Bun docs at implementation time.

**Step 2: Wire WebSocket into server/index.ts**

```typescript
import { handleWsUpgrade, wsOpen, wsClose, wsMessage, startNotifyListener } from "./ws.ts";

// Before Bun.serve():
await startNotifyListener();

// In Bun.serve():
Bun.serve({
  // ...
  fetch(req, server) {
    // WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname.startsWith("/ws/")) {
      const upgraded = handleWsUpgrade(req, server);
      if (upgraded !== undefined) return upgraded;
      return; // upgrade handled
    }
    // ... rest of fetch handler
  },
  websocket: {
    open: wsOpen,
    close: wsClose,
    message: wsMessage,
  },
});
```

**Step 3: Test with wscat or browser console**

```bash
# Install wscat
bunx wscat -c ws://localhost:3000/ws/audits/<running-audit-id>
# Should receive events as the crawl progresses
```

**Step 4: Commit**

```bash
git add src/server/ws.ts src/server/index.ts
git commit -m "feat(server): add WebSocket handler for real-time audit progress"
```

---

## Phase 3: Frontend

### Task 13: Frontend Scaffold — Vite + React + Tailwind + shadcn/ui

**Files:**
- Create: `frontend/` directory with Vite React project

**Step 1: Scaffold Vite project**

```bash
cd /home/paul/Documentos/proyectos/a11y-crawler-v2
bunx create-vite frontend --template react-ts
cd frontend
bun install
```

**Step 2: Install dependencies**

```bash
cd frontend
bun add tailwindcss @tailwindcss/vite
bun add lucide-react framer-motion @tanstack/react-query react-router-dom
bun add -d @types/react @types/react-dom
```

**Step 3: Configure Tailwind**

Add Tailwind plugin to `frontend/vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
});
```

**Step 4: Add Tailwind import to main CSS**

Replace contents of `frontend/src/index.css`:

```css
@import "tailwindcss";
```

**Step 5: Initialize shadcn/ui**

```bash
cd frontend
bunx shadcn@latest init
# Select: New York style, Zinc color, CSS variables: yes
```

**Step 6: Add required shadcn components**

```bash
cd frontend
bunx shadcn@latest add button card badge dialog tabs table input select progress
```

**Step 7: Verify it builds**

```bash
cd frontend
bun run build
# Should output to ../dist/frontend/
```

**Step 8: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): scaffold Vite + React + Tailwind + shadcn/ui"
```

---

### Task 14: Design System Tokens + Dark Mode

**Files:**
- Create: `frontend/src/styles/tokens.css`
- Modify: `frontend/src/index.css` — import tokens

**Step 1: Create design tokens**

```css
/* frontend/src/styles/tokens.css */
:root {
  /* Impact colors */
  --color-critical: #dc2626;
  --color-serious: #ea580c;
  --color-moderate: #ca8a04;
  --color-minor: #2563eb;
  --color-success: #16a34a;

  /* Status colors */
  --color-pending: #6b7280;
  --color-running: #2563eb;
  --color-completed: #16a34a;
  --color-failed: #dc2626;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

**Step 2: Import in index.css**

```css
@import "tailwindcss";
@import "./styles/tokens.css";
```

**Step 3: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/src/index.css
git commit -m "feat(frontend): add design system tokens and reduced-motion support"
```

---

### Task 15: API Client + TanStack Query Setup

**Files:**
- Create: `frontend/src/lib/api.ts`
- Create: `frontend/src/lib/query.ts`
- Modify: `frontend/src/main.tsx` — wrap with QueryClientProvider

**Step 1: Create API client**

```typescript
// frontend/src/lib/api.ts
const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Audits
export const api = {
  audits: {
    list: (params?: string) => request<any>(`/audits${params ? `?${params}` : ""}`),
    get: (id: string) => request<any>(`/audits/${id}`),
    create: (body: any) => request<any>("/audits", { method: "POST", body: JSON.stringify(body) }),
    delete: (id: string) => request<void>(`/audits/${id}`, { method: "DELETE" }),
  },
  pages: {
    list: (auditId: string, params?: string) => request<any>(`/audits/${auditId}/pages${params ? `?${params}` : ""}`),
    get: (id: string) => request<any>(`/pages/${id}`),
  },
  issues: {
    byAudit: (auditId: string, params?: string) => request<any>(`/audits/${auditId}/issues${params ? `?${params}` : ""}`),
    byPage: (pageId: string, params?: string) => request<any>(`/pages/${pageId}/issues${params ? `?${params}` : ""}`),
    shared: (auditId: string) => request<any>(`/audits/${auditId}/shared`),
  },
  logs: {
    list: (params?: string) => request<any>(`/logs${params ? `?${params}` : ""}`),
  },
};
```

**Step 2: Create TanStack Query setup**

```typescript
// frontend/src/lib/query.ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});
```

**Step 3: Wrap main.tsx with providers**

```tsx
// frontend/src/main.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { queryClient } from "./lib/query";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
```

**Step 4: Commit**

```bash
git add frontend/src/lib/ frontend/src/main.tsx
git commit -m "feat(frontend): add API client and TanStack Query setup"
```

---

### Task 16: WebSocket Hook

**Files:**
- Create: `frontend/src/hooks/use-websocket.ts`

**Step 1: Create useAuditWebSocket hook**

```typescript
// frontend/src/hooks/use-websocket.ts
import { useEffect, useRef, useCallback, useState } from "react";

interface WsEvent {
  type: "page_analyzed" | "progress" | "completed" | "error";
  data: Record<string, any>;
}

export function useAuditWebSocket(auditId: string | undefined, enabled: boolean) {
  const wsRef = useRef<WebSocket | null>(null);
  const [events, setEvents] = useState<WsEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!auditId || !enabled) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/audits/${auditId}`);
    wsRef.current = ws;

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onmessage = (evt) => {
      try {
        const event: WsEvent = JSON.parse(evt.data);
        setEvents((prev) => [...prev, event]);
      } catch {}
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [auditId, enabled]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, isConnected, clearEvents };
}
```

**Step 2: Commit**

```bash
git add frontend/src/hooks/use-websocket.ts
git commit -m "feat(frontend): add useAuditWebSocket hook"
```

---

### Task 17: App Shell + Routing

**Files:**
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/pages/dashboard.tsx` (placeholder)
- Create: `frontend/src/pages/audit-detail.tsx` (placeholder)
- Create: `frontend/src/pages/logs.tsx` (placeholder)
- Create: `frontend/src/components/layout.tsx`

**Step 1: Create layout component**

```tsx
// frontend/src/components/layout.tsx
import { Link, useLocation } from "react-router-dom";
import { Shield, ScrollText } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="container mx-auto flex h-14 items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <Shield className="h-5 w-5" />
            <span>a11y Crawler</span>
          </Link>
          <nav className="flex items-center gap-4">
            <Link
              to="/"
              className={`text-sm ${location.pathname === "/" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              Audits
            </Link>
            <Link
              to="/logs"
              className={`text-sm flex items-center gap-1 ${location.pathname === "/logs" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <ScrollText className="h-4 w-4" />
              Logs
            </Link>
          </nav>
        </div>
      </header>
      <main className="container mx-auto px-4 py-6">
        {children}
      </main>
    </div>
  );
}
```

**Step 2: Create placeholder pages**

```tsx
// frontend/src/pages/dashboard.tsx
export default function Dashboard() {
  return <div>Dashboard — TODO</div>;
}

// frontend/src/pages/audit-detail.tsx
export default function AuditDetail() {
  return <div>Audit Detail — TODO</div>;
}

// frontend/src/pages/logs.tsx
export default function Logs() {
  return <div>Logs — TODO</div>;
}
```

**Step 3: Set up App.tsx routing**

```tsx
// frontend/src/App.tsx
import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/layout";
import Dashboard from "./pages/dashboard";
import AuditDetail from "./pages/audit-detail";
import Logs from "./pages/logs";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/audits/:id" element={<AuditDetail />} />
        <Route path="/logs" element={<Logs />} />
      </Routes>
    </Layout>
  );
}
```

**Step 4: Verify — `cd frontend && bun run dev`**

Expected: App loads at localhost:5173 with header nav and placeholder pages.

**Step 5: Commit**

```bash
git add frontend/src/
git commit -m "feat(frontend): add app shell, layout, routing, and placeholder pages"
```

---

### Task 18: Dashboard Page — Audit List + New Audit Dialog

**Files:**
- Modify: `frontend/src/pages/dashboard.tsx`
- Create: `frontend/src/components/audit-card.tsx`
- Create: `frontend/src/components/audit-form.tsx`

**Step 1: Create audit card component**

Displays one audit with status badge, URL, issue count, impact breakdown. Uses shadcn Card + Badge. Links to `/audits/:id`. Status badge colors: pending=gray, running=blue (with pulse animation), completed=green, failed=red.

**Step 2: Create audit form dialog**

Dialog modal with form fields: URL (required), WCAG Level (select: A/AA/AAA), Max Pages, Max Depth, Concurrency. Zod client-side validation matching `CreateAuditSchema`. Two preset buttons: "Quick Scan" (10 pages, AA, depth 3) and "Full Audit" (100 pages, AAA, depth 5). Submit calls `api.audits.create()` then invalidates the audit list query and navigates to the new audit.

**Step 3: Implement dashboard**

Uses `useQuery` to fetch audit list. Renders audit cards with staggered Framer Motion animation. "New Audit" button opens the dialog. Empty state when no audits.

**Step 4: Verify — create an audit from the UI**

Expected: Dialog opens, form validates, audit created, card appears in list with "pending" status.

**Step 5: Commit**

```bash
git add frontend/src/pages/dashboard.tsx frontend/src/components/audit-card.tsx frontend/src/components/audit-form.tsx
git commit -m "feat(frontend): implement dashboard with audit list and new audit dialog"
```

---

### Task 19: Audit Detail — Progress View (Running)

**Files:**
- Modify: `frontend/src/pages/audit-detail.tsx`
- Create: `frontend/src/components/progress-view.tsx`

**Step 1: Create progress view component**

Shows when audit status is "running". Uses `useAuditWebSocket` hook. Renders:
- Animated progress bar (shadcn Progress + Framer Motion)
- Stats cards: pages analyzed, issues found, elapsed time
- Event feed: latest events scrolling with new entries appearing at top
- Impact breakdown bar updating live

**Step 2: Wire into audit-detail page**

`useQuery` fetches audit by ID (polls every 5s while running). If status is "running", show ProgressView. If "completed", show report (Task 20). If "pending", show waiting state.

**Step 3: Test with a real crawl**

Start a crawl, navigate to the audit detail page, verify WebSocket events appear.

**Step 4: Commit**

```bash
git add frontend/src/pages/audit-detail.tsx frontend/src/components/progress-view.tsx
git commit -m "feat(frontend): implement real-time progress view for running audits"
```

---

### Task 20: Audit Detail — Report View (Completed)

**Files:**
- Modify: `frontend/src/pages/audit-detail.tsx`
- Create: `frontend/src/components/stats-cards.tsx`
- Create: `frontend/src/components/issue-table.tsx`

**Step 1: Create stats cards**

Four cards showing: Total Issues, Critical, Serious, Pages Analyzed. Each with icon (Lucide) and count. Impact cards colored with design tokens.

**Step 2: Create issue table**

Uses shadcn DataTable. Columns: Rule, Impact (badge), Category, Page URL, Suggested Fix (truncated). Filters: impact dropdown, rule search, category dropdown. Pagination. Click row to expand and see full details (HTML snippet, selector, full fix).

**Step 3: Implement tabbed report view**

Tabs (shadcn Tabs): Issues, Pages, Shared Issues, Summary.
- **Issues tab**: Stats cards + issue table with filters
- **Pages tab**: List of pages with issue counts, click to filter issues by page
- **Shared tab**: Cards for shared issues showing rule, page count, affected URLs, fix
- **Summary tab**: Full summary data, discovery stats, LLM usage info

**Step 4: Test with a completed audit**

**Step 5: Commit**

```bash
git add frontend/src/pages/audit-detail.tsx frontend/src/components/stats-cards.tsx frontend/src/components/issue-table.tsx
git commit -m "feat(frontend): implement report view with issue table, stats, and tabs"
```

---

### Task 21: Logs Page

**Files:**
- Modify: `frontend/src/pages/logs.tsx`

**Step 1: Implement logs page**

Uses shadcn DataTable. Columns: Timestamp, Method (badge), Path, Status (colored badge: 2xx green, 4xx yellow, 5xx red), Duration (ms). Filters: path search, status code filter, date range. Pagination. Auto-refresh every 10s.

**Step 2: Commit**

```bash
git add frontend/src/pages/logs.tsx
git commit -m "feat(frontend): implement request logs page"
```

---

### Task 22: Responsive + Polish

**Files:**
- Various frontend components

**Step 1: Mobile responsive pass**

- Header: hamburger menu on mobile (< 640px)
- Dashboard: single column cards on mobile
- Issue table: horizontal scroll on mobile, or card layout
- Dialog: full-screen on mobile
- Stats cards: 2-column grid on mobile, 4-column on desktop

**Step 2: Dark mode toggle**

Add dark mode toggle button in header. Use `class` strategy (add/remove `dark` on `<html>`). Persist preference in localStorage.

**Step 3: Loading states**

Add skeleton loaders (shadcn Skeleton) for all data-fetching views.

**Step 4: Error states**

Add error boundaries and error state components for failed queries.

**Step 5: Commit**

```bash
git add frontend/src/
git commit -m "feat(frontend): add responsive design, dark mode, loading states, error handling"
```

---

## Phase 4: Deployment

### Task 23: Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Step 1: Create .dockerignore**

```
node_modules
dist
storage
.git
.claude
.omc
*.md
```

**Step 2: Create multi-stage Dockerfile**

```dockerfile
# Stage 1: Build frontend
FROM oven/bun:1 AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock* ./
RUN bun install --frozen-lockfile
COPY frontend/ .
RUN bun run build

# Stage 2: Production
FROM oven/bun:1 AS production
WORKDIR /app

# Install Playwright + Chromium
RUN bunx playwright install --with-deps chromium

# Install production dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/

# Copy built frontend
COPY --from=frontend-build /app/dist/frontend/ dist/frontend/

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/server/index.ts"]
```

**Step 3: Test Docker build locally**

```bash
docker build -t a11y-app .
docker run -p 3000:3000 -e DATABASE_URL=... -e LLM_API_KEY=... a11y-app
```

**Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat(deploy): add multi-stage Dockerfile for Coolify deployment"
```

---

### Task 24: Coolify Deployment

**Files:** None (Coolify panel configuration)

**Step 1: Create PostgreSQL service in Coolify**

- Go to Coolify panel → New Resource → Database → PostgreSQL
- Note the internal connection URL (e.g., `postgresql://postgres:pass@postgres-xxx:5432/a11y`)

**Step 2: Create application service in Coolify**

- New Resource → Application → Docker (from Git repository)
- Repository: point to your Git repo
- Branch: master
- Build pack: Dockerfile
- Port: 3000
- Domain: a11y.yourdomain.com
- Environment variables:
  - `DATABASE_URL` = the PostgreSQL internal URL from step 1
  - `LLM_API_KEY` = your Moonshot API key
  - `LLM_API_BASE_URL` = https://api.moonshot.ai/v1

**Step 3: Deploy and verify**

- Push to master → Coolify auto-deploys
- Visit https://a11y.yourdomain.com
- Create an audit from the UI
- Verify the crawl runs and results appear

**Step 4: Commit any Coolify-related config changes**

```bash
git add -A
git commit -m "chore(deploy): finalize Coolify deployment configuration"
```

---

## Phase 5: Testing & Verification

### Task 25: API Integration Tests

**Files:**
- Create: `src/server/__tests__/api.test.ts`

**Step 1: Write integration tests**

Test all API endpoints against a real (or test) PostgreSQL database:
- POST /api/audits — creates audit, returns 201
- GET /api/audits — lists audits with pagination
- GET /api/audits/:id — returns audit detail
- DELETE /api/audits/:id — deletes audit, returns 204
- GET /api/audits/:id/pages — returns pages
- GET /api/audits/:id/issues — returns issues with filters
- GET /api/audits/:id/shared — returns shared issues
- GET /api/logs — returns request logs
- Validation: POST with invalid URL returns 400
- Not found: GET with bogus ID returns 404

Use `bun test` with `beforeAll` to initialize DB and `afterAll` to clean up.

**Step 2: Run tests**

Run: `DATABASE_URL=... bun test src/server/__tests__/api.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/server/__tests__/
git commit -m "test(server): add API integration tests"
```

---

### Task 26: End-to-End Smoke Test

**Step 1: Manual smoke test checklist**

Run through this on the deployed app:

- [ ] Dashboard loads, shows empty state
- [ ] "New Audit" dialog opens, form validates
- [ ] Create audit with a small site (2-3 pages)
- [ ] Audit appears in list with "running" status
- [ ] Click audit → progress view shows live events
- [ ] After completion → report view shows issues, pages, shared issues, summary
- [ ] Issue table filters work (impact, rule, category)
- [ ] Pages tab shows page list
- [ ] Delete audit works
- [ ] Logs page shows request history
- [ ] Mobile responsive: check on phone or dev tools
- [ ] Dark mode toggle works
- [ ] CLI still works: `bun run cli -- --url https://example.com --api-key ...`

**Step 2: Fix any issues found**

**Step 3: Final commit**

```bash
git add -A
git commit -m "fix: address issues found in end-to-end smoke test"
```

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| **1. Foundation** | 1-7 | DB schema, env validation, Bun.serve(), all API routes |
| **2. Crawler** | 8-12 | Progress callback, Postgres reporter, worker, job manager, WebSocket |
| **3. Frontend** | 13-22 | Scaffold, design tokens, API client, pages, components, responsive |
| **4. Deployment** | 23-24 | Dockerfile, Coolify setup |
| **5. Testing** | 25-26 | API tests, E2E smoke test |

**Total: 26 tasks across 5 phases.**
