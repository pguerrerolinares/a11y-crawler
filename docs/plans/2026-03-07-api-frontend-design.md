# a11y Crawler — API & Frontend Design

**Date**: 2026-03-07
**Status**: Approved
**Scope**: REST API + WebSocket + React SPA + Coolify deployment

---

## 1. Context

The a11y crawler (v2) is a CLI tool that crawls websites, runs axe-core accessibility analysis, and enriches findings with LLM-generated fix suggestions. It produces JSON reports.

**Next step**: Expose it as an API with a React frontend so the team can launch audits and explore results from the browser.

### Requirements

- **Use case**: Internal team tool (no public auth, no multi-tenant, no billing)
- **Flow**: Launch audits from the UI → see real-time progress → explore results
- **Execution**: Crawler runs as child process inside Docker container
- **Storage**: PostgreSQL (metadata + issues desglosados)
- **Frontend**: React + shadcn/ui + Tailwind CSS + Lucide icons
- **Real-time**: WebSocket for crawl progress
- **Deployment**: Coolify on VPS (4 GB RAM, 2-4 cores), custom domain + SSL

---

## 2. Architecture

```
┌──────────────────────────────────────────────────┐
│          Coolify (VPS)                            │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │  Servicio: a11y-app (Dockerfile)            │  │
│  │                                             │  │
│  │  Bun.serve() — Port 3000                    │  │
│  │  ┌──────────┬──────────┬─────────────────┐  │  │
│  │  │ REST API │    WS    │  Static React   │  │  │
│  │  │ /api/*   │   /ws    │  SPA (dist/)    │  │  │
│  │  └────┬─────┴────┬─────┴─────────────────┘  │  │
│  │       │          │                          │  │
│  │  ┌────┴──────────┴────────────────────────┐ │  │
│  │  │         Job Manager                    │ │  │
│  │  │  - INSERT job → audits table           │ │  │
│  │  │  - Bun.spawn() crawler child process   │ │  │
│  │  │  - LISTEN on Postgres NOTIFY           │ │  │
│  │  │  - Forward events → WebSocket clients  │ │  │
│  │  └───────────────┬────────────────────────┘ │  │
│  │                  │                          │  │
│  │  ┌───────────────┴────────────────────────┐ │  │
│  │  │  Crawler (child process)               │ │  │
│  │  │  bun run src/crawler/worker.ts         │ │  │
│  │  │  - Playwright + axe-core + LLM         │ │  │
│  │  │  - INSERT audit_events → NOTIFY        │ │  │
│  │  │  - INSERT pages, issues on completion  │ │  │
│  │  └────────────────────────────────────────┘ │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │  PostgreSQL (Coolify managed)               │  │
│  │  - audits, pages, issues, shared_issues     │  │
│  │  - audit_events (real-time progress)        │  │
│  │  - request_logs (API traceability)          │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  Traefik (Coolify managed) → SSL + domain         │
└───────────────────────────────────────────────────┘
```

### Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Job queue | Postgres SKIP LOCKED | No extra service. Sufficient for internal use (1-5 crawls/day) |
| Real-time | Postgres LISTEN/NOTIFY → WebSocket | Native to PG, no Redis needed |
| Crawler isolation | Child process (Bun.spawn) | Separate event loop, crash isolation, simple |
| Frontend serving | Static files via Bun.serve() | No separate nginx/CDN needed |
| Deployment | Coolify + Dockerfile | Already available on VPS, handles SSL/domain/restart |

### Resource budget (4 GB RAM VPS)

| Service | RAM | Notes |
|---------|-----|-------|
| Bun API + WS + React | ~50-100 MB | Very light |
| PostgreSQL | ~200-300 MB | Tuned for small VPS |
| Playwright/Chromium (crawler) | ~500-800 MB | Only while crawling |
| **Total** | **~750 MB - 1.2 GB** | ~2.8 GB free for OS + buffer |

---

## 3. Database Schema

