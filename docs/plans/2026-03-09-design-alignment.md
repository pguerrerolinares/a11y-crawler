# Design Alignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align the frontend implementation with the design.pen specifications across all pages (dashboard, reports, logs, log detail modal).

**Architecture:** Incremental changes to existing React components. One new shared Pagination component. Changes are mostly presentational — no backend changes needed. Each task group is independent and can be parallelized.

**Tech Stack:** React, Tailwind CSS, shadcn/ui, TanStack Query, Lucide React icons

**Branding:** Keep "a11y Crawler" and "Audits" nav link. Footer stays commented out.

---

## Task 1: Shared Pagination Component

**Files:**
- Create: `frontend/src/components/pagination.tsx`

**Step 1: Create the numbered pagination component**

```tsx
// frontend/src/components/pagination.tsx
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface PaginationProps {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}

export function Pagination({ total, limit, offset, onChange }: PaginationProps) {
  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  if (totalPages <= 1) return null;

  // Build page numbers: show up to 5 pages around current
  const pages: (number | "ellipsis")[] = [];
  const addPage = (p: number) => { if (p >= 1 && p <= totalPages && !pages.includes(p)) pages.push(p); };

  addPage(1);
  if (currentPage > 3) pages.push("ellipsis");
  for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) addPage(i);
  if (currentPage < totalPages - 2) pages.push("ellipsis");
  if (totalPages > 1) addPage(totalPages);

  return (
    <div className="flex items-center justify-center gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-8 w-8 p-0"
        disabled={currentPage === 1}
        onClick={() => onChange((currentPage - 2) * limit)}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      {pages.map((p, i) =>
        p === "ellipsis" ? (
          <span key={`e${i}`} className="px-1 text-muted-foreground text-sm">…</span>
        ) : (
          <Button
            key={p}
            variant={p === currentPage ? "default" : "outline"}
            size="sm"
            className="h-8 w-8 p-0 text-xs"
            onClick={() => onChange((p - 1) * limit)}
          >
            {p}
          </Button>
        )
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-8 w-8 p-0"
        disabled={currentPage === totalPages}
        onClick={() => onChange(currentPage * limit)}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
```

**Step 2: Verify it builds**

Run: `cd frontend && bun run build` or check dev server has no errors.

---

## Task 2: Dashboard — Redesign Stat Cards

**Files:**
- Modify: `frontend/src/components/stats-cards.tsx`

**Changes:** Replace the 5-column impact grid with 4 design-matching cards: Issues Found (total with badge), Warnings, Passed, WCAG Score (circular SVG progress).

**Step 1: Rewrite stats-cards.tsx**

Replace entire content of `stats-cards.tsx` with:

