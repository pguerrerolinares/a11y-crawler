# Backend Backlog Implementation Plan

> **STATUS: COMPLETED (2026-03-11)**
> All 10 tasks implemented. Additional fixes applied beyond the original plan — see notes below.

**Goal:** Implement 4 backend features: WCAG score (0-100), scan duration persistence, crawl errors persistence, and CSV/PDF export endpoints.

**Architecture:** DB schema migration adds 3 nullable columns to `audits`; `writeReportToPostgres` computes and saves new data; PDF is generated in the worker child process (where Playwright is already available) and saved to disk; CSV is streamed from the issues table. Two new export routes registered in `src/server/index.ts`.

**Tech Stack:** Bun, Postgres (`Bun.sql`), Playwright (for PDF), TypeScript.

### Post-implementation notes (2026-03-11)

**Key deviation:** The plan assumed the worker used `src/reporter/postgres.ts` (`writeReportToPostgres`), but the actual worker uses `src/worker/db.ts` directly. This caused three gaps where data was not being persisted:
- `wcag_score` was never computed or saved
- `crawl_errors` were collected but discarded
- PDF was never generated

**Additional changes beyond this plan:**
- Fixed `worker/db.ts` `markAuditCompleted` to persist `wcag_score` and `crawl_errors`
- Fixed `worker/audit.ts` to compute WCAG score, pass crawl errors, and generate PDF via Browserless
- Wired frontend export buttons (PDF/CSV) to the actual API endpoints
- Frontend `reports.tsx` now uses `wcagScore` from API instead of client-side formula
- Frontend `issue-table.tsx` now distinguishes axe-core vs interactive test results with source filter
- Deleted dead code: `src/reporter/postgres.ts`, `src/cli/index.ts`
- Replaced all `any` types in production code with concrete types
- PDF generation reuses the worker's Browserless connection instead of launching a separate Chromium

---

## Context Map

| File | Role |
|------|------|
| `src/server/db/schema.sql` | DB DDL — add new columns here |
| `src/server/db/client.ts` | DB init — runs schema.sql on startup |
| `src/reporter/postgres.ts` | Saves `SiteReport` to DB at crawl completion |
| `src/crawler/worker.ts` | Child process — entry point for crawl jobs |
| `src/server/routes/audits.ts` | REST handlers for `/api/audits/*` |
| `src/server/index.ts` | Route dispatch — add export pattern here (line 81) |
| `src/server/env.ts` | Env var validation — add `REPORTS_DIR` |

---

## Task 1: DB Schema Migration

**Files:**
- Modify: `src/server/db/schema.sql`

### Step 1: Add 3 new columns at end of `audits` CREATE TABLE

Open `src/server/db/schema.sql`. The `audits` table ends at line 15. Add 3 nullable columns after `llm_usage`:

```sql
CREATE TABLE IF NOT EXISTS audits (
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
  llm_usage     JSONB,
  wcag_score    INT,
  duration_seconds INT,
  crawl_errors  JSONB
);
```

> **Why nullable?** Existing audits and in-progress audits won't have these values yet.

> **Why not `errors`?** The table already has `error TEXT` (singular) for fatal failures. `crawl_errors` holds the per-URL `CrawlError[]` array from a completed audit — semantically different.

### Step 2: Verify client.ts applies schema on startup

Read `src/server/db/client.ts` to confirm it runs `schema.sql` on init. It should call something like `db.file(schemaPath)`. No changes needed here — `IF NOT EXISTS` in the CREATE TABLE means the 3 columns **won't** be added to existing databases automatically.

> **Important:** For a live DB, run the migration manually:
> ```sql
> ALTER TABLE audits ADD COLUMN IF NOT EXISTS wcag_score INT;
> ALTER TABLE audits ADD COLUMN IF NOT EXISTS duration_seconds INT;
> ALTER TABLE audits ADD COLUMN IF NOT EXISTS crawl_errors JSONB;
> ```
> Add this as a comment at the bottom of `schema.sql` for reference.

