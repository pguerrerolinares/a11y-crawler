# Report Generation with Typst — Design Spec

**Date:** 2026-03-23
**Status:** Draft
**Replaces:** `src/reporter/pdf.ts` (Playwright HTML-to-PDF)

## Problem

The current PDF report is a basic summary: score, stats, sample of 10 pages / 5 issues each. Professional accessibility audits (like Auditoría manual de referencia's 33-page report for Cliente Anónimo) include executive summaries, WCAG compliance tables, findings grouped by thematic category with detailed remediation guidance, and formal conclusions. The scanner detects everything Auditoría manual de referencia reports (and more), but the output doesn't reflect that depth.

## Goals

1. Generate professional, multi-section PDF reports comparable to manual audit deliverables
2. Support two detail levels: `standard` (consolidated findings) and `full` (every instance)
3. Use Typst instead of Playwright for PDF generation (~6x less RAM, ~3-5x faster, no Browserless contention)
4. Store report-relevant metadata in the DB at insert time, not at report generation time
5. Generate on demand (no pre-generated files on disk)

## Non-Goals

- Multi-language support (English only; i18n deferred to backlog)
- Custom branding/logo (generic professional layout)
- LLM-generated remediation text (use existing `help` + `suggestedFix`)
- PDF caching on disk
- Screenshot evidence embedded in PDF

## Architecture

```
GET /api/audits/:id/export/pdf?detail=standard|full
    │
    ▼
┌─────────────────────────────────┐
│  1. Data Collector              │
│     buildReportData(auditId,    │  Direct DB queries — no complex
│       detail) → ReportData      │  transformations, data is already
│                                 │  stored in report-ready format
└──────────────┬──────────────────┘
               │ JSON (~5-30MB)
               ▼
┌─────────────────────────────────┐
│  2. Typst Renderer              │
│     renderPdf(data) → Buffer    │  Write JSON to /tmp, run
│                                 │  Bun.$`typst compile`, return
│     ~200ms-2s, ~25-50MB RAM     │  buffer, clean up
└──────────────┬──────────────────┘
               │ PDF (~1-5MB)
               ▼
┌─────────────────────────────────┐
│  3. API Response                │
│     Content-Type: application/  │  Stream directly, no disk
│     pdf + Content-Disposition   │  persistence
└─────────────────────────────────┘
```

## DB Schema Changes

### Table `issues` — new column

| Column | Type | Constraint | Description |
|---|---|---|---|
| `report_category` | TEXT | NOT NULL | Thematic category for report grouping |

Valid values:
- `keyboard-navigation` — WCAG 2.1.1, 2.1.2, 2.1.4
- `focus-management` — WCAG 2.4.3, 2.4.7, 2.4.11
- `page-structure` — WCAG 1.3.1 (structure), 2.4.1, 2.4.6, 2.4.10
- `content-sequence` — WCAG 1.3.2
- `forms-labels` — WCAG 1.3.1 (forms), 3.3.1, 3.3.2, 4.1.2
- `color-contrast` — WCAG 1.4.1, 1.4.3, 1.4.6, 1.4.11
- `visual-presentation` — WCAG 1.4.4, 1.4.10, 1.4.12, 1.4.13
- `aria-semantics` — WCAG 4.1.1, 4.1.2, 4.1.3
- `media-alternatives` — WCAG 1.1.1, 1.2.x
- `interactive-widgets` — WCAG 2.5.x

### Table `issues` — existing column change

| Column | Change | Description |
|---|---|---|
| `wcag_criterion` | nullable → NOT NULL | Always computed at insert time via `extractWcagCriterion` |

### Migration

Single migration that:
1. Adds `report_category` column with default `'uncategorized'`
2. Backfills `report_category` from the `RULE_CATEGORY` dictionary
3. Backfills null `wcag_criterion` values using `extractWcagCriterion` logic
4. Alters `wcag_criterion` to NOT NULL

Existing audit data can be truncated if backfill is complex — the project is in active development with no production data constraints.

## New Files

### `src/reporter/wcag-metadata.ts`

Static dictionaries:

```typescript
// Rule → report category mapping (~60 entries)
export const RULE_CATEGORY: Record<string, string> = {
  "keyboard": "keyboard-navigation",
  "tabindex": "keyboard-navigation",
  "color-contrast": "color-contrast",
  "label": "forms-labels",
  "aria-required-attr": "aria-semantics",
  // ... all axe-core rules + custom tests
};

// WCAG criterion → human name + conformance level (~50 entries)
export const CRITERION_META: Record<string, { name: string; level: "A" | "AA" | "AAA" }> = {
  "1.1.1": { name: "Non-text Content", level: "A" },
  "1.3.1": { name: "Info and Relationships", level: "A" },
  "1.4.3": { name: "Contrast (Minimum)", level: "AA" },
  "2.1.1": { name: "Keyboard", level: "A" },
  // ... all WCAG 2.2 criteria
};

// Report category → human name + description
export const CATEGORY_META: Record<string, { name: string; description: string }> = {
  "keyboard-navigation": {
    name: "Keyboard Navigation",
    description: "All functionality must be operable through a keyboard interface.",
  },
  // ...
};
```

Used by:
- **Worker** at issue insert time → compute `report_category`, ensure `wcag_criterion`
- **Report data collector** → enrich findings with `criterion_name`, `conformance_level` from `CRITERION_META`

### `src/reporter/report-data.ts`

Queries the DB and assembles `ReportData`:

```typescript
export interface ReportData {
  meta: {
    baseUrl: string;
    date: string;
    wcagLevel: "A" | "AA" | "AAA";
    toolVersions: { crawler: string; axeCore: string };
    totalDurationSeconds: number;
    detailLevel: "standard" | "full";
  };

  score: {
    value: number | null;
    totalIssues: number;
    totalPages: number;
    issuesByImpact: Record<ImpactLevel, number>;
  };

  // Compliance status per WCAG criterion.
  // Built by enumerating ALL criteria from CRITERION_META, then LEFT JOINing
  // with issues. Criteria with 0 issues → status "pass". This ensures the
  // table shows both pass and fail like Auditoría manual de referencia's format.
  complianceTable: Array<{
    criterion: string;        // "1.4.3"
    name: string;             // from CRITERION_META
    level: "A" | "AA" | "AAA"; // from CRITERION_META
    status: "pass" | "fail";
    issueCount: number;       // 0 for pass
  }>;

  // Findings grouped by thematic category
  categories: Array<{
    name: string;             // "Keyboard Navigation"
    description: string;
    findings: Array<{
      criterion: string;
      controlName: string;    // from CRITERION_META[criterion].name
      level: "A" | "AA" | "AAA"; // from CRITERION_META[criterion].level
      status: "fail";
      requirement: string;    // static text from CRITERION_META (future)
      finding: string;        // consolidated: use the most common description
                              // among issues for this criterion, plus
                              // "Affects N pages" summary line
      remediation: string;    // first non-null suggestedFix, falling back to
                              // help text from axe-core
      affectedPages: string[];
      issueCount: number;
      // Only when detail=full:
      instances?: Array<{
        page: string;
        selector: string;
        html: string;
        description: string;
      }>;
    }>;
  }>;

  analyzedUrls: Array<{
    url: string;
    issueCount: number;
  }>;
}
```

Key queries:

```sql
-- Compliance table: query failed criteria, then merge with full CRITERION_META
-- in TypeScript to produce pass/fail for all criteria
SELECT wcag_criterion, COUNT(*) as issue_count
FROM issues WHERE audit_id = $1
GROUP BY wcag_criterion

-- Findings grouped by category
SELECT report_category, wcag_criterion, rule, impact,
       description, help, suggested_fix, p.url, i.selector, i.html
FROM issues i JOIN pages p ON i.page_id = p.id
WHERE i.audit_id = $1
ORDER BY report_category, wcag_criterion, impact DESC

-- Analyzed URLs
SELECT p.url, COUNT(i.id) as issue_count
FROM pages p LEFT JOIN issues i ON i.page_id = p.id
WHERE p.audit_id = $1
GROUP BY p.url ORDER BY issue_count DESC
```

The data collector groups the flat query results into the nested `ReportData` structure in TypeScript — simple `reduce`/`Map` operations.

### `src/reporter/typst-renderer.ts`

Orchestrates Typst compilation:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_CONCURRENT = 2;
let active = 0;
const queue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return; }
  return new Promise(resolve => queue.push(resolve));
}