```tsx
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";

interface StatsCardsProps {
  summary: {
    totalIssues: number;
    totalPages: number;
    issuesByImpact: Record<string, number>;
  };
}

function WcagScoreRing({ score }: { score: number }) {
  const r = 36;
  const circumference = 2 * Math.PI * r;
  const filled = (score / 100) * circumference;
  const color = score >= 80 ? "text-green-500" : score >= 50 ? "text-yellow-500" : "text-red-500";

  return (
    <div className="relative h-20 w-20">
      <svg className="h-full w-full -rotate-90" viewBox="0 0 80 80">
        <circle cx="40" cy="40" r={r} fill="none" strokeWidth="6" className="stroke-muted" />
        <circle
          cx="40" cy="40" r={r} fill="none" strokeWidth="6"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - filled}
          strokeLinecap="round"
          className={`${color} stroke-current transition-all duration-500`}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-lg font-bold tabular-nums">{score}</span>
      </div>
    </div>
  );
}

function computeWcagScore(summary: StatsCardsProps["summary"]): number {
  const { totalIssues, totalPages } = summary;
  if (totalPages === 0) return 100;
  // Simple heuristic: 100 - (issues per page * 10), clamped 0-100
  const issuesPerPage = totalIssues / totalPages;
  return Math.max(0, Math.min(100, Math.round(100 - issuesPerPage * 10)));
}

export function StatsCards({ summary }: StatsCardsProps) {
  const warnings = (summary.issuesByImpact.moderate ?? 0) + (summary.issuesByImpact.minor ?? 0);
  const critical = (summary.issuesByImpact.critical ?? 0) + (summary.issuesByImpact.serious ?? 0);
  const score = computeWcagScore(summary);

  return (
    <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
      {/* Issues Found */}
      <Card>
        <CardContent className="p-5">
          <p className="text-xs text-muted-foreground font-medium">Issues Found</p>
          <div className="flex items-baseline gap-2 mt-1">
            <p className="text-2xl font-bold tabular-nums">{summary.totalIssues}</p>
            {critical > 0 && (
              <Badge className="bg-red-500/15 text-red-700 dark:text-red-400 text-[10px]">
                {critical} critical
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{summary.totalPages} pages scanned</p>
        </CardContent>
      </Card>

      {/* Warnings */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-muted-foreground font-medium">Warnings</p>
              <p className="text-2xl font-bold tabular-nums mt-1 text-yellow-600 dark:text-yellow-400">{warnings}</p>
            </div>
            <div className="h-8 w-8 rounded-md bg-yellow-50 dark:bg-yellow-950 flex items-center justify-center">
              <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Passed */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-muted-foreground font-medium">Passed</p>
              <p className="text-2xl font-bold tabular-nums mt-1 text-green-600 dark:text-green-400">
                {Math.max(0, summary.totalPages - Math.ceil(summary.totalIssues / Math.max(1, summary.totalPages)))}
              </p>
            </div>
            <div className="h-8 w-8 rounded-md bg-green-50 dark:bg-green-950 flex items-center justify-center">
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* WCAG Score */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground font-medium">WCAG Score</p>
              <div className="flex items-center gap-1 mt-1">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">/ 100</span>
              </div>
            </div>
            <WcagScoreRing score={score} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

---

## Task 3: Dashboard — Add Scan Options & Report Section

**Files:**
- Modify: `frontend/src/pages/dashboard.tsx`

**Step 1: Add depth/max pages options under URL input**

After the `<form>` element (line ~95), add a row of scan options that shows when no scan is active:

```tsx
{!isActive && (
  <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground">
    <label className="flex items-center gap-1.5">
      Max depth:
      <Input type="number" min={1} max={10} defaultValue={3} className="w-16 h-7 text-xs" />
    </label>
    <label className="flex items-center gap-1.5">
      Max pages:
      <Input type="number" min={1} max={500} defaultValue={50} className="w-20 h-7 text-xs" />
    </label>
  </div>
)}
```

**Step 2: Add "Accessibility Report" section after the Tabs**

After the closing `</Tabs>` and before the empty state `</>`, add:

```tsx
{/* Accessibility Report */}
<Card>
  <CardContent className="p-6 space-y-4">
    <h2 className="text-lg font-semibold">Accessibility Report</h2>
    <div className="flex gap-8 text-sm">
      <div>
        <p className="text-2xl font-bold tabular-nums">{audit.summary?.totalPages ?? 0}</p>
        <p className="text-xs text-muted-foreground">Pages Scanned</p>
      </div>
      <div>
        <p className="text-2xl font-bold tabular-nums">{audit.summary?.totalIssues ?? 0}</p>
        <p className="text-xs text-muted-foreground">Issues Found</p>
      </div>
      {audit.finishedAt && audit.startedAt && (
        <div>
          <p className="text-2xl font-bold tabular-nums">
            {Math.round((new Date(audit.finishedAt).getTime() - new Date(audit.startedAt).getTime()) / 1000)}s
          </p>
          <p className="text-xs text-muted-foreground">Scan Duration</p>
        </div>
      )}
    </div>
    <div className="flex gap-2">
      <Button size="sm">
        <Download className="h-4 w-4 mr-1.5" />
        Download PDF Report
      </Button>
      <Button variant="outline" size="sm">
        <Download className="h-4 w-4 mr-1.5" />
        Export CSV
      </Button>
    </div>
  </CardContent>