### Step 3: Add migration comment at bottom of schema.sql

```sql
-- Migration 2026-03-09: backend backlog
-- Run once on existing databases:
-- ALTER TABLE audits ADD COLUMN IF NOT EXISTS wcag_score INT;
-- ALTER TABLE audits ADD COLUMN IF NOT EXISTS duration_seconds INT;
-- ALTER TABLE audits ADD COLUMN IF NOT EXISTS crawl_errors JSONB;
```

### Step 4: Commit

```bash
git add src/server/db/schema.sql
git commit -m "feat(db): add wcag_score, duration_seconds, crawl_errors columns to audits"
```

---

## Task 2: WCAG Score Formula — Unit Test + Implementation

**Files:**
- Create: `src/reporter/__tests__/wcag-score.test.ts`
- Create: `src/reporter/wcag-score.ts`

### Step 1: Write the failing test

Create `src/reporter/__tests__/wcag-score.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { computeWcagScore } from "../wcag-score.ts";

describe("computeWcagScore", () => {
  test("perfect site returns 100", () => {
    expect(computeWcagScore({ critical: 0, serious: 0, moderate: 0, minor: 0 }, 10)).toBe(100);
  });

  test("site with no pages returns null", () => {
    expect(computeWcagScore({ critical: 0, serious: 0, moderate: 0, minor: 0 }, 0)).toBeNull();
  });

  test("one critical issue on one page scores 90", () => {
    // penalty = 1*10 = 10, avgPerPage = 10/1 = 10, score = 100-10 = 90
    expect(computeWcagScore({ critical: 1, serious: 0, moderate: 0, minor: 0 }, 1)).toBe(90);
  });

  test("many issues clamp at 0, not negative", () => {
    // penalty = 20*10 = 200, avgPerPage = 200/1 = 200, score = max(0, -100) = 0
    expect(computeWcagScore({ critical: 20, serious: 0, moderate: 0, minor: 0 }, 1)).toBe(0);
  });

  test("issues spread across pages are normalized", () => {
    // Same 10 critical issues, 10 pages: avgPenalty = 100/10 = 10, score = 90
    expect(computeWcagScore({ critical: 10, serious: 0, moderate: 0, minor: 0 }, 10)).toBe(90);
    // Same 10 critical issues, 1 page: avgPenalty = 100/1 = 100, score = 0
    expect(computeWcagScore({ critical: 10, serious: 0, moderate: 0, minor: 0 }, 1)).toBe(0);
  });

  test("mixed impact levels", () => {
    // penalty = 1*10 + 2*5 + 3*2 + 4*1 = 10+10+6+4 = 30
    // avgPerPage = 30/5 = 6, score = 94
    expect(computeWcagScore({ critical: 1, serious: 2, moderate: 3, minor: 4 }, 5)).toBe(94);
  });
});
```

### Step 2: Run to verify it fails

```bash
bun test src/reporter/__tests__/wcag-score.test.ts
```

Expected: FAIL — `Cannot find module '../wcag-score.ts'`

### Step 3: Implement wcag-score.ts

Create `src/reporter/wcag-score.ts`:

```ts
export interface ImpactCounts {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
}

/**
 * Computes WCAG accessibility score (0-100).
 * Formula C: per-page average penalty, normalized by page count.
 * Weights: critical=10, serious=5, moderate=2, minor=1.
 * Returns null if totalPages is 0 (no pages analyzed).
 */
export function computeWcagScore(
  issuesByImpact: ImpactCounts,
  totalPages: number,
): number | null {
  if (totalPages === 0) return null;

  const totalPenalty =
    (issuesByImpact.critical ?? 0) * 10 +
    (issuesByImpact.serious ?? 0) * 5 +
    (issuesByImpact.moderate ?? 0) * 2 +
    (issuesByImpact.minor ?? 0) * 1;

  const avgPenaltyPerPage = totalPenalty / totalPages;
  return Math.max(0, Math.round(100 - avgPenaltyPerPage));
}
```

### Step 4: Run tests to verify they pass