function releaseSlot(): void {
  active--;
  const next = queue.shift();
  if (next) { active++; next(); }
}

export async function renderPdf(data: ReportData): Promise<Buffer> {
  await acquireSlot();
  const tmpDir = await mkdtemp(join(tmpdir(), "report-"));
  try {
    const jsonPath = join(tmpDir, "data.json");
    const outputPath = join(tmpDir, "report.pdf");
    const templateDir = join(import.meta.dir, "../../templates/report");

    await Bun.write(jsonPath, JSON.stringify(data));

    // datafile path passed via --input (sys.inputs), which bypasses --root
    // restrictions. If this causes issues, copy templates to tmpDir instead.
    const result = await Bun.$`typst compile
      --root ${templateDir}
      --input datafile=${jsonPath}
      ${join(templateDir, "main.typ")}
      ${outputPath}`.quiet();

    if (result.exitCode !== 0) {
      throw new Error(`Typst failed: ${result.stderr.toString()}`);
    }

    return Buffer.from(await Bun.file(outputPath).arrayBuffer());
  } finally {
    releaseSlot();
    await rm(tmpDir, { recursive: true, force: true });
  }
}
```

Concurrency semaphore limits to 2 simultaneous compilations (~100MB peak combined).

### Typst Templates

```
templates/report/
  main.typ           ← entry point: imports data, controls detail level, includes sections
  theme.typ          ← page setup, colors, fonts, header/footer, table styles
  cover.typ          ← cover page (title, URL, date, WCAG level)
  summary.typ        ← executive summary: score, impact stats, compliance table, methodology
  findings.typ       ← findings by thematic category (the bulk of the report)
  conclusions.typ    ← conclusions + analyzed URLs list
  fonts/
    inter.ttf        ← bundled font for consistent rendering across environments