```sql
-- Audits (jobs)
CREATE TABLE audits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url           TEXT NOT NULL,
  config        JSONB,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending → running → completed → failed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  error         TEXT,
  summary       JSONB,
  discovery     JSONB,
  llm_usage     JSONB
);

-- Pages analyzed
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

-- Individual issues (violations)
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

-- Shared issues (3+ pages)
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

-- Real-time progress events
CREATE TABLE audit_events (
  id          SERIAL PRIMARY KEY,
  audit_id    UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API request logs (traceability)
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

-- Indexes
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

---

## 4. REST API

```
Base: /api

POST   /api/audits              Launch new audit
  Body: { url, wcagLevel?, maxPages?, maxDepth?, concurrency?, skipSitemap?, noEnrich? }
  → 201 { id, url, status, createdAt }

GET    /api/audits              List audits
  Query: ?status=completed&limit=20&offset=0
  → 200 { data: Audit[], total, limit, offset }

GET    /api/audits/:id          Audit detail
  → 200 { id, url, config, status, summary, discovery, llmUsage, ... }

DELETE /api/audits/:id          Delete audit + cascade
  → 204

GET    /api/audits/:id/pages    Pages of an audit
  Query: ?sort=issues_desc&limit=50
  → 200 { data: Page[], total }

GET    /api/pages/:id           Page detail
  → 200 { id, url, title, issueCount, issuesByImpact }

GET    /api/audits/:id/issues   Issues of an audit
  Query: ?impact=critical,serious&rule=color-contrast&category=visual&limit=50
  → 200 { data: Issue[], total }

GET    /api/pages/:id/issues    Issues of a specific page
  Query: ?impact=critical&limit=50
  → 200 { data: Issue[], total }

GET    /api/audits/:id/shared   Shared issues (3+ pages)
  → 200 { data: SharedIssue[] }

GET    /api/logs                Request logs
  Query: ?path=/api/audits&status=500&from=2026-03-01&limit=100
  → 200 { data: RequestLog[], total }
```

### WebSocket

```
WS /ws/audits/:id

Server → Client events:
  { type: "page_analyzed", data: { url, issueCount, issuesByImpact } }
  { type: "progress", data: { pagesAnalyzed, totalDiscovered, elapsed } }
  { type: "completed", data: { summary } }
  { type: "error", data: { message } }