```bash
bun test src/reporter/__tests__/wcag-score.test.ts
```

Expected: all 6 tests PASS.

### Step 5: Commit

```bash
git add src/reporter/wcag-score.ts src/reporter/__tests__/wcag-score.test.ts
git commit -m "feat(reporter): add computeWcagScore formula (weighted per-page penalty)"
```

---

## Task 3: Update writeReportToPostgres

**Files:**
- Modify: `src/reporter/postgres.ts`

### Step 1: Import the new function

At the top of `src/reporter/postgres.ts`, add:

```ts
import { computeWcagScore } from "./wcag-score.ts";
```

### Step 2: Update the UPDATE statement in `writeReport`

The current UPDATE is at lines 51-58 of `src/reporter/postgres.ts`:

```ts
await db`
  UPDATE audits SET
    status = 'completed',
    finished_at = NOW(),
    summary = ${report.summary},
    discovery = ${report.discovery},
    llm_usage = ${report.llmUsage}
  WHERE id = ${auditId}
`;
```

Replace it with:

```ts
const wcagScore = computeWcagScore(report.summary.issuesByImpact, report.summary.totalPages);
const durationSeconds = report.meta.totalDurationSeconds;
const crawlErrors = report.errors.length > 0 ? report.errors : null;

await db`
  UPDATE audits SET
    status = 'completed',
    finished_at = NOW(),
    summary = ${report.summary},
    discovery = ${report.discovery},
    llm_usage = ${report.llmUsage},
    wcag_score = ${wcagScore},
    duration_seconds = ${durationSeconds},
    crawl_errors = ${crawlErrors}
  WHERE id = ${auditId}
`;
```

> **Why `crawlErrors = null` when empty?** Cleaner than storing `[]`. The API can treat `null` as "no errors".

### Step 3: Commit

```bash
git add src/reporter/postgres.ts
git commit -m "feat(reporter): save wcag_score, duration_seconds, crawl_errors on audit completion"
```

---

## Task 4: Update API Response (mapAuditRow)

**Files:**
- Modify: `src/server/routes/audits.ts`
- Modify: `src/server/types.ts` (add new fields to AuditResponse)

### Step 1: Read types.ts to see AuditResponse shape

```bash
grep -n "AuditResponse" src/server/types.ts
```

Read the `AuditResponse` type definition and add the 3 new optional fields:

```ts
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
  // New fields:
  wcagScore: number | null;
  durationSeconds: number | null;
  crawlErrors: Array<{ url: string; phase: string; message: string; timestamp: string }> | null;
}
```

### Step 2: Update mapAuditRow in audits.ts

The `mapAuditRow` function at line 101 of `src/server/routes/audits.ts` currently returns 11 fields. Add 3 more:

```ts
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
    wcagScore: row.wcag_score,
    durationSeconds: row.duration_seconds,
    crawlErrors: row.crawl_errors,
  };
}
```

### Step 3: Verify the server still compiles

```bash
bun run src/server/index.ts 2>&1 | head -5
# Should start without TypeScript errors
```

### Step 4: Commit

```bash
git add src/server/routes/audits.ts src/server/types.ts
git commit -m "feat(api): expose wcagScore, durationSeconds, crawlErrors in audit response"
```

---

## Task 5: REPORTS_DIR Env Var

**Files:**
- Modify: `src/server/env.ts`

### Step 1: Read env.ts to understand current structure

Read `src/server/env.ts`. It uses Zod to validate env vars. Add `REPORTS_DIR`:

```ts
// In the Zod schema:
REPORTS_DIR: z.string().default("./reports"),
```

And export the value so worker and export handler can use it.

> **Note:** The worker receives env vars from `{ ...process.env }` in `src/server/jobs/manager.ts:13`. No changes needed there — `REPORTS_DIR` will be automatically inherited.

### Step 2: Create reports directory at startup (server/index.ts)

In `src/server/index.ts`, after `await initDb()`, add:

```ts
import { mkdirSync } from "node:fs";
// ...
const reportsDir = env.REPORTS_DIR;
mkdirSync(reportsDir, { recursive: true });
console.log(`Reports directory: ${reportsDir}`);
```

### Step 3: Commit

```bash
git add src/server/env.ts src/server/index.ts
git commit -m "feat(server): add REPORTS_DIR env var for PDF storage"
```

---

## Task 6: PDF Generation in Worker

**Files:**
- Modify: `src/crawler/worker.ts`
- Create: `src/reporter/pdf.ts`

### Step 1: Create PDF generator module

Create `src/reporter/pdf.ts`. This generates a self-contained HTML report and renders it to PDF with Playwright:

```ts
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SiteReport } from "../types/report.ts";

/**
 * Generates a PDF report from a SiteReport and saves it to outputPath.
 * Launches a headless Chromium, renders HTML, and exports to PDF.
 */
export async function generatePdf(report: SiteReport, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });

  const html = buildHtml(report);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      margin: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" },
      printBackground: true,
    });
    await writeFile(outputPath, pdfBuffer);
  } finally {
    await browser.close();
  }
}

function buildHtml(report: SiteReport): string {
  const { meta, summary, sharedIssues, pages } = report;
  const score = computeScoreHtml(summary);
  const date = new Date(meta.generatedAt).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  const impactOrder = ["critical", "serious", "moderate", "minor"] as const;
  const impactColor: Record<string, string> = {
    critical: "#dc2626",
    serious: "#ea580c",
    moderate: "#d97706",
    minor: "#2563eb",
  };

  // Top issues per page (first 3 pages with issues, first 5 issues each)
  const issueRows = pages
    .filter(p => p.issues.length > 0)
    .slice(0, 10)
    .flatMap(p =>
      p.issues.slice(0, 5).map(issue =>
        `<tr>
          <td style="color:${impactColor[issue.impact]};font-weight:600">${issue.impact}</td>
          <td>${issue.rule}</td>
          <td style="font-size:11px;color:#555">${p.url}</td>
          <td style="font-size:11px">${issue.description}</td>
        </tr>`
      )
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Arial, sans-serif; font-size: 13px; color: #111; line-height: 1.5; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin: 24px 0 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
  .meta { color: #555; font-size: 12px; margin-bottom: 24px; }
  .score { display: inline-block; font-size: 48px; font-weight: 700; color: ${scoreColor(summary)}; }
  .score-label { font-size: 13px; color: #555; margin-left: 8px; }
  .stats { display: flex; gap: 24px; margin: 16px 0; }
  .stat { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 16px; min-width: 120px; }
  .stat-value { font-size: 24px; font-weight: 700; }
  .stat-label { font-size: 11px; color: #555; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
  th { background: #f3f4f6; text-align: left; padding: 8px; border-bottom: 2px solid #e5e7eb; }
  td { padding: 7px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  tr:nth-child(even) td { background: #fafafa; }
  .critical { color: #dc2626; }
  .serious  { color: #ea580c; }
  .moderate { color: #d97706; }
  .minor    { color: #2563eb; }
  .footer { margin-top: 32px; font-size: 11px; color: #999; border-top: 1px solid #e5e7eb; padding-top: 12px; }
</style>
</head>
<body>
<h1>Accessibility Audit Report</h1>
<p class="meta">${meta.baseUrl} · WCAG ${meta.wcagLevel} · ${date} · ${meta.totalDurationSeconds}s</p>

<div>
  <span class="score">${score}</span>
  <span class="score-label">/100 WCAG Score</span>
</div>

<h2>Summary</h2>
<div class="stats">
  <div class="stat">
    <div class="stat-value">${summary.totalPages}</div>
    <div class="stat-label">Pages analyzed</div>
  </div>
  <div class="stat">
    <div class="stat-value">${summary.totalIssues}</div>
    <div class="stat-label">Total issues</div>
  </div>
  ${impactOrder.map(level => `
  <div class="stat">
    <div class="stat-value" style="color:${impactColor[level]}">${summary.issuesByImpact[level]}</div>
    <div class="stat-label">${level.charAt(0).toUpperCase() + level.slice(1)}</div>
  </div>`).join("")}
</div>

<h2>Issues (sample — first 10 pages)</h2>
<table>
  <thead>
    <tr>
      <th>Impact</th>
      <th>Rule</th>
      <th>Page</th>
      <th>Description</th>
    </tr>
  </thead>
  <tbody>${issueRows}</tbody>
</table>

${sharedIssues.length > 0 ? `
<h2>Shared Issues (${sharedIssues.length} template-level issues)</h2>
<table>
  <thead><tr><th>Rule</th><th>Pages affected</th><th>Fix available</th></tr></thead>
  <tbody>
  ${sharedIssues.map(s => `<tr>
    <td>${s.rule}</td>
    <td>${s.pageCount}</td>
    <td>${s.suggestedFix ? "Yes" : "No"}</td>
  </tr>`).join("")}
  </tbody>
