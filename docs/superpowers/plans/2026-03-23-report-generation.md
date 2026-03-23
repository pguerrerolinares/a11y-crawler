# Report Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the basic Playwright PDF with professional Typst-based accessibility audit reports.

**Architecture:** Data Collector queries PostgreSQL → serializes to JSON → Typst compiles templates into PDF. On-demand generation via API endpoint. Two detail levels (standard/full). New `report_category` and NOT NULL `wcag_criterion` columns on issues table.

**Tech Stack:** Typst (PDF compilation), Bun (runtime), PostgreSQL (data), existing axe-core/Playwright (unchanged)

**Spec:** `docs/superpowers/specs/2026-03-23-report-generation-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/reporter/wcag-metadata.ts` | Create | Static dictionaries: RULE_CATEGORY, CRITERION_META, CATEGORY_META |
| `src/reporter/__tests__/wcag-metadata.test.ts` | Create | Tests for metadata lookups |
| `src/reporter/report-data.ts` | Create | buildReportData(): DB queries → ReportData |
| `src/reporter/__tests__/report-data.test.ts` | Create | Tests for data assembly logic |
| `src/reporter/typst-renderer.ts` | Create | renderPdf(): JSON → Typst compile → Buffer |
| `src/reporter/__tests__/typst-renderer.test.ts` | Create | Tests for renderer (mock Bun.$) |
| `templates/report/main.typ` | Create | Entry point, includes sections by detail level |
| `templates/report/theme.typ` | Create | Page setup, colors, fonts, headers/footers |
| `templates/report/cover.typ` | Create | Cover page |
| `templates/report/summary.typ` | Create | Executive summary + methodology + compliance table |
| `templates/report/findings.typ` | Create | Findings grouped by thematic category |
| `templates/report/conclusions.typ` | Create | Conclusions + analyzed URLs |
| `templates/report/fonts/` | Create | Bundled Inter font |
| `src/server/routes/export.ts` | Modify | Rewrite exportPdf() for on-demand Typst generation |
| `src/worker/db-pages.ts` | Modify | Add report_category + wcag_criterion to insertIssuesV4 |
| `src/server/db/client.ts` | Modify | Add migration for new columns |
| `src/server/db/schema.sql` | Modify | Add report_category column, wcag_criterion NOT NULL |
| `src/reporter/pdf.ts` | Delete | Replaced by typst-renderer |
| `Dockerfile.api` | Modify | Install Typst binary, copy src/reporter + templates |

---

### Task 1: WCAG Metadata Dictionaries

**Files:**
- Create: `src/reporter/wcag-metadata.ts`
- Create: `src/reporter/__tests__/wcag-metadata.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/reporter/__tests__/wcag-metadata.test.ts
import { test, expect } from "bun:test";
import {
  RULE_CATEGORY, CRITERION_META, CATEGORY_META,
  getCriterionMeta, getReportCategory,
} from "../wcag-metadata";

test("RULE_CATEGORY maps axe-core rules to report categories", () => {
  expect(RULE_CATEGORY["color-contrast"]).toBe("color-contrast");
  expect(RULE_CATEGORY["keyboard"]).toBe("keyboard-navigation");
  expect(RULE_CATEGORY["label"]).toBe("forms-labels");
  expect(RULE_CATEGORY["aria-required-attr"]).toBe("aria-semantics");
});

test("CRITERION_META has name and level for all WCAG 2.2 AA criteria", () => {
  const aa = Object.entries(CRITERION_META).filter(([, v]) => v.level !== "AAA");
  expect(aa.length).toBeGreaterThanOrEqual(38); // WCAG 2.2 A+AA criteria
  expect(CRITERION_META["1.4.3"]).toEqual({ name: "Contrast (Minimum)", level: "AA" });
  expect(CRITERION_META["2.1.1"]).toEqual({ name: "Keyboard", level: "A" });
});

test("CATEGORY_META has human names for all categories", () => {
  const categories = Object.keys(CATEGORY_META);
  expect(categories).toContain("keyboard-navigation");
  expect(categories).toContain("color-contrast");
  expect(categories).toContain("forms-labels");
  expect(CATEGORY_META["keyboard-navigation"].name).toBe("Keyboard Navigation");
});

test("getCriterionMeta returns meta or null for unknown", () => {
  expect(getCriterionMeta("1.4.3")).toEqual({ name: "Contrast (Minimum)", level: "AA" });
  expect(getCriterionMeta("99.99.99")).toBeNull();
});

test("getReportCategory returns category or 'uncategorized'", () => {
  expect(getReportCategory("color-contrast")).toBe("color-contrast");
  expect(getReportCategory("totally-unknown-rule")).toBe("uncategorized");
});

test("all RULE_CATEGORY values are valid CATEGORY_META keys", () => {
  for (const [rule, cat] of Object.entries(RULE_CATEGORY)) {
    expect(CATEGORY_META[cat]).toBeDefined();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/reporter/__tests__/wcag-metadata.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement wcag-metadata.ts**

Create `src/reporter/wcag-metadata.ts` with:
- `RULE_CATEGORY`: map all axe-core rules (~60) + custom test rules to report categories. Source: axe-core rule list from `node_modules/axe-core/lib/rules/` and custom tests in `src/analyzer/`. Each rule maps to one of the 10 categories defined in the spec.
- `CRITERION_META`: all WCAG 2.2 A+AA criteria (~38) with `{ name, level }`. Source: WCAG 2.2 spec. Include AAA criteria that the scanner tests (e.g., 1.4.6).
- `CATEGORY_META`: 10 report categories with `{ name, description }`.
- `getCriterionMeta(criterion: string)`: lookup with null fallback.
- `getReportCategory(rule: string)`: lookup with `'uncategorized'` fallback.

Reference `src/server/utils/wcag.ts` for existing SLUG_TO_CRITERION mappings — reuse those values.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/reporter/__tests__/wcag-metadata.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/reporter/wcag-metadata.ts src/reporter/__tests__/wcag-metadata.test.ts
git commit -m "feat: add WCAG metadata dictionaries for report generation"
```