```

---

## 5. Frontend

### Stack

- React 19 + Vite (or Bun HTML imports)
- Tailwind CSS 4 + shadcn/ui
- Lucide React (icons)
- Framer Motion (animations)
- TanStack Query (fetching, caching, WebSocket sync)
- React Router (SPA routing)

### Design system

Tokens defined as CSS custom properties. Single breakpoint at 640px (mobile-first). Light + dark mode with WCAG AA verified contrast ratios. `prefers-reduced-motion` respected from day 1.

### Routes

```
/                   Dashboard (audit list)
/audits/:id         Audit detail (progress if running, report if completed)
/logs               Request logs
```

### Screens

1. **Dashboard** — Audit list as cards with staggered animation, status badges, quick stats, "New Audit" button, dark mode toggle
2. **New Audit** — Dialog modal with Zod client-side validation, presets (Quick scan / Full audit)
3. **Progress** (when running) — Animated progress bar, real-time event feed via WebSocket, live stats
4. **Report** (when completed) — Tabs: Issues (DataTable + filters), Pages, Shared Issues, Summary
5. **Logs** — DataTable with filters by path, status code, date

### Accessibility

The frontend itself must be accessible:
- `prefers-reduced-motion` respected
- WCAG AA contrast in light and dark mode
- Full keyboard navigation
- Skip links, focus management in modals
- Semantic HTML

---

## 6. Changes to Existing Crawler

Minimal changes to integrate with the API:

| File | Change | Impact |
|------|--------|--------|
| `orchestrator.ts` | Add optional `onProgress` callback | Low |
| `crawler/crawler.ts` | Emit events in requestHandler | Low |
| `reporter/postgres.ts` | **New** — write results to Postgres | New file |
| `crawler/worker.ts` | **New** — child process entry point | New file |
| `cli/index.ts` | No changes | None |

The CLI continues to work as before (JSON output). The API uses a separate code path (Postgres output + progress events).

---

## 7. Project Structure

```
a11y-crawler-v2/
├── src/
│   ├── server/                 # NEW — API + WS
│   │   ├── index.ts            # Bun.serve() entry
│   │   ├── routes/
│   │   │   ├── audits.ts
│   │   │   ├── pages.ts
│   │   │   ├── issues.ts
│   │   │   └── logs.ts
│   │   ├── ws.ts               # WebSocket handler
│   │   ├── middleware/
│   │   │   └── logger.ts       # Request logging
│   │   ├── db/
│   │   │   ├── client.ts       # Bun.sql Postgres client
│   │   │   ├── schema.sql      # DDL
│   │   │   └── migrations/
│   │   └── jobs/
│   │       └── manager.ts      # Job manager (spawn crawler)
│   │
│   ├── crawler/                # EXISTING (minor changes)
│   │   ├── crawler.ts
│   │   ├── worker.ts           # NEW — child process entry
│   │   ├── sitemap.ts
│   │   └── safety.ts
│   │
│   ├── analyzer/               # EXISTING — no changes
│   ├── repr/                   # EXISTING — no changes
│   ├── llm/                    # EXISTING — no changes
│   ├── discovery/              # EXISTING — no changes
│   ├── enrichment/             # EXISTING — no changes
│   ├── reporter/
│   │   ├── json.ts             # EXISTING — kept for CLI
│   │   ├── postgres.ts         # NEW — write to DB
│   │   └── shared.ts           # EXISTING
│   ├── types/                  # EXISTING + new API types
│   ├── cli/                    # EXISTING — no changes
│   ├── orchestrator.ts         # MODIFIED — add onProgress
│   └── index.ts                # EXISTING
│
├── frontend/                   # NEW — React SPA
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── components/
│   │   │   ├── ui/             # shadcn/ui
│   │   │   ├── audit-card.tsx
│   │   │   ├── audit-form.tsx
│   │   │   ├── issue-table.tsx
│   │   │   ├── progress-view.tsx
│   │   │   └── stats-cards.tsx
│   │   ├── pages/
│   │   │   ├── dashboard.tsx
│   │   │   ├── audit-detail.tsx
│   │   │   └── logs.tsx
│   │   ├── hooks/
│   │   │   ├── use-audit.ts
│   │   │   └── use-websocket.ts
│   │   ├── lib/
│   │   │   ├── api.ts
│   │   │   └── utils.ts
│   │   └── styles/
│   │       └── tokens.css
│   ├── index.html
│   └── vite.config.ts
│
├── Dockerfile
├── package.json
└── CLAUDE.md
```

---

## 8. Deployment (Coolify)

1. **PostgreSQL**: Create as Coolify database service
2. **a11y-app**: Create as Docker service from Git repo
   - Build: Dockerfile (multi-stage)
   - Port: 3000
   - Domain: a11y.yourdomain.com
   - Env vars: DATABASE_URL, LLM_API_KEY, LLM_API_BASE_URL
3. Coolify handles: Traefik reverse proxy, SSL via Let's Encrypt, auto-restart, logs

### Dockerfile strategy

Multi-stage: Stage 1 builds frontend (bun build → dist/), Stage 2 installs Playwright + Chromium + production deps, copies source + built frontend. Single container serves everything.

---

## 9. Lessons Applied (from ai-news-platform JOURNEY.md)

| Lesson | Application |
|--------|-------------|
| Design system tokens first | CSS custom properties before any component |
| TanStack Query | Avoid infinite re-render bug from custom hooks |
| Single breakpoint (640px) | Mobile-first, simple responsive |
| `prefers-reduced-motion` | Respected from day 1 |
| Postgres for everything | No Redis/ES extras, LISTEN/NOTIFY for events |
| Request logging with traceability | request_logs table + middleware |
| Zod validation at boundaries | Client-side + server-side validation |
| Child process for heavy work | Avoid monolithic pipeline (469 LOC lesson) |
| Multi-stage Docker builds | Separate build from runtime |
| Env validation at startup | Fail-fast on missing config |
| Coolify deployment | Already proven workflow |
