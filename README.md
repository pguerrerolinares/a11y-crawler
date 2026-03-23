# a11y-crawler-v2

Accessibility crawler and auditor that scans websites for WCAG 2.2 AA compliance using a multi-tier probe architecture with LLM-augmented analysis.

## Architecture

Two-process system deployed via Docker (Coolify):

- **API Server** (`src/server/`) — REST API + SSE progress notifications (Bun.serve)
- **Worker** (`src/worker/`) — Audit pipeline: Discover → Scan → Classify → Probe (4-tier)
- **Frontend** (`frontend/`) — React dashboard (Vite, shadcn/ui, TanStack Query)
- **Browserless** — Self-hosted Chromium sidecar for Playwright

### Worker Pipeline

```
DISCOVER → SCAN (3 concurrent) → CLASSIFY → PROBE (4-phase per template)
                                                ├─ Phase 1: Static (Tier 1 CSSOM + axe + evaluate tests)
                                                ├─ Phase 2: Interaction (Tier 2 hover/focus/keyboard)
                                                ├─ Phase 3: Viewport (reflow, resize, text-spacing)
                                                └─ Phase 4: Capture (CVD screenshots + LLM vision + Tier 3 queue)
```

### Source Layout

```
src/
├── analyzer/        # WCAG test implementations (wcag-*.ts) + utilities
│   └── screenshot-cvd.ts  # Reusable pixel diff, CVD simulation, CSS fingerprint
├── crawler/         # URL discovery, queue, sitemap, safety
├── discovery/       # LLM-powered SPA navigation discovery
├── llm/             # OpenAI-compatible LLM client (Moonshot AI)
├── reporter/        # JSON/PDF report generation, WCAG scoring
├── repr/            # Page representation (ARIA snapshot, pruned HTML, heuristic)
├── server/          # API server, routes, middleware, DB client
├── types/           # Shared TypeScript type definitions
└── worker/          # Pipeline orchestration, probe, scan, tiers, DB access
    ├── db.ts            # Connection init + migrations
    ├── db-audit.ts      # Audit lifecycle (claim, mark, events)
    ├── db-pages.ts      # Page/issue persistence, spans, regression
    └── db-tier3.ts      # Async LLM job queue + cache
```

## Setup

```bash
bun install
```

## Run

```bash
# API server
bun run server

# Worker
bun run src/worker/index.ts

# Frontend (separate dir)
cd frontend && bun run dev
```

## Test

```bash
bun test
```

## Tech Stack

- **Runtime:** Bun
- **Browser automation:** Playwright + Browserless
- **Accessibility engine:** axe-core
- **LLM:** Moonshot AI (kimi-k2-turbo for text, moonshot-v1-32k-vision-preview for screenshots)
- **Database:** PostgreSQL
- **Frontend:** React, Vite, shadcn/ui, Tailwind, TanStack Query
- **Image processing:** sharp, pixelmatch