---

### Task 2: DB Migration — report_category + wcag_criterion NOT NULL

**Files:**
- Modify: `src/server/db/schema.sql`
- Modify: `src/server/db/client.ts` (add migration)
- Modify: `src/worker/db-pages.ts` (add report_category to insertIssuesV4)

- [ ] **Step 1: Add report_category column to schema.sql**

In the `CREATE TABLE issues` block, add after `amplified_from`:
```sql
  report_category TEXT NOT NULL DEFAULT 'uncategorized',
  wcag_criterion  TEXT NOT NULL DEFAULT '',
```

Also add index:
```sql
CREATE INDEX IF NOT EXISTS idx_issues_report_category ON issues(audit_id, report_category);
```

- [ ] **Step 2: Add migration in client.ts**

Add a new migration block `report-columns` in `runMigrations()`.

**Important context:** `wcag_criterion` does NOT exist as a DB column — it is currently computed at query time via `extractWcagCriterion()` in `src/server/utils/wcag.ts`. Both columns are brand new. Since the project is in active development with no production data, the migration truncates existing data to avoid complex backfilling.

```typescript
if (!appliedSet.has("report-columns")) {
  console.log("Running migration: report-columns");
  await conn.begin(async (tx) => {
    // Clean slate — no production data to preserve
    await tx.unsafe(`TRUNCATE audits CASCADE`);
    // Add new columns (fresh table, no backfill needed)
    await tx.unsafe(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS report_category TEXT NOT NULL DEFAULT 'uncategorized'`);
    await tx.unsafe(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS wcag_criterion TEXT NOT NULL DEFAULT ''`);
    // Index for report queries
    await tx.unsafe(`CREATE INDEX IF NOT EXISTS idx_issues_report_category ON issues(audit_id, report_category)`);
    await tx.unsafe(`INSERT INTO migrations (id) VALUES ('report-columns')`);
  });
  console.log("Migration report-columns applied");
}
```

- [ ] **Step 3: Modify insertIssuesV4 to populate new columns**

In `src/worker/db-pages.ts`, make these incremental changes to the existing code:

1. Add imports at the top of the file:
```typescript
import { getReportCategory } from "../reporter/wcag-metadata";
import { extractWcagCriterion } from "../server/utils/wcag";
```

2. Add `wcagCriterion?: string | null;` to the issue parameter type in `insertIssuesV4`.

3. Inside the `for (const i of issues)` loop, before the existing `await db\`INSERT INTO issues ...`, add:
```typescript
const reportCategory = getReportCategory(i.rule);
const wcagCriterion = i.wcagCriterion
  ?? extractWcagCriterion(i.wcagTags, i.rule)
  ?? "";
```

4. In the existing INSERT statement (lines 98-110 of `db-pages.ts`), add two columns:
   - Add `report_category, wcag_criterion` to the column list
   - Add `${reportCategory}, ${wcagCriterion}` to the VALUES

Do NOT rewrite the entire INSERT — only add the two new columns to the existing query.

- [ ] **Step 4: Verify migration runs**

Run the API server briefly to trigger migrations:
```bash
DATABASE_URL=<your-db-url> bun run src/server/index.ts
```
Check logs for "Migration report-columns applied". Then Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/schema.sql src/server/db/client.ts src/worker/db-pages.ts
git commit -m "feat: add report_category column and wcag_criterion NOT NULL migration"
```

---

### Task 3: ReportData Builder

**Files:**
- Create: `src/reporter/report-data.ts`
- Create: `src/reporter/__tests__/report-data.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/reporter/__tests__/report-data.test.ts
import { test, expect, describe } from "bun:test";
import { assembleReportData, buildComplianceTable, groupByCategory } from "../report-data";
import type { ReportData } from "../report-data";

// Test the pure transformation functions (no DB)

describe("buildComplianceTable", () => {
  test("marks criteria with issues as fail, others as pass", () => {
    const issueCounts = new Map([
      ["1.4.3", 5],
      ["2.1.1", 2],
    ]);
    const table = buildComplianceTable(issueCounts);

    const contrast = table.find(r => r.criterion === "1.4.3");
    expect(contrast).toBeDefined();
    expect(contrast!.status).toBe("fail");
    expect(contrast!.issueCount).toBe(5);

    const keyboard = table.find(r => r.criterion === "2.1.1");
    expect(keyboard!.status).toBe("fail");

    // A criterion with no issues should be pass
    const nonText = table.find(r => r.criterion === "1.1.1");
    expect(nonText).toBeDefined();
    expect(nonText!.status).toBe("pass");
    expect(nonText!.issueCount).toBe(0);
  });
});

describe("groupByCategory", () => {
  test("groups issues into categories with consolidated findings", () => {
    const issues = [
      { report_category: "color-contrast", wcag_criterion: "1.4.3",
        rule: "color-contrast", impact: "serious",
        description: "Element has insufficient contrast", help: "Fix contrast",
        suggested_fix: "Change color to #000", url: "https://example.com/",
        selector: ".text", html: "<p class='text'>Hi</p>" },
      { report_category: "color-contrast", wcag_criterion: "1.4.3",
        rule: "color-contrast", impact: "serious",
        description: "Element has insufficient contrast", help: "Fix contrast",
        suggested_fix: null, url: "https://example.com/about",
        selector: ".heading", html: "<h1 class='heading'>About</h1>" },
    ];

    const categories = groupByCategory(issues, "standard");

    expect(categories.length).toBe(1);
    expect(categories[0].name).toBe("Color & Contrast");
    expect(categories[0].findings.length).toBe(1); // consolidated by criterion
    expect(categories[0].findings[0].criterion).toBe("1.4.3");
    expect(categories[0].findings[0].affectedPages).toContain("https://example.com/");
    expect(categories[0].findings[0].issueCount).toBe(2);
    expect(categories[0].findings[0].remediation).toContain("Change color to #000");
  });

  test("full detail includes instances", () => {
    const issues = [
      { report_category: "color-contrast", wcag_criterion: "1.4.3",
        rule: "color-contrast", impact: "serious",
        description: "Insufficient contrast", help: "Fix it",
        suggested_fix: null, url: "https://example.com/",
        selector: ".x", html: "<p>x</p>" },
    ];

    const categories = groupByCategory(issues, "full");
    expect(categories[0].findings[0].instances).toBeDefined();
    expect(categories[0].findings[0].instances!.length).toBe(1);
  });

  test("standard detail omits instances", () => {
    const issues = [
      { report_category: "color-contrast", wcag_criterion: "1.4.3",
        rule: "color-contrast", impact: "serious",
        description: "Insufficient contrast", help: "Fix it",
        suggested_fix: null, url: "https://example.com/",
        selector: ".x", html: "<p>x</p>" },
    ];

    const categories = groupByCategory(issues, "standard");
    expect(categories[0].findings[0].instances).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/reporter/__tests__/report-data.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement report-data.ts**

Create `src/reporter/report-data.ts` with:

1. `ReportData` interface (as in spec)
2. `buildComplianceTable(issueCounts: Map<string, number>)`: iterate `CRITERION_META`, produce pass/fail rows
3. `groupByCategory(issues: IssueRow[], detail: "standard" | "full")`:
   - Group by `report_category`
   - Within each category, group by `wcag_criterion`
   - For each criterion group: consolidate into one finding (most common description, collect unique pages, sum counts, pick first non-null suggestedFix or fall back to help)
   - If `detail === "full"`, include `instances` array
   - Sort categories by `CATEGORY_META` order
4. `buildReportData(auditId: string, detail: "standard" | "full"): Promise<ReportData>`:
   - Query audit meta from `audits` table
   - Query all issues with `JOIN pages` for URL
   - Call `buildComplianceTable()` and `groupByCategory()`
   - Query analyzed URLs with issue counts
   - Assemble and return `ReportData`

Use `getDb()` from `src/server/db/client.ts` for database access.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/reporter/__tests__/report-data.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/reporter/report-data.ts src/reporter/__tests__/report-data.test.ts
git commit -m "feat: add ReportData builder with compliance table and category grouping"
```

---

### Task 4: Typst Templates

**Files:**
- Create: `templates/report/theme.typ`
- Create: `templates/report/cover.typ`
- Create: `templates/report/summary.typ`
- Create: `templates/report/findings.typ`
- Create: `templates/report/conclusions.typ`
- Create: `templates/report/main.typ`

**Prerequisites:** Install Typst locally: `brew install typst` (macOS) or download binary for Linux.

- [ ] **Step 1: Download and bundle Inter font**

```bash
mkdir -p templates/report/fonts
curl -L "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip" -o /tmp/inter.zip
unzip -j /tmp/inter.zip "Inter-4.1/InterVariable.ttf" -d templates/report/fonts/
rm /tmp/inter.zip
```

- [ ] **Step 2: Create theme.typ**

`templates/report/theme.typ` — page setup, colors, header/footer, reusable styles:

```typst
// Font
#let body-font = "Inter"

// Colors
#let primary = rgb("#2563eb")
#let critical-color = rgb("#dc2626")
#let serious-color = rgb("#ea580c")
#let moderate-color = rgb("#d97706")
#let minor-color = rgb("#2563eb")
#let pass-color = rgb("#16a34a")
#let fail-color = rgb("#dc2626")
#let gray-100 = rgb("#f3f4f6")
#let gray-500 = rgb("#6b7280")
#let gray-900 = rgb("#111827")

// Impact color helper
#let impact-color(impact) = {
  if impact == "critical" { critical-color }
  else if impact == "serious" { serious-color }
  else if impact == "moderate" { moderate-color }
  else { minor-color }
}

// Status badge
#let status-badge(status) = {
  let color = if status == "pass" { pass-color } else { fail-color }
  box(fill: color, radius: 3pt, inset: (x: 8pt, y: 3pt),
    text(fill: white, weight: "bold", size: 9pt, upper(status)))
}

// Section heading style
#let section-heading(title) = {
  v(12pt)
  text(fill: primary, size: 16pt, weight: "bold", title)
  v(4pt)
  line(length: 100%, stroke: 0.5pt + gray-100)
  v(8pt)
}
```

- [ ] **Step 3: Create cover.typ**

`templates/report/cover.typ` — clean cover page.

**Important:** Every included `.typ` file must load data independently with `#let data = json(sys.inputs.datafile)` at the top. Typst's `#include` inserts content inline but does NOT share parent variables. Add this line to `cover.typ`, `summary.typ`, `findings.typ`, and `conclusions.typ`.

```typst
#let data = json(sys.inputs.datafile)

#page(header: none, footer: none)[
  #v(1fr)
  #align(center)[
    #text(size: 28pt, weight: "bold", fill: gray-900)[
      Accessibility Audit Report
    ]
    #v(16pt)
    #text(size: 14pt, fill: gray-500)[
      #data.meta.baseUrl
    ]
    #v(8pt)
    #text(size: 12pt, fill: gray-500)[
      WCAG #data.meta.wcagLevel · #data.meta.date
    ]
  ]
  #v(1fr)
  #align(center)[
    #text(size: 10pt, fill: gray-500)[
      Generated by a11y-crawler · #data.meta.toolVersions.crawler
    ]
  ]
]
```

- [ ] **Step 4: Create summary.typ**

`templates/report/summary.typ` — executive summary with score, stats, methodology, compliance table.

Key elements:
- WCAG Score large number with color (green if > 80, orange if > 50, red otherwise)
- Stats grid: total pages, total issues, critical/serious/moderate/minor counts
- Methodology section (static text: axe-core, Playwright, custom interactive tests)
- Normative references (static: WCAG 2.2, Ley 11/2023, RD 193/2023)
- Compliance table: all WCAG criteria with pass/fail status, issue count, level

The compliance table should use Typst's `table()` with header repetition:
```typst
#table(
  columns: (1fr, 3fr, auto, auto, auto),
  table.header[*WCAG*][*Control*][*Level*][*Status*][*Issues*],
  ..data.complianceTable.map(row => (
    row.criterion,
    row.name,
    row.level,
    status-badge(row.status),
    str(row.issueCount),
  )).flatten()
)
```

- [ ] **Step 5: Create findings.typ**

`templates/report/findings.typ` — the bulk of the report. For each category:

1. Category heading + description
2. For each finding within the category, a bordered table block:
   - Header row: WCAG criterion | Control name | Level | FAIL badge
   - Requirement row (static text from a criterion-requirements dictionary)
   - Finding row (consolidated description + "Affects N pages" + page list)
   - Remediation row (help + suggestedFix)
   - Instances sub-table (only if detail == "full")

Use `#for category in data.categories` to iterate.

- [ ] **Step 6: Create conclusions.typ**

`templates/report/conclusions.typ`:
- Summary paragraph (auto-generated from data: N criteria fail, M pass, total issues)
- Analyzed URLs table (URL + issue count)
- Recommendation paragraph (static text about implementing corrective measures)

- [ ] **Step 7: Create main.typ**

`templates/report/main.typ` — assembles everything:

```typst
#import "theme.typ": *

#let data = json(sys.inputs.datafile)

#set document(
  title: "Accessibility Audit Report — " + data.meta.baseUrl,
  author: "a11y-crawler",
)

#set text(font: body-font, size: 10pt, fill: gray-900)
#set page(
  paper: "a4",
  margin: (top: 25mm, bottom: 25mm, left: 20mm, right: 20mm),
  header: context {
    if counter(page).get().first() > 1 [
      #text(size: 8pt, fill: gray-500)[
        Accessibility Audit — #data.meta.baseUrl
        #h(1fr)
        #data.meta.date
      ]
      #line(length: 100%, stroke: 0.5pt + gray-100)
    ]
  },
  footer: context [
    #line(length: 100%, stroke: 0.5pt + gray-100)
    #text(size: 8pt, fill: gray-500)[
      Generated by a11y-crawler #data.meta.toolVersions.crawler
      #h(1fr)
      Page #counter(page).display() of #context counter(page).final().first()
    ]
  ],
)

#include "cover.typ"

#pagebreak()
#outline(title: "Table of Contents", indent: auto)

#pagebreak()
#include "summary.typ"

#pagebreak()
#include "findings.typ"

#pagebreak()
#include "conclusions.typ"
```

- [ ] **Step 8: Test templates with sample data**

Create a minimal `templates/report/sample-data.json` for testing:
```bash
cat > /tmp/sample-report.json << 'EOF'
{
  "meta": {
    "baseUrl": "https://example.com",
    "date": "2026-03-23",
    "wcagLevel": "AA",
    "toolVersions": { "crawler": "2.0.0", "axeCore": "4.10.0" },
    "totalDurationSeconds": 68,
    "detailLevel": "standard"
  },
  "score": { "value": 72, "totalIssues": 45, "totalPages": 10,
    "issuesByImpact": { "critical": 2, "serious": 8, "moderate": 20, "minor": 15 } },
  "complianceTable": [
    { "criterion": "1.4.3", "name": "Contrast (Minimum)", "level": "AA", "status": "fail", "issueCount": 12 },
    { "criterion": "2.1.1", "name": "Keyboard", "level": "A", "status": "fail", "issueCount": 5 },
    { "criterion": "1.1.1", "name": "Non-text Content", "level": "A", "status": "pass", "issueCount": 0 }
  ],
  "categories": [
    {
      "name": "Color & Contrast",
      "description": "Visual presentation must meet minimum contrast requirements.",
      "findings": [{
        "criterion": "1.4.3", "controlName": "Contrast (Minimum)", "level": "AA", "status": "fail",
        "requirement": "Text must have a contrast ratio of at least 4.5:1.",
        "finding": "Insufficient contrast ratio detected on text elements across multiple pages.",
        "remediation": "Ensure text color meets minimum 4.5:1 contrast ratio against background.",
        "affectedPages": ["https://example.com/", "https://example.com/about"],
        "issueCount": 12
      }]
    }
  ],
  "analyzedUrls": [
    { "url": "https://example.com/", "issueCount": 15 },
    { "url": "https://example.com/about", "issueCount": 10 }
  ]
}
EOF

# Copy sample data into template dir so --root covers both
cp /tmp/sample-report.json templates/report/data.json
typst compile --root templates/report --input datafile=data.json templates/report/main.typ /tmp/test-report.pdf
rm templates/report/data.json
```

Open `/tmp/test-report.pdf` and visually verify:
- Cover page renders correctly
- TOC has page numbers
- Headers/footers appear on all pages except cover
- Compliance table has colored pass/fail badges
- Finding blocks have the WCAG criterion table structure

- [ ] **Step 9: Iterate on visual issues**

Fix any rendering problems found in step 8. Common issues:
- Font not loading → check `#set text(font: ...)` path
- Table overflow → adjust column widths
- Page breaks in bad places → add `#pagebreak()` or `block(breakable: false)`

- [ ] **Step 10: Commit**

```bash
git add templates/report/
git commit -m "feat: add Typst report templates (cover, summary, findings, conclusions)"
```

---

### Task 5: Typst Renderer

**Files:**
- Create: `src/reporter/typst-renderer.ts`
- Create: `src/reporter/__tests__/typst-renderer.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/reporter/__tests__/typst-renderer.test.ts
import { test, expect, describe } from "bun:test";
import { renderPdf } from "../typst-renderer";

describe("renderPdf", () => {
  test("produces a valid PDF buffer from sample data", async () => {
    const sampleData = {
      meta: {
        baseUrl: "https://example.com",
        date: "2026-03-23",
        wcagLevel: "AA",
        toolVersions: { crawler: "2.0.0", axeCore: "4.10.0" },
        totalDurationSeconds: 68,
        detailLevel: "standard",
      },
      score: { value: 72, totalIssues: 45, totalPages: 10,
        issuesByImpact: { critical: 2, serious: 8, moderate: 20, minor: 15 } },
      complianceTable: [
        { criterion: "1.4.3", name: "Contrast (Minimum)", level: "AA", status: "fail", issueCount: 12 },
      ],
      categories: [],
      analyzedUrls: [{ url: "https://example.com/", issueCount: 15 }],
    };

    const buffer = await renderPdf(sampleData as any);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    // PDF magic bytes
    expect(buffer.slice(0, 5).toString()).toBe("%PDF-");
  });

  test("rejects if typst is not installed", async () => {
    // This test only validates error handling, skip if typst is installed
    // The main test above validates the happy path
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/reporter/__tests__/typst-renderer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement typst-renderer.ts**

Create `src/reporter/typst-renderer.ts` exactly as specified in the spec:
- `renderPdf(data: ReportData): Promise<Buffer>`
- Concurrency semaphore (MAX_CONCURRENT = 2)
- Write JSON to tmpdir, **copy template files into tmpdir** (so `--root` covers both templates and data), run `Bun.$`typst compile --root ${tmpDir} ...``, read result, clean up
- Alternatively: write JSON directly into the templates directory with a unique name and clean up after. The key constraint is that Typst's `--root` must cover both the template `.typ` files AND the `data.json` file, since `json()` reads relative to `--root`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/reporter/__tests__/typst-renderer.test.ts`
Expected: PASS (requires `typst` to be installed locally)

- [ ] **Step 5: Commit**

```bash
git add src/reporter/typst-renderer.ts src/reporter/__tests__/typst-renderer.test.ts
git commit -m "feat: add Typst PDF renderer with concurrency semaphore"
```

---

### Task 6: API Endpoint — Rewrite exportPdf

**Files:**
- Modify: `src/server/routes/export.ts`
- Delete: `src/reporter/pdf.ts`

- [ ] **Step 1: Modify exportPdf in export.ts**

Replace the current `exportPdf()` function:

```typescript
import { buildReportData } from "../../reporter/report-data";
import { renderPdf } from "../../reporter/typst-renderer";
```

```typescript
async function exportPdf(auditId: string, url: URL): Promise<Response> {
  const detail = (url.searchParams.get("detail") ?? "standard") as "standard" | "full";
  if (!["standard", "full"].includes(detail)) {
    return Response.json({ error: "Invalid detail level. Use 'standard' or 'full'" }, { status: 400 });
  }

  const db = getDb();
  const [audit] = await db`SELECT id, url, status FROM audits WHERE id = ${auditId}`;
  if (!audit) return Response.json({ error: "Audit not found" }, { status: 404 });
  if (audit.status !== "completed" && audit.status !== "completed-base") {
    return Response.json({ error: "Audit not completed yet" }, { status: 409 });
  }

  try {
    const reportData = await buildReportData(auditId, detail);
    const pdfBuffer = await renderPdf(reportData);

    const date = new Date().toISOString().slice(0, 10);
    const filename = `audit-${auditId.slice(0, 8)}-${date}-${detail}.pdf`;

    return new Response(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("PDF generation failed:", err);
    return Response.json({ error: "PDF generation failed" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Update the route matcher in handleExport**

The current regex matches `/api/audits/:id/export/(csv|pdf)`. Update `exportPdf` call to pass the URL for query params:

```typescript
if (format === "pdf") return exportPdf(auditId, url);
```

- [ ] **Step 3: Delete src/reporter/pdf.ts**

```bash
rm src/reporter/pdf.ts
```

Verify no other files import it:
```bash
grep -r "reporter/pdf" src/ --include="*.ts" -l
```

If any files import it (unlikely), update them.

- [ ] **Step 4: Test end-to-end**

Start the server and trigger a PDF export:
```bash
curl -o /tmp/test.pdf "http://localhost:3000/api/audits/<audit-id>/export/pdf?detail=standard"
file /tmp/test.pdf  # Should say: PDF document
```

Also test `detail=full`:
```bash
curl -o /tmp/test-full.pdf "http://localhost:3000/api/audits/<audit-id>/export/pdf?detail=full"
```

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/export.ts
git rm src/reporter/pdf.ts
git commit -m "feat: replace Playwright PDF with on-demand Typst generation"
```

---

### Task 7: Dockerfile — Install Typst in API container

**Files:**
- Modify: `Dockerfile.api`

- [ ] **Step 1: Add Typst binary installation**

After `RUN bun install --frozen-lockfile --production`, add:

```dockerfile
# Install Typst for PDF report generation
ADD https://github.com/typst/typst/releases/latest/download/typst-x86_64-unknown-linux-musl.tar.xz /tmp/typst.tar.xz
RUN tar -xJf /tmp/typst.tar.xz --strip-components=1 -C /usr/local/bin/ && rm /tmp/typst.tar.xz
```

- [ ] **Step 2: Copy reporter and templates**

Update the COPY section to include reporter code and templates:

```dockerfile
COPY src/server/ src/server/
COPY src/types/ src/types/
COPY src/reporter/ src/reporter/
COPY templates/ templates/
```

- [ ] **Step 3: Build and verify**

```bash
docker build -f Dockerfile.api -t a11y-api-test .
docker run --rm a11y-api-test typst --version
```
Expected: prints Typst version.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile.api
git commit -m "feat: install Typst in API Docker image for PDF generation"
```

---

### Task 8: Integration Test + Cleanup

**Files:**
- Verify: all existing tests still pass
- Clean up: remove any references to old pdf.ts

- [ ] **Step 1: Run full test suite**

```bash
bun test
```

Fix any failures caused by:
- Imports of deleted `src/reporter/pdf.ts`
- Changed function signatures in `db-pages.ts`
- Missing `report_category` in test fixtures

- [ ] **Step 2: Verify .gitignore**

Ensure `templates/report/fonts/` is tracked (not ignored) and `.superpowers/` is ignored:

```bash
echo ".superpowers/" >> .gitignore  # if not already there
git check-ignore templates/report/fonts/  # should return nothing (tracked)
```

- [ ] **Step 3: Manual smoke test**

If you have a completed audit in the DB:
1. `curl -o report.pdf "http://localhost:3000/api/audits/<id>/export/pdf"`
2. Open `report.pdf` — verify all sections render
3. `curl -o report-full.pdf "http://localhost:3000/api/audits/<id>/export/pdf?detail=full"`
4. Open `report-full.pdf` — verify instances table appears

If no completed audit, create one by running an audit against a test site.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: cleanup and integration verification for report generation"
```