</Card>
```

Add `Download` to the lucide-react imports.

**Step 3: Replace IssueTable pagination with shared Pagination**

In `frontend/src/components/issue-table.tsx`, replace the prev/next buttons (lines 139-151) with:

```tsx
import { Pagination } from "@/components/pagination";
// ...
<div className="flex items-center justify-between">
  <span className="text-xs text-muted-foreground">{data.total} total issues</span>
  <Pagination total={data.total} limit={limit} offset={offset} onChange={setOffset} />
</div>
```

Remove the `ChevronLeft, ChevronRight` imports.

---

## Task 4: Reports Page — Redesign Cards, Add WCAG Score, Search, Pagination

**Files:**
- Modify: `frontend/src/pages/reports.tsx`

**Step 1: Change stat cards to match design**

Replace the 4 StatCards (lines 82-107) with:

- **Last Scan**: Keep as-is but add sub text showing "Scan completed" badge
- **Critical Issues**: Keep as-is
- **Pages Failing**: Show `failing / completedCount` with a Progress bar underneath
- **Issues Fixed**: Show percentage with trend (use a simple estimated value)

```tsx
import { Progress } from "@/components/ui/progress";

// In the stats grid:
<StatCard
  title="Last Scan"
  value={stats.lastScan ? dateFormatter.format(stats.lastScan) : "—"}
  sub={stats.completedCount > 0 ? `${stats.completedCount} scans completed` : "No scans yet"}
  icon={Calendar}
/>
<StatCard
  title="Critical Issues"
  value={stats.critical}
  icon={AlertOctagon}
  iconClassName="bg-red-50 dark:bg-red-950"
  trend={stats.critical > 0 ? { label: "Needs attention", positive: false } : undefined}
/>
```

For "Pages Failing" and "Issues Fixed", they need custom markup since StatCard doesn't support progress bars. Create inline cards:

```tsx
{/* Pages Failing */}
<Card>
  <CardContent className="p-5 space-y-2">
    <div className="flex items-start justify-between">
      <div>
        <p className="text-xs text-muted-foreground font-medium">Pages Failing</p>
        <p className="text-2xl font-bold tabular-nums mt-1">
          {stats.failing}
          <span className="text-sm font-normal text-muted-foreground"> / {stats.completedCount} scans</span>
        </p>
      </div>
      <div className="h-8 w-8 rounded-md bg-amber-50 dark:bg-amber-950 flex items-center justify-center shrink-0">
        <FileWarning className="h-4 w-4 text-muted-foreground" />
      </div>
    </div>
    <Progress value={stats.completedCount > 0 ? (stats.failing / stats.completedCount) * 100 : 0} className="h-1.5" />
  </CardContent>
</Card>

{/* Issues Fixed */}
<Card>
  <CardContent className="p-5">
    <div className="flex items-start justify-between">
      <div>
        <p className="text-xs text-muted-foreground font-medium">Issues Fixed</p>
        <p className="text-2xl font-bold tabular-nums mt-1">{stats.totalIssues}</p>
        <p className="text-xs text-muted-foreground">across all scans</p>
      </div>
      <div className="h-8 w-8 rounded-md bg-green-50 dark:bg-green-950 flex items-center justify-center shrink-0">
        <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
      </div>
    </div>
  </CardContent>
</Card>
```

**Step 2: Add search filter and WCAG Score column to table**

Add a search state and filter the audits:
```tsx
const [search, setSearch] = useState("");
// Filter audits by search
const filteredAudits = useMemo(() => {
  const audits = data?.data ?? [];
  if (!search) return audits;
  const q = search.toLowerCase();
  return audits.filter(a => a.url.toLowerCase().includes(q));
}, [data, search]);
```

Add search bar in the Scan History card header (replace lines 114-117):
```tsx
<div className="flex items-center justify-between px-4 py-3 border-b gap-3">
  <h2 className="text-sm font-semibold shrink-0">Scan History</h2>
  <div className="flex items-center gap-2">
    <Input
      placeholder="Search reports…"
      value={search}
      onChange={e => setSearch(e.target.value)}
      className="h-8 text-xs w-48"
    />
    <span className="text-xs text-muted-foreground shrink-0">{filteredAudits.length} reports</span>
  </div>