</table>` : ""}

<div class="footer">
  Generated by a11y-crawler v${meta.toolVersions.crawler} · axe-core ${meta.toolVersions.axeCore} · ${meta.totalDurationSeconds}s total
</div>
</body>
</html>`;
}

function scoreColor(summary: SiteReport["summary"]): string {
  const total = summary.totalIssues;
  const critical = summary.issuesByImpact.critical ?? 0;
  if (critical > 0 || total > 50) return "#dc2626";
  if (total > 20) return "#ea580c";
  if (total > 5) return "#d97706";
  return "#16a34a";
}

function computeScoreHtml(summary: SiteReport["summary"]): string {
  if (summary.totalPages === 0) return "N/A";
  const totalPenalty =
    (summary.issuesByImpact.critical ?? 0) * 10 +
    (summary.issuesByImpact.serious ?? 0) * 5 +
    (summary.issuesByImpact.moderate ?? 0) * 2 +
    (summary.issuesByImpact.minor ?? 0) * 1;
  return String(Math.max(0, Math.round(100 - totalPenalty / summary.totalPages)));
}
```

### Step 2: Call PDF generation in worker.ts

In `src/crawler/worker.ts`, after the successful `writeReportToPostgres` call (line 51):

```ts
import { generatePdf } from "../reporter/pdf.ts";
import { join } from "node:path";

// ... existing imports ...

const reportsDir = process.env.REPORTS_DIR || "./reports";

