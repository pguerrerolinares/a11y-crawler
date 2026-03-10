# A11y Crawler v3 — Architecture Redesign

> **Date:** 2026-03-10
> **Status:** Approved
> **Supersedes:** `2026-03-07-a11y-crawler-v2-architecture.md`
> **Motivation:** Production testing revealed critical RAM issues (~900MB Chromium) and inability to crawl SPAs beyond first page. Product direction requires interactive accessibility tests and SaaS scalability.

---

## Table of Contents

1. [Problems Solved](#1-problems-solved)
2. [Architecture Overview](#2-architecture-overview)
3. [Component Details](#3-component-details)
4. [Pipeline Per Page](#4-pipeline-per-page)
5. [Interactive Accessibility Tests](#5-interactive-accessibility-tests)
6. [LLM Strategy](#6-llm-strategy)
7. [Queue System](#7-queue-system)
8. [SSE Progress Notifications](#8-sse-progress-notifications)
9. [Browserless Integration](#9-browserless-integration)
10. [Docker Deployment](#10-docker-deployment)
11. [Migration Guide — What Changes](#11-migration-guide--what-changes)
12. [Data Types](#12-data-types)
13. [File Structure](#13-file-structure)
14. [Performance Estimates](#14-performance-estimates)
15. [Future: Autofix Phase](#15-future-autofix-phase)

---

## 1. Problems Solved

### 1.1 RAM Consumption (Critical)

**Problem:** Single Chromium instance via Crawlee consumes ~900MB. On a 4GB VPS (shared with Coolify + other services, ~1.8GB available), this leaves no headroom. Crawlee's AutoscaledPool detects "memory critically overloaded" and stops processing URLs after the first page.

**Root cause:** Crawlee's memory snapshotter cannot read cgroup limits in the container (`ENOENT: /sys/fs/cgroup/memory/memory.usage_in_bytes`). It falls back to a conservative ~952MB limit. With Chromium at ~900MB, it hits 98% and halts.

**Solution:** Move Chromium to a dedicated Browserless container. Worker connects via WebSocket — worker RAM drops from ~900MB to ~100MB. Browserless manages its own browser pool and lifecycle.

### 1.2 SPA Depth Crawling (Critical)

**Problem:** Tested with https://www.finnk.com — sitemap discovered 20 URLs but crawler only processed 1 page. Logs show "All requests from the queue have been processed" after page 1.

**Root cause:** Same as 1.1 — Crawlee's memory overload detection stopped enqueueing new URLs. Not a bug in link discovery.

**Solution:** Resolved by fixing the RAM issue. Additionally, replacing Crawlee with direct Playwright gives full control over the URL queue without auto-scaling interference.

### 1.3 No Interactive Accessibility Tests (Product Gap)

**Problem:** Crawler only runs axe-core (static DOM analysis). Missing critical accessibility checks that require browser interaction: tab navigation order, keyboard traps, focus visibility, skip navigation, keyboard operability.

**Solution:** New interactive test suite runs after axe-core, using Playwright to simulate real user interactions.

### 1.4 No Scalability for SaaS (Architecture Gap)

**Problem:** Monolith process (API + crawler in one). One audit blocks everything. Cannot support multiple concurrent users.

**Solution:** Separate API server from Worker. PostgreSQL-based queue. Workers scale independently.

---

## 2. Architecture Overview

```
┌──────────────┐     ┌────────────────┐     ┌──────────────────────┐
│   Frontend   │────▶│   API Server   │────▶│   PostgreSQL (PG)    │
│   (React)    │◀─SSE│   (Bun.serve)  │     │  - audits table      │
│   Static     │     │   ~50MB RAM    │     │  - (shared Coolify)  │
└──────────────┘     └────────────────┘     └──────────┬───────────┘
                                                        │
                                               poll every 5s
                                                        │
                                            ┌───────────▼──────────┐
                                            │      Worker          │
                                            │   (Bun process)      │
                                            │   ~100MB RAM         │
                                            │                      │
                                            │  - Crawl orchestrator│
                                            │  - Axe-core          │
                                            │  - Interactive tests │
                                            │  - LLM nav discovery │
                                            │  - Link extraction   │
                                            └───────────┬──────────┘
                                                        │
                                                   ws:// (local)
                                                        │
                                            ┌───────────▼──────────┐
                                            │    Browserless       │
                                            │  (Docker sidecar)    │
                                            │  ~500MB RAM          │
                                            │                      │
                                            │  - Chromium pool     │
                                            │  - Session mgmt      │
                                            │  - Auto cleanup      │
                                            └──────────────────────┘
```

**Total RAM:** ~650MB (API 50MB + Worker 100MB + Browserless 500MB) vs ~900MB+ current.

**Key principle:** Each component does one thing. API serves HTTP. Worker runs audits. Browserless manages browsers. Scale any independently.

---

## 3. Component Details

### 3.1 API Server (`src/server/`)

**Responsibilities:**
- Serve frontend static files (React build)
- REST endpoints for audit CRUD
- SSE endpoint for real-time progress
- Health check endpoint

**Does NOT:**
- Import Playwright
- Run any audit logic
- Manage browser instances

**Endpoints:**

```
POST   /api/audits              — Create new audit (enqueue)
GET    /api/audits              — List audits (with status filter)
GET    /api/audits/:id          — Get audit status + result summary
GET    /api/audits/:id/report   — Get full report (JSON)
GET    /api/audits/:id/pdf      — Get PDF report
GET    /api/audits/:id/events   — SSE stream for real-time progress
DELETE /api/audits/:id          — Cancel queued audit
GET    /health                  — Health check
```

**Request body for `POST /api/audits`:**
```json
{
  "url": "https://example.com",
  "config": {
    "maxPages": 50,
    "maxDepth": 5,
    "wcagLevel": "AA",
    "skipSitemap": false,
    "excludePatterns": []
  }
}
```

**Response:**
```json
{
  "id": "uuid",
  "status": "queued",
  "url": "https://example.com",
  "createdAt": "2026-03-10T..."
}
```

### 3.2 Worker (`src/worker/`)

**Responsibilities:**
- Poll PostgreSQL for `status='queued'` audits
- Connect to Browserless via WebSocket
- Run the full audit pipeline per page
- Save results (JSON report + PDF)
- Update audit status in DB
- Emit progress events (via DB or direct channel)

**Lifecycle:**

```
1. Start → connect to Browserless (ws://browserless:3000/chromium/playwright)
2. Connect to PostgreSQL
3. Enter main loop:
   a. Query for next queued audit (FOR UPDATE SKIP LOCKED)
   b. If none → sleep 5s → goto 3a
   c. Set status = 'running', started_at = now()
   d. Execute audit pipeline (see Section 4)
   e. Save report to disk (/app/reports/<id>.json, <id>.pdf)
   f. Set status = 'completed', result_path, completed_at
   g. On error: set status = 'failed', error message
   h. Goto 3a
4. On SIGTERM → finish current audit → exit gracefully
```

**Key implementation details:**

```typescript
// src/worker/index.ts

import { chromium } from "playwright";
import { runAudit } from "./audit.ts";

const POLL_INTERVAL_MS = 5000;
const BROWSERLESS_URL = process.env.BROWSERLESS_URL || "ws://browserless:3000/chromium/playwright";

async function main() {
  const browser = await chromium.connect(BROWSERLESS_URL);
  console.log("Connected to Browserless");

  // Graceful shutdown
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });

  while (!stopping) {
    const audit = await claimNextAudit();  // SELECT ... FOR UPDATE SKIP LOCKED

    if (!audit) {
      await Bun.sleep(POLL_INTERVAL_MS);
      continue;
    }

    console.log(`Starting audit ${audit.id}: ${audit.url}`);

    try {
      const report = await runAudit(browser, {
        baseUrl: audit.url,
        ...audit.config,
        onProgress: (event) => emitProgress(audit.id, event),
      });

      await saveReport(audit.id, report);
      await markCompleted(audit.id);
      console.log(`Audit ${audit.id} completed: ${report.summary.totalPages} pages, ${report.summary.totalIssues} issues`);

    } catch (error) {
      await markFailed(audit.id, error.message);
      console.error(`Audit ${audit.id} failed:`, error.message);
    }
  }

  await browser.close();
  console.log("Worker stopped gracefully");
}

main().catch(console.error);
```

**Browser management:**
- Single `browser` instance kept alive across audits (connected to Browserless)
- Each URL gets a `browser.newPage()` → analyze → `page.close()`
- If Browserless connection drops, worker reconnects with exponential backoff
- Browserless handles Chromium lifecycle, crash recovery, session cleanup

### 3.3 Browserless (`ghcr.io/browserless/chromium`)

**Configuration:**

```yaml
environment:
  - MAX_CONCURRENT_SESSIONS=2      # Max parallel browser pages
  - CONNECTION_TIMEOUT=120000      # 2 min per session max
  - TIMEOUT=120000                 # Global timeout
  - HEALTH=true                    # Enable health endpoint
  - PREBOOT_CHROME=true            # Pre-launch Chromium for faster first connect
```

**Why Browserless over direct Chromium:**
- Manages browser pool and session lifecycle
- Auto-restarts crashed browsers
- Health monitoring
- Pre-boots Chromium (faster first page)
- Connection queueing (if sessions are full)
- Proven in production (used by many scraping/testing platforms)
- SSPL license allows self-hosted use with our SaaS product

**Connection from Worker:**
```typescript
import { chromium } from "playwright";
const browser = await chromium.connect("ws://browserless:3000/chromium/playwright");
```

This is the ONLY change needed in Playwright code — same API, remote browser.

---

## 4. Pipeline Per Page

The audit pipeline processes one URL at a time. Each URL gets its own `page` from the browser, which is closed immediately after analysis.

```
┌─────────────────────────────────────────────────────┐
│                  Per-URL Pipeline                    │
│                                                     │
│  1. Navigate + wait for networkidle     (~5-30s)    │
│     └─ page.goto(url, { waitUntil: 'networkidle' })│
│     └─ Timeout acceptable, continue anyway          │
│                                                     │
│  2. Axe-core static analysis            (~2-5s)     │
│     └─ runAxe(page, { wcagLevel })                  │
│     └─ Returns Issue[] with checkSource: 'axe'      │
│                                                     │
│  3. Interactive accessibility tests      (~5-10s)   │
│     └─ runInteractiveTests(page)                    │
│     └─ Tab order, focus visibility, keyboard traps  │
│     └─ Returns Issue[] with checkSource: 'interactive'│
│                                                     │
│  4. Page representation for LLM         (~1-2s)     │
│     └─ buildRepresentation(page)                    │
│     └─ ARIA snapshot → pruned HTML → CSS heuristic  │
│                                                     │
│  5. LLM nav discovery                   (~3-10s)    │
│     └─ discoverNavTargets(url, title, repr, client) │
│     └─ Returns NavTarget[] (selectors to click)     │
│     └─ SKIP if nav repr matches previous page       │
│                                                     │
│  6. Link extraction                     (~1-3s)     │
│     └─ Extract all <a href> same-origin links       │
│     └─ Click nav targets, discover new URLs         │
│     └─ Add to urlQueue                              │
│                                                     │
│  7. Close page                          (<0.1s)     │
│     └─ page.close() — frees memory immediately      │
│                                                     │
│  8. Emit progress event                             │
│     └─ { pagesAnalyzed, totalDiscovered, url }      │
└─────────────────────────────────────────────────────┘
```

### 4.1 Link Extraction (replacing Crawlee's enqueueLinks)

```typescript
// src/crawler/links.ts

export async function extractLinks(page: Page, baseOrigin: string): Promise<string[]> {
  const hrefs = await page.$$eval("a[href]", (anchors) =>
    anchors
      .map((a) => {
        try { return new URL(a.href).href; } catch { return null; }
      })
      .filter(Boolean)
  );

  return hrefs.filter((href) => {
    try {
      const url = new URL(href);
      return url.origin === baseOrigin && !isBlacklistedUrl(href);
    } catch {
      return false;
    }
  });
}
```

### 4.2 URL Queue (replacing Crawlee's RequestQueue)

```typescript
// src/crawler/queue.ts

export class UrlQueue {
  private pending: string[] = [];
  private visited = new Set<string>();
  private discovered = new Map<string, "link" | "sitemap" | "interaction">();

  constructor(private maxPages: number) {}

  seed(urls: string[], origin: "link" | "sitemap" | "interaction"): void {
    for (const url of urls) {
      const normalized = normalizeUrl(url);
      if (!this.discovered.has(normalized)) {
        this.discovered.set(normalized, origin);
        this.pending.push(normalized);
      }
    }
  }

  next(): string | null {
    while (this.pending.length > 0) {
      const url = this.pending.shift()!;
      if (!this.visited.has(url) && this.visited.size < this.maxPages) {
        this.visited.add(url);
        return url;
      }
    }
    return null;
  }

  get stats() {
    return {
      totalDiscovered: this.discovered.size,
      totalVisited: this.visited.size,
      pendingCount: this.pending.length,
      byOrigin: {
        sitemap: [...this.discovered.values()].filter((v) => v === "sitemap").length,
        link: [...this.discovered.values()].filter((v) => v === "link").length,
        interaction: [...this.discovered.values()].filter((v) => v === "interaction").length,
      },
    };
  }
}
```

### 4.3 Audit Orchestrator (replacing Crawlee's PlaywrightCrawler)

```typescript
// src/worker/audit.ts

import type { Browser } from "playwright";
import type { CrawlConfig } from "../types/config.ts";
import type { SiteReport, PageResult } from "../types/report.ts";
import { UrlQueue } from "../crawler/queue.ts";
import { LLMClient } from "../llm/client.ts";
import { discoverSitemapUrls } from "../crawler/sitemap.ts";
import { runAxe } from "../analyzer/axe.ts";
import { runInteractiveTests } from "../analyzer/interactive.ts";
import { buildRepresentation } from "../repr/tier.ts";
import { discoverNavTargets } from "../discovery/nav.ts";
import { extractLinks } from "../crawler/links.ts";
import { interactWithTargets } from "../crawler/interactions.ts";
import { detectSharedIssues } from "../reporter/shared.ts";

export interface AuditOptions extends CrawlConfig {
  onProgress?: (event: ProgressEvent) => void;
}

export async function runAudit(browser: Browser, options: AuditOptions): Promise<SiteReport> {
  const startTime = Date.now();
  const baseOrigin = new URL(options.baseUrl).origin;
  const queue = new UrlQueue(options.maxPages);
  const pages: PageResult[] = [];
  const errors: CrawlError[] = [];

  // Single LLM client — navigation only
  const navClient = new LLMClient({
    apiKey: options.apiKey,
    baseUrl: options.apiBaseUrl,
    model: options.navModel,
    rateLimitRpm: options.rateLimitRpm,
  });

  // Nav cache: skip LLM call if page has identical nav structure
  let lastNavRepr: string | null = null;
  let cachedNavTargets: NavTarget[] = [];

  // Phase 1: Seed URLs
  queue.seed([options.baseUrl], "link");

  if (!options.skipSitemap) {
    const sitemapUrls = await discoverSitemapUrls(options.baseUrl);
    queue.seed(sitemapUrls.slice(0, Math.ceil(options.maxPages / 2)), "sitemap");
  }

  // Phase 2: Process pages
  let url: string | null;
  while ((url = queue.next()) !== null) {
    const page = await browser.newPage();

    try {
      const result = await processPage(page, url, {
        baseOrigin,
        queue,
        navClient,
        config: options,
        lastNavRepr,
        cachedNavTargets,
      });

      pages.push(result.pageResult);
      lastNavRepr = result.navRepr;
      cachedNavTargets = result.navTargets;

      options.onProgress?.({
        type: "page_analyzed",
        data: {
          url: result.pageResult.url,
          title: result.pageResult.title,
          issueCount: result.pageResult.issues.length,
          pagesAnalyzed: pages.length,
          totalDiscovered: queue.stats.totalDiscovered,
          elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
        },
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ url, phase: "navigation", message, timestamp: new Date().toISOString() });
      options.onProgress?.({ type: "error", data: { url, message } });

    } finally {
      await page.close();  // CRITICAL: always close to free memory
    }
  }

  // Phase 3: Post-processing
  const sharedIssues = detectSharedIssues(pages);

  options.onProgress?.({
    type: "completed",
    data: { totalPages: pages.length, totalIssues: pages.flatMap((p) => p.issues).length },
  });

  return buildSiteReport(pages, sharedIssues, errors, queue.stats, navClient.usage, options, startTime);
}

async function processPage(page, url, ctx): Promise<ProcessResult> {
  // Step 1: Navigate
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: ctx.config.pageTimeout });
  } catch {
    // Timeout acceptable — page may still be usable
  }

  // Step 2: Axe-core
  const axeIssues = await runAxe(page, { wcagLevel: ctx.config.wcagLevel });

  // Step 3: Interactive tests
  const interactiveIssues = await runInteractiveTests(page);

  // Step 4: Page representation
  const repr = await buildRepresentation(page);

  // Step 5: Nav discovery (with cache)
  let navTargets: NavTarget[];
  if (repr.content === ctx.lastNavRepr) {
    navTargets = ctx.cachedNavTargets;  // Skip LLM call — same nav
  } else {
    const title = await page.title();
    navTargets = await discoverNavTargets(url, title, repr, ctx.navClient);
  }

  // Step 6: Link extraction + interactions
  const staticLinks = await extractLinks(page, ctx.baseOrigin);
  ctx.queue.seed(staticLinks, "link");

  const interactionUrls = await interactWithTargets(page, navTargets, ctx.config, ctx.baseOrigin);
  ctx.queue.seed(interactionUrls, "interaction");

  // Build result
  const allIssues = [...axeIssues, ...interactiveIssues];
  const title = await page.title();

  return {
    pageResult: {
      url,
      title,
      issues: allIssues,
      groupedByRule: groupByRule(allIssues),
      discoveredUrls: [...staticLinks, ...interactionUrls],
      discoveryMethods: {},
      representationTier: repr.tier,
      timestamp: new Date().toISOString(),
      processingMs: Date.now() - startTime,
    },
    navRepr: repr.content,
    navTargets,
  };
}
```

---

## 5. Interactive Accessibility Tests

New module: `src/analyzer/interactive.ts`

These tests simulate real user interactions to detect accessibility issues that axe-core cannot find through static DOM analysis.

### 5.1 Tab Order Test

**What it verifies:** Focus moves in a logical, sequential order when pressing Tab.

**How:**
```typescript
async function testTabOrder(page: Page): Promise<Issue[]> {
  const issues: Issue[] = [];
  const focusSequence: FocusedElement[] = [];

  // Press Tab up to N times, record each focused element
  const MAX_TAB_PRESSES = 50;

  for (let i = 0; i < MAX_TAB_PRESSES; i++) {
    await page.keyboard.press("Tab");

    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        text: (el.textContent || "").trim().slice(0, 50),
        selector: generateSelector(el),  // Unique CSS selector
        tabindex: el.getAttribute("tabindex"),
        rect: { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right },
        isVisible: rect.width > 0 && rect.height > 0,
      };
    });

    if (!focused) continue;

    // Check: element with tabindex > 0 (disrupts natural order)
    if (focused.tabindex && parseInt(focused.tabindex) > 0) {
      issues.push(createIssue({
        rule: "tabindex-positive",
        impact: "serious",
        description: `Element has tabindex="${focused.tabindex}" which disrupts natural tab order`,
        selector: focused.selector,
        help: "Avoid using tabindex values greater than 0. Use tabindex='0' or tabindex='-1' instead.",
      }));
    }

    // Check: focused element is not visible (off-screen, hidden)
    if (!focused.isVisible) {
      issues.push(createIssue({
        rule: "focus-not-visible",
        impact: "serious",
        description: `Focus moved to a non-visible element: ${focused.tag}`,
        selector: focused.selector,
        help: "All focusable elements should be visible when focused. WCAG 2.4.7.",
      }));
    }

    focusSequence.push(focused);

    // Detect: focus returned to an earlier element (potential loop/trap)
    if (focusSequence.length > 3) {
      const lastThree = focusSequence.slice(-3).map((f) => f.selector);
      const prevThree = focusSequence.slice(-6, -3).map((f) => f.selector);
      if (JSON.stringify(lastThree) === JSON.stringify(prevThree)) {
        issues.push(createIssue({
          rule: "keyboard-trap",
          impact: "critical",
          description: `Keyboard trap detected: focus cycles between ${lastThree.join(", ")}`,
          selector: lastThree[0],
          help: "Users must be able to navigate away from all components using only the keyboard. WCAG 2.1.2.",
        }));
        break;  // Stop — we're in a trap
      }
    }
  }

  return issues;
}
```

### 5.2 Focus Visibility Test

**What it verifies:** Focused elements have a visible focus indicator (outline, box-shadow, etc.).

**How:**
```typescript
async function testFocusVisibility(page: Page): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Get all focusable elements
  const focusableSelectors = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const elements = await page.$$(focusableSelectors);

  // Sample up to 20 elements to avoid slow tests
  const sample = elements.slice(0, 20);

  for (const element of sample) {
    // Get styles BEFORE focus
    const stylesBefore = await element.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        outline: cs.outline,
        outlineWidth: cs.outlineWidth,
        boxShadow: cs.boxShadow,
        border: cs.border,
        backgroundColor: cs.backgroundColor,
      };
    });

    // Focus the element
    await element.focus();

    // Get styles AFTER focus
    const stylesAfter = await element.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        outline: cs.outline,
        outlineWidth: cs.outlineWidth,
        boxShadow: cs.boxShadow,
        border: cs.border,
        backgroundColor: cs.backgroundColor,
      };
    });

    // Check if ANY visual change occurred
    const hasVisualChange =
      stylesBefore.outline !== stylesAfter.outline ||
      stylesBefore.outlineWidth !== stylesAfter.outlineWidth ||
      stylesBefore.boxShadow !== stylesAfter.boxShadow ||
      stylesBefore.border !== stylesAfter.border ||
      stylesBefore.backgroundColor !== stylesAfter.backgroundColor;

    // Also check if outline is explicitly removed (outline: none / outline-width: 0)
    const outlineRemoved =
      stylesAfter.outlineWidth === "0px" || stylesAfter.outline.includes("none");

    if (!hasVisualChange || outlineRemoved) {
      const selector = await element.evaluate((el) => generateSelector(el));
      issues.push(createIssue({
        rule: "focus-indicator-missing",
        impact: "serious",
        description: "Focused element has no visible focus indicator",
        selector,
        help: "Interactive elements must have a visible focus indicator. WCAG 2.4.7 / 2.4.11.",
      }));
    }
  }

  return issues;
}
```

### 5.3 Skip Navigation Test

**What it verifies:** Page has a skip navigation link as first focusable element, and it works.

**How:**
```typescript
async function testSkipNavigation(page: Page): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Press Tab once — first focusable should be skip link
  await page.keyboard.press("Tab");

  const firstFocused = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return {
      tag: el.tagName.toLowerCase(),
      href: el.getAttribute("href"),
      text: (el.textContent || "").trim().toLowerCase(),
      isSkipLink: el.tagName === "A" && (el.getAttribute("href") || "").startsWith("#"),
    };
  });

  // Check if skip link exists
  const skipLink = await page.$('a[href^="#"]:is(:first-of-type, .skip-link, .skip-nav, [class*="skip"])');

  if (!skipLink) {
    issues.push(createIssue({
      rule: "skip-navigation-missing",
      impact: "moderate",
      description: "Page has no skip navigation link",
      selector: "body",
      help: "Provide a mechanism to bypass blocks of content repeated on multiple pages. WCAG 2.4.1.",
    }));
  } else {
    // Verify the skip link target exists
    const targetId = await skipLink.evaluate((el) => {
      const href = el.getAttribute("href");
      return href ? href.replace("#", "") : null;
    });

    if (targetId) {
      const targetExists = await page.$(`#${CSS.escape(targetId)}`) !== null;
      if (!targetExists) {
        issues.push(createIssue({
          rule: "skip-navigation-broken",
          impact: "serious",
          description: `Skip link points to #${targetId} but no element with that ID exists`,
          selector: `a[href="#${targetId}"]`,
          help: "Skip navigation link target must exist on the page. WCAG 2.4.1.",
        }));
      }
    }
  }

  return issues;
}
```

### 5.4 Keyboard Operability Test

**What it verifies:** Interactive elements (buttons, links, custom widgets) respond to keyboard activation (Enter/Space).

**How:**
```typescript
async function testKeyboardOperability(page: Page): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Find elements with click handlers but no keyboard handlers
  const suspectElements = await page.$$eval(
    '[onclick], [role="button"], [role="tab"], [role="menuitem"]',
    (elements) =>
      elements
        .filter((el) => {
          // Exclude native interactive elements (already keyboard accessible)
          const tag = el.tagName.toLowerCase();
          if (["a", "button", "input", "select", "textarea"].includes(tag)) return false;
          // Check if element is focusable
          return el.tabIndex >= 0;
        })
        .slice(0, 10)
        .map((el) => ({
          selector: generateSelector(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          text: (el.textContent || "").trim().slice(0, 30),
        }))
  );

  for (const elem of suspectElements) {
    // Focus the element
    const handle = await page.$(elem.selector);
    if (!handle) continue;

    await handle.focus();

    // Try pressing Enter — check if something happens
    const urlBefore = page.url();
    const domBefore = await page.evaluate(() => document.body.innerHTML.length);

    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    const urlAfter = page.url();
    const domAfter = await page.evaluate(() => document.body.innerHTML.length);

    // If nothing changed, the element may not be keyboard accessible
    if (urlBefore === urlAfter && Math.abs(domBefore - domAfter) < 10) {
      issues.push(createIssue({
        rule: "keyboard-operability",
        impact: "critical",
        description: `Element with role="${elem.role}" does not respond to keyboard activation (Enter)`,
        selector: elem.selector,
        help: "All interactive elements must be operable via keyboard. WCAG 2.1.1.",
      }));
    }

    // Navigate back if URL changed
    if (urlAfter !== urlBefore) {
      await page.goBack({ waitUntil: "networkidle" }).catch(() => {});
    }
  }

  return issues;
}
```

### 5.5 Interactive Tests Entry Point

```typescript
// src/analyzer/interactive.ts

export async function runInteractiveTests(page: Page): Promise<Issue[]> {
  const results: Issue[] = [];

  try {
    results.push(...await testTabOrder(page));
  } catch (err) {
    console.warn("Tab order test failed:", err.message);
  }

  try {
    results.push(...await testFocusVisibility(page));
  } catch (err) {
    console.warn("Focus visibility test failed:", err.message);
  }

  try {
    results.push(...await testSkipNavigation(page));
  } catch (err) {
    console.warn("Skip navigation test failed:", err.message);
  }

  try {
    results.push(...await testKeyboardOperability(page));
  } catch (err) {
    console.warn("Keyboard operability test failed:", err.message);
  }

  return results;
}
```

**Key principle:** Each test is wrapped in try/catch. A failing test should never crash the audit — it logs a warning and continues. Tests return Issue[] with `checkSource: "interactive"`.

### 5.6 Issue Format for Interactive Tests

Interactive tests use the same `Issue` type as axe-core, with:
- `checkSource: "interactive"` (new value, was only `"axe"`)
- `rule`: descriptive rule ID (e.g., `"keyboard-trap"`, `"focus-indicator-missing"`)
- `help`: concise explanation with WCAG criterion reference
- `helpUrl`: link to relevant WCAG criterion
- `violationCategory`: `"interactive"` for all

---

## 6. LLM Strategy

### What stays

**Navigation discovery** (`src/discovery/nav.ts`):
- 1 LLM call per page (unless cached)
- Uses page representation (ARIA snapshot / pruned HTML / CSS heuristic)
- Single `navClient` using `kimi-k2-turbo-preview`
- Rate limited at 10 RPM via token bucket

### What's removed

- `enrichClient` (kimi-latest) — eliminated
- `enrichVisualClient` (kimi-k2.5) — eliminated
- `src/enrichment/llm.ts` — deleted
- `src/enrichment/prompts.ts` — deleted
- Screenshot capture for enrichment — deleted
- `captureScreenshots()` function — deleted
- All enrichment-related fields remain in `Issue` type but are always `null`

### Nav discovery cache

**Optimization:** Most sites have the same navigation on every page (shared header/footer). If the page representation content is identical to the previous page's, skip the LLM call and reuse cached `NavTarget[]`.

Expected impact: **~80% reduction in nav discovery LLM calls** for sites with consistent navigation.

```typescript
// In the audit loop:
if (repr.content === lastNavRepr) {
  navTargets = cachedNavTargets;  // No LLM call
} else {
  navTargets = await discoverNavTargets(url, title, repr, navClient);
  lastNavRepr = repr.content;
  cachedNavTargets = navTargets;
}
```

### Cost model (updated)

| Operation | Calls per 50 pages | Tokens | Cost |
|---|---|---|---|
| Nav discovery (with cache) | ~10 (vs 50 before) | ~800/call | ~$0.008 |
| **Total per audit** | ~10 | ~8,000 | **~$0.008** |

Previous cost per 50-page audit: ~$0.05-0.10. New cost: ~$0.008. **~90% reduction.**

---

## 7. Queue System

### PostgreSQL table

```sql
CREATE TABLE IF NOT EXISTS audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  result_path TEXT,
  error TEXT,
  pages_analyzed INTEGER DEFAULT 0,
  total_issues INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Index for worker polling
CREATE INDEX idx_audits_status_created ON audits (status, created_at)
  WHERE status = 'queued';
```

### Worker claim query

```sql
UPDATE audits
SET status = 'running', started_at = now()
WHERE id = (
  SELECT id FROM audits
  WHERE status = 'queued'
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` ensures multiple workers don't grab the same audit.

### Status transitions

```
queued → running → completed
                 → failed
queued → cancelled (via DELETE endpoint)
```

### Progress updates

During an audit, the worker periodically updates:
```sql
UPDATE audits SET pages_analyzed = $1 WHERE id = $2;
```

This allows the API server to read progress from the DB and stream via SSE.

---

## 8. SSE Progress Notifications

### API endpoint

```typescript
// src/server/routes/audits.ts

// GET /api/audits/:id/events
async function sseHandler(req: Request): Promise<Response> {
  const auditId = req.params.id;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let lastStatus = "";
      let lastPagesAnalyzed = 0;

      const interval = setInterval(async () => {
        const audit = await db.query("SELECT * FROM audits WHERE id = $1", [auditId]);
        if (!audit) {
          controller.close();
          clearInterval(interval);
          return;
        }

        // Send update if something changed
        if (audit.status !== lastStatus || audit.pages_analyzed !== lastPagesAnalyzed) {
          const event = {
            type: audit.status === "completed" ? "completed" : "progress",
            data: {
              status: audit.status,
              pagesAnalyzed: audit.pages_analyzed,
              totalIssues: audit.total_issues,
              ...(audit.status === "completed" ? { reportUrl: `/api/audits/${auditId}/report` } : {}),
              ...(audit.status === "failed" ? { error: audit.error } : {}),
            },
          };

          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          lastStatus = audit.status;
          lastPagesAnalyzed = audit.pages_analyzed;
        }

        // Close stream when audit is done
        if (audit.status === "completed" || audit.status === "failed") {
          controller.close();
          clearInterval(interval);
        }
      }, 2000);  // Poll DB every 2s for changes

      // Cleanup on client disconnect
      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

### Frontend usage

```typescript
const eventSource = new EventSource(`/api/audits/${auditId}/events`);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === "progress") {
    updateProgressUI(data.data.pagesAnalyzed);
  } else if (data.type === "completed") {
    showResults(data.data.reportUrl);
    eventSource.close();
  } else if (data.type === "error") {
    showError(data.data.error);
    eventSource.close();
  }
};

// Auto-reconnects on connection drop (built into EventSource API)
```

---

## 9. Browserless Integration

### Docker image

```yaml
browserless:
  image: ghcr.io/browserless/chromium
  restart: unless-stopped
  environment:
    - MAX_CONCURRENT_SESSIONS=2
    - CONNECTION_TIMEOUT=120000
    - TIMEOUT=120000
    - HEALTH=true
    - PREBOOT_CHROME=true
  expose:
    - "3000"
  networks:
    - coolify
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:3000/json/version"]
    interval: 30s
    timeout: 5s
    start_period: 15s
    retries: 3
```

### Connection from Worker

```typescript
import { chromium } from "playwright";

async function connectWithRetry(url: string, maxRetries = 5): Promise<Browser> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await chromium.connect(url);
    } catch (err) {
      const waitMs = Math.pow(2, attempt) * 1000;
      console.warn(`Browserless connection failed (attempt ${attempt + 1}), retrying in ${waitMs}ms`);
      await Bun.sleep(waitMs);
    }
  }
  throw new Error("Failed to connect to Browserless after max retries");
}
```

### Reconnection on disconnect

```typescript
browser.on("disconnected", async () => {
  console.warn("Browserless disconnected, reconnecting...");
  browser = await connectWithRetry(BROWSERLESS_URL);
});
```

### SSPL License compatibility

Browserless SSPL license allows:
- Self-hosting the Docker container
- Integrating with our own SaaS product
- Using it as a service within our stack

It does NOT allow:
- Offering Browserless itself as a service to others
- Modifying and distributing Browserless

Our use case (internal browser pool for our accessibility SaaS) is explicitly permitted.

---

## 10. Docker Deployment

### docker-compose.coolify.yml (updated)

```yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile.api
    restart: unless-stopped
    expose:
      - "3000"
    networks:
      - coolify
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - NODE_ENV=production
      - PORT=3000
    volumes:
      - reports:/app/reports
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.a11y-https.rule=Host(`a11y.pguerrero.me`)"
      - "traefik.http.routers.a11y-https.entrypoints=https"
      - "traefik.http.routers.a11y-https.tls=true"
      - "traefik.http.routers.a11y-https.tls.certresolver=letsencrypt"
      - "traefik.http.routers.a11y-http.rule=Host(`a11y.pguerrero.me`)"
      - "traefik.http.routers.a11y-http.entrypoints=http"
      - "traefik.http.routers.a11y-http.middlewares=a11y-redirect"
      - "traefik.http.middlewares.a11y-redirect.redirectscheme.scheme=https"
      - "traefik.http.routers.a11y-https.middlewares=a11y-auth"
      - "traefik.http.middlewares.a11y-auth.basicauth.users=ally-news:$apr1$xI68JmlP$eG.JGjXUTkMJ9YLbS.sAb0"
      - "traefik.http.services.a11y.loadbalancer.server.port=3000"
      - "traefik.docker.network=coolify"
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3

  worker:
    build:
      context: .
      dockerfile: Dockerfile.worker
    restart: unless-stopped
    networks:
      - coolify
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - LLM_API_KEY=${LLM_API_KEY}
      - LLM_API_BASE_URL=${LLM_API_BASE_URL:-https://api.moonshot.ai/v1}
      - BROWSERLESS_URL=ws://browserless:3000/chromium/playwright
      - REPORTS_DIR=/app/reports
      - NODE_ENV=production
    volumes:
      - reports:/app/reports
    depends_on:
      browserless:
        condition: service_healthy

  browserless:
    image: ghcr.io/browserless/chromium
    restart: unless-stopped
    environment:
      - MAX_CONCURRENT_SESSIONS=2
      - CONNECTION_TIMEOUT=120000
      - TIMEOUT=120000
      - HEALTH=true
      - PREBOOT_CHROME=true
    expose:
      - "3000"
    networks:
      - coolify
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/json/version"]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3

networks:
  coolify:
    external: true

volumes:
  reports:
```

### Dockerfile.api

```dockerfile
# Stage 1: Build frontend
FROM oven/bun:1 AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock* ./
RUN bun install --frozen-lockfile
COPY frontend/ .
RUN bun run build

# Stage 2: API Server (lightweight — no Playwright, no Chromium)
FROM oven/bun:1 AS production
WORKDIR /app

# Install production deps only (NO playwright)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/server/ src/server/
COPY src/types/ src/types/

# Copy built frontend
COPY --from=frontend-build /app/dist/frontend/ dist/frontend/

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/server/index.ts"]
```

### Dockerfile.worker

```dockerfile
FROM oven/bun:1
WORKDIR /app

# Install Playwright (client only — no browsers, connects to Browserless)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source (all analysis + crawler code)
COPY src/ src/

ENV NODE_ENV=production

CMD ["bun", "run", "src/worker/index.ts"]
```

**Note:** Worker Dockerfile does NOT install Chromium (`bunx playwright install chromium` is NOT needed). Playwright client connects to Browserless via WebSocket. Worker image will be ~200MB vs ~1.5GB current.

### RAM Budget

| Container | Expected RAM | Notes |
|---|---|---|
| API server | ~50MB | Bun HTTP server + static files |
| Worker | ~100MB | Bun process + Playwright client + LLM client |
| Browserless | ~400-600MB | Chromium + browser pool |
| **Total** | **~600-750MB** | vs ~900MB+ current (single monolith) |

Remaining on 4GB VPS: ~1.1GB for Coolify + other services (currently using ~1.35GB). Tight but viable.

---

## 11. Migration Guide — What Changes

### Files to DELETE

```
src/enrichment/llm.ts           — LLM enrichment (eliminated)
src/enrichment/prompts.ts       — Enrichment prompts (eliminated)
src/server/jobs/manager.ts      — Bun.spawn job manager (replaced by queue)
```

### Files to MODIFY heavily

```
src/orchestrator.ts             — Rewrite as src/worker/audit.ts (no Crawlee)
src/crawler/crawler.ts          — Extract into src/crawler/links.ts + interactions.ts
src/server/index.ts             — Remove job management, add SSE, add audit endpoints
src/types/config.ts             — Remove enrich* fields, add browserless URL
docker-compose.coolify.yml      — Split into 3 services
Dockerfile                      — Split into Dockerfile.api + Dockerfile.worker
```

### Files to CREATE

```
src/worker/index.ts             — Worker main loop
src/worker/audit.ts             — Audit orchestrator (replaces orchestrator.ts)
src/worker/db.ts                — PostgreSQL queries for audit queue
src/crawler/queue.ts            — UrlQueue class (replaces Crawlee RequestQueue)
src/crawler/links.ts            — Link extraction (replaces enqueueLinks)
src/crawler/interactions.ts     — Nav target interactions (extracted from crawler.ts)
src/analyzer/interactive.ts     — Interactive accessibility tests (NEW)
src/server/routes/audits.ts     — Audit CRUD + SSE endpoints
Dockerfile.api                  — API-only Dockerfile
Dockerfile.worker               — Worker-only Dockerfile
```

### Files UNCHANGED (reused as-is)

```
src/analyzer/axe.ts             — Axe-core wrapper
src/repr/tier.ts                — Tiered representation
src/repr/aria.ts                — ARIA snapshot
src/repr/pruned-html.ts         — Pruned HTML
src/repr/heuristic.ts           — CSS heuristic
src/discovery/nav.ts            — LLM nav discovery
src/llm/client.ts               — LLM client (only navClient used now)
src/crawler/sitemap.ts          — Sitemap discovery
src/crawler/safety.ts           — URL/action blacklists
src/reporter/shared.ts          — Shared issue detection
src/types/issue.ts              — Issue types (add "interactive" to checkSource)
src/types/page.ts               — Page types
src/types/report.ts             — Report types
```

### Dependencies

**Remove:**
```
crawlee                         — Replaced by direct Playwright
```

**Keep:**
```
playwright                      — Now connects to Browserless instead of local Chromium
@axe-core/playwright            — Unchanged
openai                          — For nav discovery LLM calls
```

**Add:**
```
(none — PostgreSQL via Bun.sql, SSE via native Response streams)
```

### Database migration

Add `audits` table to existing PostgreSQL (shared via Coolify network):

```sql
CREATE TABLE IF NOT EXISTS audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  result_path TEXT,
  error TEXT,
  pages_analyzed INTEGER DEFAULT 0,
  total_issues INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_audits_status_created
  ON audits (status, created_at)
  WHERE status = 'queued';
```

---

## 12. Data Types

### Updated CheckSource

```typescript
// src/types/issue.ts
export type CheckSource = "axe" | "interactive";  // was: "axe" | "llm"
```

### Updated CrawlConfig

```typescript
// src/types/config.ts
export interface CrawlConfig {
  baseUrl: string;
  apiKey: string;                    // LLM API key
  apiBaseUrl: string;                // LLM API base URL
  navModel: string;                  // Only nav model now (was 3 models)
  maxPages: number;
  maxDepth: number;
  pageTimeout: number;               // ms
  wcagLevel: "A" | "AA" | "AAA";
  skipSitemap: boolean;
  excludePatterns: string[];
  rateLimitRpm: number;
  maxNavTargets: number;
  // REMOVED: enrichModel, enrichVisualModel, enrichImpactThreshold, concurrency
}
```

### Audit record (new)

```typescript
// src/worker/db.ts
export interface AuditRecord {
  id: string;
  url: string;
  config: Partial<CrawlConfig>;
  status: "queued" | "running" | "completed" | "failed";
  resultPath: string | null;
  error: string | null;
  pagesAnalyzed: number;
  totalIssues: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}
```

---

## 13. File Structure

```
src/
  server/                           # API Server
    index.ts                        # Bun.serve() entry point
    routes/
      audits.ts                     # Audit CRUD + SSE endpoints
      health.ts                     # Health check
    db.ts                           # PostgreSQL connection + queries

  worker/                           # Worker (NEW)
    index.ts                        # Main loop — poll queue, run audits
    audit.ts                        # Audit orchestrator (replaces orchestrator.ts)
    db.ts                           # PostgreSQL queries for queue
    progress.ts                     # Progress emission (updates DB)

  analyzer/                         # Accessibility Analysis
    axe.ts                          # Axe-core wrapper (unchanged)
    interactive.ts                  # Interactive tests (NEW)
    category.ts                     # Violation category mapping (unchanged)

  crawler/                          # Crawling Infrastructure
    queue.ts                        # UrlQueue class (NEW, replaces Crawlee)
    links.ts                        # Link extraction (NEW, replaces enqueueLinks)
    interactions.ts                 # Nav target interactions (extracted)
    sitemap.ts                      # Sitemap discovery (unchanged)
    safety.ts                       # Blacklists (unchanged)

  repr/                             # Page Representation (unchanged)
    tier.ts
    aria.ts
    pruned-html.ts
    heuristic.ts

  discovery/                        # LLM Navigation (unchanged)
    nav.ts

  llm/                              # LLM Client (unchanged)
    client.ts

  reporter/                         # Report Generation
    shared.ts                       # Shared issue detection (unchanged)
    pdf.ts                          # PDF generation (unchanged)

  types/                            # TypeScript Types
    config.ts                       # CrawlConfig (updated)
    issue.ts                        # Issue types (checkSource updated)
    page.ts                         # Page types (unchanged)
    report.ts                       # Report types (unchanged)

frontend/                           # React frontend (update to use SSE)

Dockerfile.api                      # API server only (no Playwright)
Dockerfile.worker                   # Worker only (Playwright client, no Chromium)
docker-compose.coolify.yml          # 3 services: api, worker, browserless
```

---

## 14. Performance Estimates

### Per page

| Phase | Current (v2) | New (v3) | Change |
|---|---|---|---|
| Navigate + networkidle | 5-30s | 5-30s | Same |
| Axe-core | 2-5s | 2-5s | Same |
| Interactive tests | N/A | 5-10s | **New** |
| Page representation | 1-2s | 1-2s | Same |
| LLM nav discovery | 3-10s | 0-10s | **Cached ~80%** |
| Link extraction | <0.5s | <0.5s | Same |
| Nav interactions | 3-10s | 3-10s | Same |
| LLM enrichment | **10-60s** | **0s** | **Eliminated** |
| Screenshots | 2-5s | 0s | **Eliminated** |
| **Total** | **25-120s** | **15-65s** | **~40-50% faster** |

### Per audit (50 pages)

| Metric | Current (v2) | New (v3) |
|---|---|---|
| Total time | 20-100 min | 12-55 min |
| Worker RAM | ~900MB | ~100MB |
| LLM calls | ~100 (50 nav + 50 enrich) | ~10 (nav with cache) |
| LLM cost | ~$0.05-0.10 | ~$0.008 |
| Browser RAM | In worker | In Browserless (~500MB) |

### Concurrent audits

| Workers | Audits/hour (est.) | Total RAM |
|---|---|---|
| 1 | 1-3 | ~650MB |
| 2 | 2-6 | ~750MB (shared Browserless) |
| 3+ | 3-9+ | Requires larger VPS or second server |

---

## 15. Future: Autofix Phase

Based on the University of Malaga paper (documented in `docs/research/web-page-representation-for-llm-agents.md`), autofix could be a premium SaaS feature.

**Concept:** After audit completes, user can click "Generate fixes" on specific issues. The system generates corrected HTML using the same approach as the Malaga paper:
1. Extract the violating HTML fragment
2. Send to LLM with specialized prompt per violation category
3. Return corrected HTML for the user to copy/apply

**Why separate from audit:**
- Computationally expensive (LLM calls per issue)
- Only valuable for users who want to fix (not just audit)
- Can be behind a premium plan tier
- Does not slow down the audit itself

**Not in scope for v3.** Mentioned here so the architecture doesn't preclude it.

---

## Appendix: Decision Log

| Decision | Options Considered | Choice | Rationale |
|---|---|---|---|
| Queue technology | Redis/BullMQ, PostgreSQL, SQLite | PostgreSQL | Already available, volume doesn't justify new dependency |
| Progress notification | WebSocket, SSE, Polling | SSE | One-way (server→client), simpler than WS, auto-reconnect, works through Traefik |
| Browser management | Local Chromium, Browserless self-hosted, Browserless cloud | Browserless self-hosted | 0 Chromium in worker, battle-tested pool management, SSPL compatible |
| Crawl framework | Keep Crawlee, direct Playwright | Direct Playwright | Crawlee added overhead (memory auto-scaling) without proportional value; most discovery code was already custom |
| LLM enrichment | Keep, batch, eliminate | Eliminate (for now) | Low value over axe-core help text; autofix deferred to future premium feature |
| Runtime | Bun for all, Node.js for worker | Bun for all | All existing code is Bun/TS, Playwright works via remote connection |
| Interactive tests | Playwright-based, axe-core extensions | Playwright-based | axe-core cannot test interaction (tab, keyboard); Playwright is already available |