</div>
```

Add `Input` to imports and a WCAG Score column to the table after the Date column:
```tsx
<TableHead>WCAG Score</TableHead>
// ...
<TableCell className="tabular-nums text-sm font-medium">
  {audit.summary ? Math.max(0, Math.min(100, Math.round(100 - (audit.summary.totalIssues / Math.max(1, audit.summary.totalPages)) * 10))) : "—"}
</TableCell>
```

**Step 3: Add pagination**

Add pagination state and use the shared Pagination component at the bottom of the card, replacing just the `{data?.total ?? 0} reports` count.

```tsx
import { Pagination } from "@/components/pagination";

// Add state
const [offset, setOffset] = useState(0);
const limit = 10;
const paginatedAudits = filteredAudits.slice(offset, offset + limit);

// Use paginatedAudits instead of data!.data in the table body
// Add after the table:
<div className="px-4 py-3 border-t">
  <Pagination total={filteredAudits.length} limit={limit} offset={offset} onChange={setOffset} />
</div>
```

Add `useState` to React imports if not already there.

---

## Task 5: Logs — Fix Method Colors, Active Tags, Mobile View, Active Toggle

**Files:**
- Modify: `frontend/src/pages/logs.tsx`
- Modify: `frontend/src/components/log-filters.tsx`

**Step 1: Fix method badge colors in logs.tsx (swap GET and POST)**

In `logs.tsx`, change the `methodColors` map (lines 14-20):

```tsx
const methodColors: Record<string, string> = {
  GET: "bg-green-500/15 text-green-700 dark:text-green-400",    // was blue
  POST: "bg-blue-500/15 text-blue-700 dark:text-blue-400",      // was green
  DELETE: "bg-red-500/15 text-red-700 dark:text-red-400",
  PUT: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  PATCH: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
};
```

Also fix in `log-filters.tsx` the `methodActiveColors` (lines 8-13):

```tsx
const methodActiveColors: Record<string, string> = {
  GET: "bg-green-500/20 text-green-700 dark:text-green-300 border-green-500/40",    // was blue
  POST: "bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-500/40",        // was green
  PUT: "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300 border-yellow-500/40",
  DELETE: "bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/40",
  PATCH: "bg-purple-500/20 text-purple-700 dark:text-purple-300 border-purple-500/40",
};
```

**Step 2: Add active filter tags below filter bar**

In `log-filters.tsx`, add after the 3 grid rows (before closing `</div>` of `space-y-2`):

```tsx
{/* Active filter tags */}
{hasFilters && (
  <div className="flex items-center gap-1.5 flex-wrap">
    <span className="text-[10px] text-muted-foreground font-medium">Active:</span>
    {filters.method.map(m => (
      <span key={m} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
        {m}
        <button onClick={() => onChange({ ...filters, method: filters.method.filter(x => x !== m) })} className="hover:text-foreground">
          <X className="h-2.5 w-2.5" />
        </button>
      </span>
    ))}
    {filters.status && (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
        Status: {filters.status}
        <button onClick={() => onChange({ ...filters, status: "" })} className="hover:text-foreground">
          <X className="h-2.5 w-2.5" />
        </button>
      </span>
    )}
    {filters.path && (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
        Path: {filters.path}
        <button onClick={() => onChange({ ...filters, path: "" })} className="hover:text-foreground">
          <X className="h-2.5 w-2.5" />
        </button>
      </span>
    )}
    {filters.ip && (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
        IP: {filters.ip}
        <button onClick={() => onChange({ ...filters, ip: "" })} className="hover:text-foreground">
          <X className="h-2.5 w-2.5" />
        </button>
      </span>
    )}
    {(filters.from || filters.to) && (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
        Date range
        <button onClick={() => onChange({ ...filters, from: "", to: "" })} className="hover:text-foreground">
          <X className="h-2.5 w-2.5" />
        </button>
      </span>
    )}
  </div>
)}
```

**Step 3: Add "Active Only" toggle to logs page header**

In `logs.tsx`, add an "Active Only" toggle button in the header (next to Export):

```tsx
import { ToggleLeft, ToggleRight } from "lucide-react"; // add to imports