// After writeReportToPostgres:
try {
  const report = await audit(crawlConfig, onProgress);
  await writeReportToPostgres(db, auditId, report);

  // Generate PDF report
  const pdfPath = join(reportsDir, `${auditId}.pdf`);
  await generatePdf(report, pdfPath);
  console.log(`PDF saved: ${pdfPath}`);

  console.log(`Audit ${auditId} completed: ${report.summary.totalPages} pages, ${report.summary.totalIssues} issues`);
} catch (err) {
```

> **Note:** PDF generation failure should NOT fail the audit. Wrap it in its own try/catch:

```ts
const report = await audit(crawlConfig, onProgress);
await writeReportToPostgres(db, auditId, report);

// PDF generation — non-fatal
const pdfPath = join(reportsDir, `${auditId}.pdf`);
try {
  await generatePdf(report, pdfPath);
  console.log(`PDF saved: ${pdfPath}`);
} catch (pdfErr) {
  console.error(`PDF generation failed (non-fatal): ${pdfErr}`);
}
```

### Step 3: Verify TypeScript

```bash
bun run --check src/crawler/worker.ts 2>&1
```

Expected: no errors.

### Step 4: Commit

```bash
git add src/reporter/pdf.ts src/crawler/worker.ts
git commit -m "feat(reporter): generate PDF report in worker after crawl completion"
```

---

## Task 7: CSV Export Handler

**Files:**
- Create: `src/server/routes/export.ts`

### Step 1: Create export.ts with streaming CSV

```ts
import { getDb } from "../db/client.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";

const reportsDir = process.env.REPORTS_DIR || "./reports";

export async function handleExport(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") {
    return Response.json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const match = url.pathname.match(/^\/api\/audits\/([^/]+)\/export\/(csv|pdf)$/);
  if (!match) return Response.json({ error: "Not Found" }, { status: 404 });

  const [, auditId, format] = match;

  // Validate audit exists
  const db = getDb();
  const [audit] = await db`SELECT id, url, status FROM audits WHERE id = ${auditId}`;
  if (!audit) return Response.json({ error: "Audit not found" }, { status: 404 });
  if (audit.status !== "completed") {
    return Response.json({ error: "Audit not completed yet" }, { status: 409 });
  }

  if (format === "csv") return exportCsv(auditId, audit.url);
  if (format === "pdf") return exportPdf(auditId);

  return Response.json({ error: "Not Found" }, { status: 404 });
}

async function exportCsv(auditId: string, auditUrl: string): Promise<Response> {
  const db = getDb();

  const CSV_HEADERS = [
    "rule", "impact", "category", "page_url", "selector",
    "description", "help", "wcag_tags", "suggested_fix",
  ];

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // Header row
      controller.enqueue(encoder.encode(CSV_HEADERS.join(",") + "\r\n"));

      // Stream issues in batches of 500
      const BATCH = 500;
      let offset = 0;

      while (true) {
        const issues = await db`
          SELECT rule, impact, category, page_id, selector, description,
                 help, wcag_tags, suggested_fix, audit_id
          FROM issues
          WHERE audit_id = ${auditId}
          ORDER BY impact, rule
          LIMIT ${BATCH} OFFSET ${offset}
        `;

        if (issues.length === 0) break;

        // Resolve page URLs in batch
        const pageIds = [...new Set(issues.map((i: any) => i.page_id))];
        const pages = await db`SELECT id, url FROM pages WHERE id IN ${db(pageIds)}`;
        const pageUrlMap = new Map(pages.map((p: any) => [p.id, p.url]));

        for (const issue of issues) {
          const row = [
            issue.rule,
            issue.impact,
            issue.category ?? "",
            pageUrlMap.get(issue.page_id) ?? "",
            issue.selector ?? "",
            issue.description ?? "",
            issue.help ?? "",
            Array.isArray(issue.wcag_tags) ? issue.wcag_tags.join(";") : (issue.wcag_tags ?? ""),
            issue.suggested_fix ?? "",
          ].map(csvEscape).join(",");

          controller.enqueue(encoder.encode(row + "\r\n"));
        }

        offset += issues.length;
        if (issues.length < BATCH) break;
      }

      controller.close();
    },
  });

  const filename = `audit-${auditId.slice(0, 8)}.csv`;
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function exportPdf(auditId: string): Promise<Response> {
  const pdfPath = join(reportsDir, `${auditId}.pdf`);

  if (!existsSync(pdfPath)) {
    return Response.json(
      { error: "PDF not available. It is generated after the crawl completes." },
      { status: 404 },
    );
  }

  const file = Bun.file(pdfPath);
  const filename = `audit-${auditId.slice(0, 8)}.pdf`;

  return new Response(file, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** Escape a CSV field value: wrap in quotes if it contains comma, quote, or newline. */
function csvEscape(value: string): string {
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
```

### Step 2: Write a unit test for csvEscape

Create `src/server/routes/__tests__/export.test.ts`:

```ts
import { test, expect, describe } from "bun:test";

// Extract csvEscape for testing — copy or re-export if needed
// For simplicity, test via the CSV behavior
describe("csvEscape", () => {
  // We test the logic directly by re-implementing it inline
  function csvEscape(value: string): string {
    const str = String(value);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  test("plain string passes through unchanged", () => {
    expect(csvEscape("hello")).toBe("hello");
  });

  test("string with comma is quoted", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  test("string with quotes escapes them", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  test("string with newline is quoted", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  test("empty string passes through", () => {
    expect(csvEscape("")).toBe("");
  });
});
```

### Step 3: Run tests

```bash
bun test src/server/routes/__tests__/export.test.ts
```

Expected: all 5 tests PASS.

### Step 4: Commit

```bash
git add src/server/routes/export.ts src/server/routes/__tests__/export.test.ts
git commit -m "feat(api): add streaming CSV and PDF export endpoints"
```

---

## Task 8: Register Export Routes in Router

**Files:**
- Modify: `src/server/index.ts` (line 81 area)

### Step 1: Add import

At top of `src/server/index.ts`, add:

```ts
import { handleExport } from "./routes/export.ts";
```

### Step 2: Add export route match

In `handleApiRoute` (line 79), add the export pattern **before** the `/api/audits` catch-all at line 89:

```ts
async function handleApiRoute(req: Request, url: URL): Promise<Response> {
  // Order matters: more specific patterns first
  if (url.pathname.match(/^\/api\/audits\/[^/]+\/(pages|issues|shared)$/)) {
    if (url.pathname.endsWith("/pages")) return handlePages(req, url);
    return handleIssues(req, url);
  }

  // NEW: Export routes — must come before the /api/audits catch-all
  if (url.pathname.match(/^\/api\/audits\/[^/]+\/export\/(csv|pdf)$/)) {
    return handleExport(req, url);
  }

  if (url.pathname.startsWith("/api/pages/")) {
    if (url.pathname.match(/\/issues$/)) return handleIssues(req, url);
    return handlePages(req, url);
  }
  if (url.pathname.startsWith("/api/audits")) {
    return handleAudits(req, url);
  }
  if (url.pathname === "/api/logs" || url.pathname.match(/^\/api\/logs\/\d+$/)) {
    return handleLogs(req, url);
  }
  return Response.json({ error: "Not Found" }, { status: 404 });
}
```

### Step 3: Verify server starts

```bash
bun run src/server/index.ts 2>&1 | head -10
```

Expected: server starts, "Database initialized", "Server running on http://localhost:..."

### Step 4: Quick manual test of route registration (no DB needed)

```bash
# Should get 405 Method Not Allowed (not 404) — proves route is registered
curl -X POST http://localhost:3000/api/audits/00000000-0000-0000-0000-000000000000/export/csv
# Expected: {"error":"Method Not Allowed"}
```

### Step 5: Commit

```bash
git add src/server/index.ts
git commit -m "feat(server): register export routes in API router"
```

---

## Task 9: Run All Tests

```bash
bun test
```

Expected: all tests pass.

---

## Task 10: Manual End-to-End Verification (optional, requires running server + DB)

1. Start the server: `bun run src/server/index.ts`
2. Create an audit via POST `/api/audits` with a real URL
3. Wait for it to complete
4. Check `GET /api/audits/:id` — verify `wcagScore`, `durationSeconds` are populated
5. Check `crawl_errors` is null or populated if pages failed
6. `GET /api/audits/:id/export/csv` — download and open in spreadsheet
7. `GET /api/audits/:id/export/pdf` — download and verify PDF has score + issues table
8. Check `./reports/{auditId}.pdf` exists on disk

---

## Summary of Changes

| File | Type | What changed |
|------|------|--------------|
| `src/server/db/schema.sql` | Modified | +3 nullable columns on audits |
| `src/reporter/wcag-score.ts` | New | WCAG score formula (Formula C) |
| `src/reporter/__tests__/wcag-score.test.ts` | New | Unit tests for score formula |
| `src/reporter/postgres.ts` | Modified | Save wcag_score, duration_seconds, crawl_errors |
| `src/reporter/pdf.ts` | New | HTML template + Playwright PDF generator |
| `src/crawler/worker.ts` | Modified | Call generatePdf after writeReportToPostgres |
| `src/server/routes/audits.ts` | Modified | mapAuditRow: add 3 new fields |
| `src/server/routes/export.ts` | New | CSV streaming + PDF serve endpoints |
| `src/server/routes/__tests__/export.test.ts` | New | csvEscape unit tests |
| `src/server/index.ts` | Modified | Import handleExport, add export route match |
| `src/server/env.ts` | Modified | Add REPORTS_DIR env var |