```

**`main.typ` structure:**

```typst
#import "theme.typ": *
#let data = json(sys.inputs.datafile)
#let detail = data.meta.detailLevel

// Cover page
#include "cover.typ"

// Table of contents
#outline(indent: auto)
#pagebreak()

// Executive summary + methodology + compliance table
#include "summary.typ"

// Findings by category (always included)
#include "findings.typ"

// Conclusions + analyzed URLs
#include "conclusions.typ"
```

For `detail = "full"`, `findings.typ` includes instance tables below each finding.

**Finding block format** (mirrors Auditoría manual de referencia structure):

Each finding renders as a table block:

| Row | Content |
|---|---|
| Header row | WCAG criterion + Control name + Conformance level + FAIL status |
| Requirement | What the criterion requires (static text) |
| Finding | Consolidated description + affected pages count |
| Remediation | help text + suggestedFix if available |
| Instances (full only) | Table of selector, HTML snippet, page URL |

## Modified Files

### `src/server/routes/export.ts`

- `exportPdf()` rewritten: calls `buildReportData()` + `renderPdf()` instead of reading file from disk
- Adds `detail` query parameter validation (`standard` | `full`, default `standard`)
- Timeout: 30s for the entire operation
- Filename: `audit-{id-short}-{date}-{detail}.pdf`

### Worker (issue insertion)

Where issues are inserted into the DB, add:
- `report_category` computed from `RULE_CATEGORY[rule]` (fallback: `'uncategorized'`)
- Ensure `wcag_criterion` is always populated (already mostly done, enforce NOT NULL)

## Deleted Files

- `src/reporter/pdf.ts` — replaced entirely by Typst pipeline

## Resource Profile

| Metric | Current (Playwright) | New (Typst) |
|---|---|---|
| RAM peak | ~300MB (Chromium) | ~25-50MB |
| Generation time | ~3-5s | ~0.2-2s |
| Browserless contention | Yes | None |
| Disk usage | Pre-generated PDF stored | None (on demand) |
| Max concurrent | Limited by Browserless slots | 2 (semaphore) |

## Typst Installation

**Development:**
```bash
# macOS
brew install typst
# Linux
curl -fsSL https://github.com/typst/typst/releases/latest/download/typst-x86_64-unknown-linux-musl.tar.xz \
  | tar -xJ --strip-components=1 -C /usr/local/bin/
```

**Docker (Coolify):**
```dockerfile
ADD https://github.com/typst/typst/releases/latest/download/typst-x86_64-unknown-linux-musl.tar.xz /tmp/typst.tar.xz
RUN tar -xJf /tmp/typst.tar.xz --strip-components=1 -C /usr/local/bin/ && rm /tmp/typst.tar.xz
```

~40MB static binary, no runtime dependencies. Font bundled in `templates/report/fonts/`.

## Detail Levels

| Section | `standard` | `full` |
|---|---|---|
| Cover page | Yes | Yes |
| Table of contents | Yes | Yes |
| Executive summary (score, stats) | Yes | Yes |
| Methodology & tools | Yes | Yes |
| Compliance table (pass/fail per criterion) | Yes | Yes |
| Findings by category (consolidated) | Yes | Yes |
| Instance details (selector, HTML, page) | No | Yes |
| Analyzed URLs | Yes | Yes |
| Conclusions | Yes | Yes |

## Future Enhancements (Backlog)

- **i18n:** Extract static texts to locale files, add `?lang=es|en` parameter
- **LLM remediation:** Generate contextual remediation text per criterion using LLM
- **Custom branding:** Logo upload, color scheme configuration
- **PDF caching:** Store generated PDFs with cache key `auditId+detail+schemaVersion`
- **`summary` detail level:** If there's demand for a 2-3 page executive-only PDF
- **Screenshot evidence:** Embed CVD comparison screenshots in findings