// Add state
const [activeOnly, setActiveOnly] = useState(false);

// In header buttons area, before Export:
<Button
  variant={activeOnly ? "default" : "outline"}
  size="sm"
  onClick={() => setActiveOnly(!activeOnly)}
  className="gap-1.5"
>
  {activeOnly ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
  Active Only
</Button>
```

Also pass `activeOnly` to the query params in `buildParams` if true: add `if (activeOnly) p.set("activeOnly", "true");` — but since backend may not support this, just filter client-side for now by filtering logs with status < 400.

**Step 4: Add mobile card view for logs table**

In `logs.tsx`, wrap the existing table in `hidden md:block` and add a mobile card view:

```tsx
{/* Desktop table */}
<div className="hidden md:block rounded-md border overflow-x-auto">
  <Table>...</Table>
</div>

{/* Mobile cards */}
<div className="md:hidden divide-y rounded-md border">
  {logs.map((log: LogEntry) => (
    <div
      key={log.id}
      className="px-4 py-3 hover:bg-muted/30 transition-colors cursor-pointer"
      onClick={() => handleSelect(log.id, "general")}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Badge className={methodColors[log.method] ?? ""} variant="secondary">
            {log.method}
          </Badge>
          <span className="font-mono text-xs truncate">{log.path}</span>
        </div>
        <Badge className={statusColor(log.statusCode)} variant="secondary">
          {log.statusCode}
        </Badge>
      </div>
      <div className="flex gap-4 mt-1.5 text-[10px] text-muted-foreground">
        <span>{dateFormatter.format(new Date(log.createdAt))}</span>
        <span className={durationClass(log.durationMs)}>{log.durationMs}ms</span>
        <span>{log.ip}</span>
      </div>
    </div>
  ))}
  {logs.length === 0 && (
    <div className="text-center text-muted-foreground py-8 text-sm">No logs found</div>
  )}
</div>
```

**Step 5: Replace logs pagination with shared Pagination**

Replace the prev/next buttons (lines 248-258) with:

```tsx
import { Pagination } from "@/components/pagination";

<div className="flex items-center justify-between">
  <span className="text-xs text-muted-foreground">{data?.total ?? 0} total logs</span>
  <Pagination total={data?.total ?? 0} limit={limit} offset={offset} onChange={setOffset} />
</div>
```

---

## Task 6: Mobile Log Detail — Bottom Sheet Style

**Files:**
- Modify: `frontend/src/components/log-detail-modal.tsx`

**Step 1: Change mobile modal to bottom sheet**

Update the `DialogContent` className to use bottom-sheet positioning on mobile:

```tsx
<DialogContent
  showCloseButton={false}
  className="sm:max-w-[860px] p-0 gap-0 flex flex-col overflow-hidden
    fixed bottom-0 left-0 right-0 h-[90vh] rounded-t-2xl
    sm:relative sm:bottom-auto sm:left-auto sm:right-auto sm:h-[85vh] sm:rounded-lg"
>
```

Note: This depends on how the Dialog component is implemented. If it uses Radix UI's Dialog, the positioning override should work via Tailwind. If not, the approach may need to target the overlay/content wrapper. The key visual change: on mobile (`<sm`), the modal anchors to bottom with rounded top corners (`rounded-t-2xl`).

---

## Execution Order

Tasks 1-6 are mostly independent. Recommended order:

1. **Task 1** (Pagination) — shared dependency, do first
2. **Tasks 2-6** — can be parallelized after Task 1

## Verification

After all tasks, verify:
- `cd frontend && bun run build` succeeds with no TS errors
- Visual check each page in browser
- Test mobile responsive at 390px width
- Verify pagination works on issues table, reports table, and logs table
