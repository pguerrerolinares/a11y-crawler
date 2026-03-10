# V3 Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate from Crawlee monolith to API Server + Worker + Browserless architecture, add interactive accessibility tests, eliminate LLM enrichment.

**Architecture:** API server (Bun.serve, serves frontend + REST + SSE) → PostgreSQL queue (existing DB) → Worker process (polls queue, connects to Browserless via WebSocket, runs audit pipeline) → Browserless sidecar (Chromium pool).

**Tech Stack:** Bun runtime, Playwright (remote via Browserless), PostgreSQL (Bun.sql), axe-core, OpenAI SDK (Moonshot), SSE, Docker.

**Design doc:** `docs/plans/2026-03-10-v3-architecture-design.md` — read this FIRST for full context.

**IMPORTANT CONTEXT for the implementing agent:**
- The project uses Bun, NOT Node.js. Use `bun test`, `bun run`, `Bun.sql`, etc.
- The DB already has tables: `audits`, `pages`, `issues`, `shared_issues`, `audit_events`, `request_logs`
- The DB uses Bun's built-in `SQL` class (Postgres), NOT an ORM. See `src/server/db/client.ts`.
- Current audit statuses in schema: `pending`, `running`, `completed`, `failed`
- Current `audit_events` table already stores progress events (used by WebSocket)
- Current job system uses `Bun.spawn()` child processes — see `src/server/jobs/manager.ts`
- Current crawler worker is `src/crawler/worker.ts` (spawned as subprocess)
- All existing analysis code (axe, repr, nav discovery, safety, sitemap) works fine and should be reused as-is
- CLAUDE.md says: use Bun for everything, `Bun.serve()` for HTTP, `Bun.sql` for Postgres

---

## Phase 1: Core Modules (No Breaking Changes)

These tasks create new modules that don't affect the existing system. They can be built and tested independently.

---

### Task 1: URL Queue Class

Replaces Crawlee's `RequestQueue`. Simple in-memory queue with deduplication.

**Files:**
- Create: `src/crawler/queue.ts`
- Create: `src/crawler/__tests__/queue.test.ts`

**Step 1: Write the tests**

```typescript
// src/crawler/__tests__/queue.test.ts
import { test, expect, describe, beforeEach } from "bun:test";
import { UrlQueue } from "../queue.ts";

describe("UrlQueue", () => {
  let queue: UrlQueue;

  beforeEach(() => {
    queue = new UrlQueue(10);
  });

  test("seed and consume URLs in FIFO order", () => {
    queue.seed(["https://example.com/a", "https://example.com/b"], "link");
    expect(queue.next()).toBe("https://example.com/a");
    expect(queue.next()).toBe("https://example.com/b");
    expect(queue.next()).toBeNull();
  });

  test("deduplicates URLs", () => {
    queue.seed(["https://example.com/a", "https://example.com/a"], "link");
    expect(queue.next()).toBe("https://example.com/a");
    expect(queue.next()).toBeNull();
  });

  test("normalizes URLs — trailing slash", () => {
    queue.seed(["https://example.com/page/"], "link");
    expect(queue.next()).toBe("https://example.com/page");
  });

  test("normalizes URLs — strips hash", () => {
    queue.seed(["https://example.com/page#section"], "link");
    expect(queue.next()).toBe("https://example.com/page");
  });

  test("normalizes URLs — sorts query params", () => {
    queue.seed(["https://example.com/page?b=2&a=1"], "link");
    expect(queue.next()).toBe("https://example.com/page?a=1&b=2");
  });

  test("respects maxPages limit", () => {
    const small = new UrlQueue(2);
    small.seed(["https://example.com/a", "https://example.com/b", "https://example.com/c"], "link");
    expect(small.next()).toBe("https://example.com/a");
    expect(small.next()).toBe("https://example.com/b");
    expect(small.next()).toBeNull(); // maxPages reached
  });

  test("does not revisit consumed URLs", () => {
    queue.seed(["https://example.com/a"], "link");
    expect(queue.next()).toBe("https://example.com/a");
    queue.seed(["https://example.com/a"], "interaction"); // re-seed same URL
    expect(queue.next()).toBeNull(); // already visited
  });

  test("tracks discovery origin", () => {
    queue.seed(["https://example.com/a"], "sitemap");
    queue.seed(["https://example.com/b"], "link");
    queue.seed(["https://example.com/c"], "interaction");
    const stats = queue.stats;
    expect(stats.byOrigin.sitemap).toBe(1);
    expect(stats.byOrigin.link).toBe(1);
    expect(stats.byOrigin.interaction).toBe(1);
    expect(stats.totalDiscovered).toBe(3);
  });

  test("stats reflect visited and pending counts", () => {
    queue.seed(["https://example.com/a", "https://example.com/b"], "link");
    queue.next(); // visit a
    const stats = queue.stats;
    expect(stats.totalVisited).toBe(1);
    expect(stats.pendingCount).toBe(1);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/crawler/__tests__/queue.test.ts
```
Expected: FAIL — `UrlQueue` not found.

**Step 3: Implement UrlQueue**

```typescript
// src/crawler/queue.ts

export type UrlOrigin = "link" | "sitemap" | "interaction";

export class UrlQueue {
  private pending: string[] = [];
  private visited = new Set<string>();
  private discovered = new Map<string, UrlOrigin>();

  constructor(private maxPages: number) {}

  seed(urls: string[], origin: UrlOrigin): void {
    for (const url of urls) {
      const normalized = this.normalize(url);
      if (normalized && !this.discovered.has(normalized)) {
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
      pendingCount: this.pending.filter((u) => !this.visited.has(u)).length,
      byOrigin: {
        sitemap: [...this.discovered.values()].filter((v) => v === "sitemap").length,
        link: [...this.discovered.values()].filter((v) => v === "link").length,
        interaction: [...this.discovered.values()].filter((v) => v === "interaction").length,
      },
    };
  }

  private normalize(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
        parsed.pathname = parsed.pathname.slice(0, -1);
      }
      parsed.hash = "";
      parsed.searchParams.sort();
      return parsed.href;
    } catch {
      return null;
    }
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
bun test src/crawler/__tests__/queue.test.ts
```
Expected: ALL PASS.

**Step 5: Commit**

```bash
git add src/crawler/queue.ts src/crawler/__tests__/queue.test.ts
git commit -m "feat: add UrlQueue class replacing Crawlee's RequestQueue"
```

---

### Task 2: Link Extraction Module

Replaces Crawlee's `enqueueLinks()`. Extracts same-origin `<a href>` links from rendered DOM.

**Files:**
- Create: `src/crawler/links.ts`
- Create: `src/crawler/__tests__/links.test.ts`
- Read: `src/crawler/safety.ts` — reuse `isBlacklistedUrl()`

**Step 1: Write the tests**

```typescript
// src/crawler/__tests__/links.test.ts
import { test, expect, describe } from "bun:test";
import { filterLinks } from "../links.ts";

describe("filterLinks", () => {
  const baseOrigin = "https://example.com";

  test("keeps same-origin links", () => {
    const links = ["https://example.com/about", "https://example.com/contact"];
    expect(filterLinks(links, baseOrigin)).toEqual(links);
  });

  test("rejects cross-origin links", () => {
    const links = ["https://other.com/page", "https://example.com/about"];
    expect(filterLinks(links, baseOrigin)).toEqual(["https://example.com/about"]);
  });

  test("rejects blacklisted URLs (files, mailto, etc.)", () => {
    const links = [
      "https://example.com/file.pdf",
      "https://example.com/image.jpg",
      "mailto:test@example.com",
      "https://example.com/valid-page",
    ];
    expect(filterLinks(links, baseOrigin)).toEqual(["https://example.com/valid-page"]);
  });

  test("rejects invalid URLs gracefully", () => {
    const links = ["not-a-url", "", "https://example.com/valid"];
    expect(filterLinks(links, baseOrigin)).toEqual(["https://example.com/valid"]);
  });

  test("handles empty array", () => {
    expect(filterLinks([], baseOrigin)).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/crawler/__tests__/links.test.ts
```
Expected: FAIL — `filterLinks` not found.

**Step 3: Implement link extraction**

```typescript
// src/crawler/links.ts
import type { Page } from "playwright";
import { isBlacklistedUrl } from "./safety.ts";

/**
 * Extract all same-origin <a href> links from the current page DOM.
 * Runs in the browser context on the fully rendered page.
 */
export async function extractLinks(page: Page, baseOrigin: string): Promise<string[]> {
  const hrefs: string[] = await page.$$eval("a[href]", (anchors) =>
    anchors
      .map((a) => {
        try {
          return new URL(a.href).href;
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );

  return filterLinks(hrefs, baseOrigin);
}

/**
 * Filter links to same-origin, non-blacklisted URLs.
 * Exported separately for unit testing without a browser.
 */
export function filterLinks(hrefs: string[], baseOrigin: string): string[] {
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

**Step 4: Run tests to verify they pass**

```bash
bun test src/crawler/__tests__/links.test.ts
```
Expected: ALL PASS.

**Step 5: Commit**

```bash
git add src/crawler/links.ts src/crawler/__tests__/links.test.ts
git commit -m "feat: add link extraction module replacing Crawlee enqueueLinks"
```

---

### Task 3: Nav Interactions Module

Extract the nav target interaction logic from `src/crawler/crawler.ts` into its own module. This code already exists — it's a refactor extraction.

**Files:**
- Create: `src/crawler/interactions.ts`
- Read: `src/crawler/crawler.ts:102-151` — source of the interaction logic
- Read: `src/crawler/safety.ts` — reuse `isBlacklistedAction`, `isBlacklistedUrl`

**Step 1: Implement interactions module**

Extract the interaction loop from `crawler.ts` lines 102-151 into a standalone function.

```typescript
// src/crawler/interactions.ts
import type { Page } from "playwright";
import type { NavTarget } from "../types/page.ts";
import type { CrawlConfig } from "../types/config.ts";
import { isBlacklistedAction, isBlacklistedUrl } from "./safety.ts";

export interface InteractionResult {
  discoveredUrls: string[];
  navigated: boolean;
}

/**
 * Click nav targets discovered by LLM, extract newly revealed URLs.
 * Returns discovered URLs with origin "interaction".
 *
 * Stops interactions if a click causes navigation (URL change).
 */
export async function interactWithTargets(
  page: Page,
  targets: NavTarget[],
  config: Pick<CrawlConfig, "maxNavTargets">,
  baseOrigin: string,
): Promise<string[]> {
  const discoveredUrls: string[] = [];

  for (const target of targets.slice(0, config.maxNavTargets)) {
    if (isBlacklistedAction(target.description)) continue;

    try {
      const elementCount = await page.locator(target.selector).count().catch(() => 0);
      if (elementCount === 0 || elementCount > 5) continue;

      const urlBefore = page.url();
      await page.locator(target.selector).click({ timeout: 3000 });
      await page.waitForTimeout(300);
      const urlAfter = page.url();

      if (urlAfter !== urlBefore) {
        // Navigation occurred — record URL, stop interactions
        try {
          const newUrl = new URL(urlAfter);
          if (newUrl.origin === baseOrigin && !isBlacklistedUrl(urlAfter)) {
            discoveredUrls.push(urlAfter);
          }
        } catch {}
        break;
      } else {
        // No navigation — scan for newly revealed links
        const newLinks = await page.$$eval("a[href]", (anchors) =>
          anchors.map((a) => {
            try { return new URL(a.href).href; } catch { return ""; }
          }).filter(Boolean),
        );

        for (const link of newLinks) {
          try {
            const url = new URL(link);
            if (url.origin === baseOrigin && !isBlacklistedUrl(link)) {
              discoveredUrls.push(link);
            }
          } catch {}
        }
      }
    } catch {
      // Interaction failed — continue to next target
    }
  }

  return discoveredUrls;
}
```

**Step 2: Commit**

No separate test file needed — this is an extraction of tested logic. It will be integration-tested via the worker audit pipeline.

```bash
git add src/crawler/interactions.ts
git commit -m "refactor: extract nav interactions into standalone module"
```

---

### Task 4: Interactive Accessibility Tests

New module that runs Playwright-based accessibility tests for tab order, focus visibility, keyboard traps, skip navigation, and keyboard operability.

**Files:**
- Create: `src/analyzer/interactive.ts`
- Create: `src/analyzer/__tests__/interactive.test.ts`
- Modify: `src/types/issue.ts` — add `"interactive"` to `CheckSource`

**Step 1: Update CheckSource type**

```typescript
// src/types/issue.ts — change:
export type CheckSource = "axe" | "llm";
// to:
export type CheckSource = "axe" | "llm" | "interactive";
```

**Step 2: Implement interactive tests**

This is a large file. Refer to the design doc Section 5 for the full implementation. The key functions are:

```typescript
// src/analyzer/interactive.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue.ts";

/**
 * Run all interactive accessibility tests on a page.
 * Each test is isolated — failures in one don't affect others.
 */
export async function runInteractiveTests(page: Page, pageUrl: string): Promise<Issue[]> {
  const results: Issue[] = [];

  const tests = [
    testTabOrder,
    testFocusVisibility,
    testSkipNavigation,
    testKeyboardOperability,
  ];

  for (const testFn of tests) {
    try {
      const issues = await testFn(page, pageUrl);
      results.push(...issues);
    } catch (err) {
      console.warn(`Interactive test ${testFn.name} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return results;
}

// --- Helper ---

function createInteractiveIssue(opts: {
  url: string;
  rule: string;
  impact: "critical" | "serious" | "moderate" | "minor";
  description: string;
  selector: string;
  help: string;
  wcagCriterion: string;
}): Issue {
  const hash = Bun.hash(opts.url + opts.selector + opts.rule).toString(16).slice(0, 8);
  return {
    id: `interactive-${opts.rule}-${hash}`,
    url: opts.url,
    rule: opts.rule,
    impact: opts.impact,
    description: opts.description,
    help: opts.help,
    helpUrl: `https://www.w3.org/WAI/WCAG22/Understanding/${opts.wcagCriterion}`,
    wcagTags: [opts.wcagCriterion],
    selector: opts.selector,
    html: "",
    surroundingHtml: "",
    xpath: "",
    viewportWidth: 1280,
    pageTitle: "",
    checkSource: "interactive",
    suggestedFix: null,
    fixConfidence: null,
    violationCategory: "interactive",
    llmConfidence: null,
    wcagCriterion: opts.wcagCriterion,
  };
}

// --- Tab Order Test ---

async function testTabOrder(page: Page, pageUrl: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const focusSequence: Array<{ selector: string; tabindex: string | null; isVisible: boolean }> = [];
  const MAX_TABS = 50;

  // Start from body to reset focus
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.());

  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press("Tab");

    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const rect = el.getBoundingClientRect();

      // Generate a basic CSS selector
      let selector = el.tagName.toLowerCase();
      if (el.id) selector = `#${el.id}`;
      else if (el.className && typeof el.className === "string") {
        const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".");
        if (cls) selector = `${el.tagName.toLowerCase()}.${cls}`;
      }

      return {
        selector,
        tabindex: el.getAttribute("tabindex"),
        isVisible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < window.innerHeight,
        text: (el.textContent || "").trim().slice(0, 30),
      };
    });

    if (!focused) continue;

    // Positive tabindex disrupts natural order
    if (focused.tabindex && parseInt(focused.tabindex) > 0) {
      issues.push(createInteractiveIssue({
        url: pageUrl,
        rule: "tabindex-positive",
        impact: "serious",
        description: `Element has tabindex="${focused.tabindex}" which disrupts natural tab order`,
        selector: focused.selector,
        help: "Avoid tabindex values greater than 0. Use tabindex='0' or '-1' instead.",
        wcagCriterion: "focus-order",
      }));
    }

    // Focus on invisible element
    if (!focused.isVisible) {
      issues.push(createInteractiveIssue({
        url: pageUrl,
        rule: "focus-not-visible",
        impact: "serious",
        description: `Focus moved to non-visible element: ${focused.selector}`,
        selector: focused.selector,
        help: "All focusable elements should be visible when focused.",
        wcagCriterion: "focus-visible",
      }));
    }

    focusSequence.push(focused);

    // Detect keyboard trap — same 3 elements cycling
    if (focusSequence.length >= 6) {
      const last3 = focusSequence.slice(-3).map((f) => f.selector);
      const prev3 = focusSequence.slice(-6, -3).map((f) => f.selector);
      if (JSON.stringify(last3) === JSON.stringify(prev3)) {
        issues.push(createInteractiveIssue({
          url: pageUrl,
          rule: "keyboard-trap",
          impact: "critical",
          description: `Keyboard trap detected: focus cycles between ${[...new Set(last3)].join(", ")}`,
          selector: last3[0],
          help: "Users must be able to navigate away from all components using keyboard.",
          wcagCriterion: "no-keyboard-trap",
        }));
        break;
      }
    }
  }

  return issues;
}

// --- Focus Visibility Test ---

async function testFocusVisibility(page: Page, pageUrl: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const SAMPLE_LIMIT = 15;

  const elements = await page.$$(
    'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex="0"]',
  );
  const sample = elements.slice(0, SAMPLE_LIMIT);

  for (const el of sample) {
    try {
      // Get styles before focus
      const before = await el.evaluate((e) => {
        const cs = getComputedStyle(e);
        return { outline: cs.outline, boxShadow: cs.boxShadow, border: cs.border };
      });

      await el.focus();

      // Get styles after focus
      const after = await el.evaluate((e) => {
        const cs = getComputedStyle(e);
        return { outline: cs.outline, boxShadow: cs.boxShadow, border: cs.border };
      });

      const noChange =
        before.outline === after.outline &&
        before.boxShadow === after.boxShadow &&
        before.border === after.border;

      const outlineRemoved =
        after.outline.includes("none") || after.outline.includes("0px");

      if (noChange || outlineRemoved) {
        const selector = await el.evaluate((e) => {
          if (e.id) return `#${e.id}`;
          const tag = e.tagName.toLowerCase();
          if (e.className && typeof e.className === "string") {
            const cls = e.className.trim().split(/\s+/).slice(0, 2).join(".");
            if (cls) return `${tag}.${cls}`;
          }
          return tag;
        });

        issues.push(createInteractiveIssue({
          url: pageUrl,
          rule: "focus-indicator-missing",
          impact: "serious",
          description: `Element "${selector}" has no visible focus indicator`,
          selector,
          help: "Interactive elements must have a visible focus indicator when focused.",
          wcagCriterion: "focus-visible",
        }));
      }
    } catch {
      // Element may have been removed from DOM — skip
    }
  }

  return issues;
}

// --- Skip Navigation Test ---

async function testSkipNavigation(page: Page, pageUrl: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Check for skip link existence
  const skipLink = await page.$(
    'a[href^="#"]:first-of-type, a.skip-link, a.skip-nav, a[class*="skip"]',
  );

  if (!skipLink) {
    // Check if there's significant content before main
    const hasNav = await page.$("nav, [role='navigation']");
    if (hasNav) {
      issues.push(createInteractiveIssue({
        url: pageUrl,
        rule: "skip-navigation-missing",
        impact: "moderate",
        description: "Page has navigation but no skip navigation link",
        selector: "body",
        help: "Provide a mechanism to bypass repeated blocks of content.",
        wcagCriterion: "bypass-blocks",
      }));
    }
  } else {
    // Verify skip link target exists
    const href = await skipLink.evaluate((el) => el.getAttribute("href"));
    if (href && href.startsWith("#") && href.length > 1) {
      const targetId = href.slice(1);
      const targetExists = await page.$(`[id="${targetId}"]`);
      if (!targetExists) {
        issues.push(createInteractiveIssue({
          url: pageUrl,
          rule: "skip-navigation-broken",
          impact: "serious",
          description: `Skip link points to #${targetId} but target element does not exist`,
          selector: `a[href="${href}"]`,
          help: "Skip navigation link target must exist on the page.",
          wcagCriterion: "bypass-blocks",
        }));
      }
    }
  }

  return issues;
}

// --- Keyboard Operability Test ---

async function testKeyboardOperability(page: Page, pageUrl: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Find custom interactive elements (non-native) that should be keyboard accessible
  const suspects = await page.$$eval(
    '[role="button"], [role="tab"], [role="menuitem"], [role="link"], [onclick]',
    (elements) =>
      elements
        .filter((el) => {
          const tag = el.tagName.toLowerCase();
          // Skip native interactive elements — already keyboard accessible
          return !["a", "button", "input", "select", "textarea", "summary"].includes(tag);
        })
        .slice(0, 8)
        .map((el) => {
          let selector = el.tagName.toLowerCase();
          if (el.id) selector = `#${el.id}`;
          else if (el.className && typeof el.className === "string") {
            const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".");
            if (cls) selector = `${el.tagName.toLowerCase()}.${cls}`;
          }
          return {
            selector,
            role: el.getAttribute("role"),
            tabindex: el.getAttribute("tabindex"),
          };
        }),
  );

  for (const suspect of suspects) {
    // Not focusable at all — critical issue
    if (suspect.tabindex === null || parseInt(suspect.tabindex) < 0) {
      issues.push(createInteractiveIssue({
        url: pageUrl,
        rule: "custom-element-not-focusable",
        impact: "critical",
        description: `Custom ${suspect.role || "interactive"} element is not keyboard focusable`,
        selector: suspect.selector,
        help: "Custom interactive elements must be focusable via tabindex='0'.",
        wcagCriterion: "keyboard",
      }));
      continue;
    }

    // Focusable — test if Enter/Space triggers it
    try {
      const handle = await page.$(suspect.selector);
      if (!handle) continue;

      await handle.focus();
      const domBefore = await page.evaluate(() => document.body.innerHTML.length);
      const urlBefore = page.url();

      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);

      const domAfter = await page.evaluate(() => document.body.innerHTML.length);
      const urlAfter = page.url();

      if (urlBefore === urlAfter && Math.abs(domBefore - domAfter) < 10) {
        issues.push(createInteractiveIssue({
          url: pageUrl,
          rule: "keyboard-operability",
          impact: "critical",
          description: `Element with role="${suspect.role}" does not respond to keyboard activation`,
          selector: suspect.selector,
          help: "All interactive elements must be operable via keyboard (Enter/Space).",
          wcagCriterion: "keyboard",
        }));
      }

      // Navigate back if URL changed
      if (urlAfter !== urlBefore) {
        await page.goBack({ waitUntil: "networkidle", timeout: 5000 }).catch(() => {});
      }
    } catch {
      // Element interaction failed — skip
    }
  }

  return issues;
}
```

**Note:** Full unit tests for interactive tests require a browser, so they are better tested via integration tests in Task 9. For now, write a basic structure test:

```typescript
// src/analyzer/__tests__/interactive.test.ts
import { test, expect } from "bun:test";
import { runInteractiveTests } from "../interactive.ts";

test("runInteractiveTests is exported and is a function", () => {
  expect(typeof runInteractiveTests).toBe("function");
});
```

**Step 3: Run tests**

```bash
bun test src/analyzer/__tests__/interactive.test.ts
```
Expected: PASS.

**Step 4: Commit**

```bash
git add src/analyzer/interactive.ts src/analyzer/__tests__/interactive.test.ts src/types/issue.ts
git commit -m "feat: add interactive accessibility tests — tab order, focus, keyboard traps, skip nav"
```

---

## Phase 2: Worker Process

Build the standalone worker that polls the DB and runs audits via Browserless.

---

### Task 5: Worker DB Module

Database queries for the worker to claim and update audits.

**Files:**
- Create: `src/worker/db.ts`

**Step 1: Implement worker DB module**

```typescript
// src/worker/db.ts
import { SQL } from "bun";

let db: InstanceType<typeof SQL>;

export function initWorkerDb(): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  db = new SQL(url);
}

export function getWorkerDb() {
  if (!db) throw new Error("Worker DB not initialized. Call initWorkerDb() first.");
  return db;
}

export interface AuditJob {
  id: string;
  url: string;
  config: Record<string, unknown>;
}

/**
 * Claim the next queued audit atomically.
 * Uses FOR UPDATE SKIP LOCKED to support multiple workers.
 */
export async function claimNextAudit(): Promise<AuditJob | null> {
  const rows = await db`
    UPDATE audits
    SET status = 'running', started_at = now()
    WHERE id = (
      SELECT id FROM audits
      WHERE status = 'pending'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, url, config
  `;

  if (rows.length === 0) return null;

  return {
    id: rows[0].id,
    url: rows[0].url,
    config: typeof rows[0].config === "string" ? JSON.parse(rows[0].config) : rows[0].config,
  };
}

/**
 * Update audit progress (pages analyzed count).
 */
export async function updateAuditProgress(auditId: string, pagesAnalyzed: number): Promise<void> {
  await db`
    UPDATE audits SET summary = jsonb_set(
      COALESCE(summary, '{}'::jsonb),
      '{pagesAnalyzed}',
      ${pagesAnalyzed}::text::jsonb
    )
    WHERE id = ${auditId}
  `;
}

/**
 * Emit an audit event for SSE consumers.
 */
export async function emitAuditEvent(
  auditId: string,
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db`
    INSERT INTO audit_events (audit_id, event_type, data)
    VALUES (${auditId}, ${eventType}, ${JSON.stringify(data)})
  `;
}

/**
 * Mark audit as completed with summary data.
 */
export async function markAuditCompleted(
  auditId: string,
  summary: Record<string, unknown>,
  discovery: Record<string, unknown>,
  llmUsage: Record<string, unknown>,
  durationSeconds: number,
): Promise<void> {
  await db`
    UPDATE audits
    SET status = 'completed',
        finished_at = now(),
        summary = ${JSON.stringify(summary)},
        discovery = ${JSON.stringify(discovery)},
        llm_usage = ${JSON.stringify(llmUsage)},
        duration_seconds = ${durationSeconds}
    WHERE id = ${auditId}
  `;
}

/**
 * Mark audit as failed.
 */
export async function markAuditFailed(auditId: string, error: string): Promise<void> {
  await db`
    UPDATE audits
    SET status = 'failed', finished_at = now(), error = ${error}
    WHERE id = ${auditId}
  `;
}

/**
 * Insert a page result.
 */
export async function insertPage(
  auditId: string,
  page: {
    url: string;
    title: string;
    issueCount: number;
    issuesByImpact: Record<string, number>;
    durationMs: number;
  },
): Promise<string> {
  const rows = await db`
    INSERT INTO pages (audit_id, url, title, issue_count, issues_by_impact, duration_ms)
    VALUES (
      ${auditId},
      ${page.url},
      ${page.title},
      ${page.issueCount},
      ${JSON.stringify(page.issuesByImpact)},
      ${page.durationMs}
    )
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * Insert issues for a page.
 */
export async function insertIssues(
  auditId: string,
  pageId: string,
  issues: Array<{
    rule: string;
    impact: string;
    description: string;
    help: string;
    helpUrl: string;
    wcagTags: string[];
    selector: string;
    html: string;
    xpath: string;
    checkSource: string;
    category: string;
    suggestedFix: string | null;
    fixConfidence: string | null;
  }>,
): Promise<void> {
  if (issues.length === 0) return;

  for (const issue of issues) {
    await db`
      INSERT INTO issues (
        audit_id, page_id, rule, impact, description, help, help_url,
        wcag_tags, selector, html, xpath, check_source, category,
        suggested_fix, fix_confidence
      )
      VALUES (
        ${auditId}, ${pageId}, ${issue.rule}, ${issue.impact},
        ${issue.description}, ${issue.help}, ${issue.helpUrl},
        ${JSON.stringify(issue.wcagTags)}, ${issue.selector}, ${issue.html},
        ${issue.xpath}, ${issue.checkSource}, ${issue.category},
        ${issue.suggestedFix}, ${issue.fixConfidence}
      )
    `;
  }
}

/**
 * Insert shared issues for an audit.
 */
export async function insertSharedIssues(
  auditId: string,
  sharedIssues: Array<{
    rule: string;
    impact: string;
    normalizedHtml: string;
    pageCount: number;
    pageUrls: string[];
    suggestedFix: string | null;
    category: string;
  }>,
): Promise<void> {
  for (const si of sharedIssues) {
    await db`
      INSERT INTO shared_issues (
        audit_id, rule, impact, normalized_html, page_count,
        page_urls, suggested_fix, category
      )
      VALUES (
        ${auditId}, ${si.rule}, ${si.impact}, ${si.normalizedHtml},
        ${si.pageCount}, ${JSON.stringify(si.pageUrls)},
        ${si.suggestedFix}, ${si.category}
      )
    `;
  }
}
```

**Step 2: Commit**

```bash
git add src/worker/db.ts
git commit -m "feat: add worker DB module for audit queue management"
```

---

### Task 6: Worker Audit Orchestrator

The core audit pipeline — replaces `src/orchestrator.ts`. Processes URLs one by one using direct Playwright.

**Files:**
- Create: `src/worker/audit.ts`
- Read: `src/orchestrator.ts` — reference for structure
- Reuses: `src/analyzer/axe.ts`, `src/analyzer/interactive.ts`, `src/repr/tier.ts`, `src/discovery/nav.ts`, `src/crawler/sitemap.ts`, `src/crawler/links.ts`, `src/crawler/interactions.ts`, `src/crawler/queue.ts`, `src/reporter/shared.ts`, `src/llm/client.ts`

**Step 1: Implement audit orchestrator**

```typescript
// src/worker/audit.ts
import type { Browser } from "playwright";
import type { PageResult } from "../types/page.ts";
import type { Issue, ImpactLevel, ViolationCategory } from "../types/issue.ts";
import type { CrawlError } from "../types/report.ts";
import type { NavTarget } from "../types/page.ts";
import { LLMClient } from "../llm/client.ts";
import { UrlQueue } from "../crawler/queue.ts";
import { extractLinks } from "../crawler/links.ts";
import { interactWithTargets } from "../crawler/interactions.ts";
import { discoverSitemapUrls } from "../crawler/sitemap.ts";
import { runAxe } from "../analyzer/axe.ts";
import { runInteractiveTests } from "../analyzer/interactive.ts";
import { buildRepresentation } from "../repr/tier.ts";
import { discoverNavTargets } from "../discovery/nav.ts";
import { detectSharedIssues } from "../reporter/shared.ts";
import {
  emitAuditEvent,
  insertPage,
  insertIssues,
  insertSharedIssues,
  markAuditCompleted,
} from "./db.ts";

export interface AuditConfig {
  baseUrl: string;
  apiKey: string;
  apiBaseUrl: string;
  navModel: string;
  maxPages: number;
  maxDepth: number;
  pageTimeout: number;
  wcagLevel: "A" | "AA" | "AAA";
  skipSitemap: boolean;
  excludePatterns: string[];
  rateLimitRpm: number;
  maxNavTargets: number;
}

const DEFAULT_AUDIT_CONFIG: Omit<AuditConfig, "baseUrl" | "apiKey"> = {
  apiBaseUrl: "https://api.moonshot.ai/v1",
  navModel: "kimi-k2-turbo-preview",
  maxPages: 50,
  maxDepth: 5,
  pageTimeout: 30000,
  wcagLevel: "AA",
  skipSitemap: false,
  excludePatterns: [],
  rateLimitRpm: 10,
  maxNavTargets: 3,
};

export async function runAudit(
  browser: Browser,
  auditId: string,
  userConfig: Partial<AuditConfig> & { baseUrl: string },
): Promise<void> {
  const config: AuditConfig = {
    ...DEFAULT_AUDIT_CONFIG,
    apiKey: process.env.LLM_API_KEY || "",
    ...userConfig,
  };

  const startTime = Date.now();
  const baseOrigin = new URL(config.baseUrl).origin;
  const queue = new UrlQueue(config.maxPages);
  const pages: PageResult[] = [];
  const errors: CrawlError[] = [];

  // Single LLM client — navigation only
  const navClient = new LLMClient({
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    model: config.navModel,
    rateLimitRpm: config.rateLimitRpm,
  });

  // Nav cache
  let lastNavRepr: string | null = null;
  let cachedNavTargets: NavTarget[] = [];

  // Phase 1: Seed URLs
  queue.seed([config.baseUrl], "link");

  if (!config.skipSitemap) {
    console.log("=== Sitemap Discovery ===");
    const sitemapUrls = await discoverSitemapUrls(config.baseUrl);
    console.log(`Found ${sitemapUrls.length} URLs from sitemap`);
    queue.seed(sitemapUrls.slice(0, Math.ceil(config.maxPages / 2)), "sitemap");
  }

  // Phase 2: Process pages
  console.log("\n=== Crawl + Analysis ===");
  let url: string | null;

  while ((url = queue.next()) !== null) {
    const page = await browser.newPage();
    const pageStart = Date.now();

    try {
      console.log(`Processing: ${url}`);

      // Step 1: Navigate
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: config.pageTimeout });
      } catch {
        // Timeout acceptable
      }

      // Step 2: Axe-core
      let axeIssues: Issue[] = [];
      try {
        axeIssues = await runAxe(page, { wcagLevel: config.wcagLevel });
      } catch (err) {
        console.warn(`axe-core failed on ${url}:`, err);
      }

      // Step 3: Interactive tests
      let interactiveIssues: Issue[] = [];
      try {
        interactiveIssues = await runInteractiveTests(page, url);
      } catch (err) {
        console.warn(`Interactive tests failed on ${url}:`, err);
      }

      // Step 4: Page representation
      const repr = await buildRepresentation(page);
      console.log(`  Representation: ${repr.tier} (~${repr.tokenEstimate} tokens)`);

      // Step 5: Nav discovery (with cache)
      let navTargets: NavTarget[];
      if (repr.content === lastNavRepr && cachedNavTargets.length > 0) {
        navTargets = cachedNavTargets;
        console.log(`  Nav targets: ${navTargets.length} (cached)`);
      } else {
        const title = await page.title();
        navTargets = await discoverNavTargets(url, title, repr, navClient);
        lastNavRepr = repr.content;
        cachedNavTargets = navTargets;
        console.log(`  Nav targets: ${navTargets.length}`);
      }

      // Step 6: Link extraction + interactions
      const staticLinks = await extractLinks(page, baseOrigin);
      queue.seed(staticLinks, "link");

      const interactionUrls = await interactWithTargets(page, navTargets, config, baseOrigin);
      queue.seed(interactionUrls, "interaction");

      // Build page result
      const allIssues = [...axeIssues, ...interactiveIssues];
      const title = await page.title();
      const processingMs = Date.now() - pageStart;

      const groupedByRule: Record<string, Issue[]> = {};
      for (const issue of allIssues) {
        if (!groupedByRule[issue.rule]) groupedByRule[issue.rule] = [];
        groupedByRule[issue.rule].push(issue);
      }

      const pageResult: PageResult = {
        url,
        title,
        issues: allIssues,
        groupedByRule,
        discoveredUrls: [...staticLinks, ...interactionUrls],
        discoveryMethods: {},
        representationTier: repr.tier,
        timestamp: new Date().toISOString(),
        processingMs,
      };

      pages.push(pageResult);

      // Save to DB
      const issuesByImpact = {
        critical: allIssues.filter((i) => i.impact === "critical").length,
        serious: allIssues.filter((i) => i.impact === "serious").length,
        moderate: allIssues.filter((i) => i.impact === "moderate").length,
        minor: allIssues.filter((i) => i.impact === "minor").length,
      };

      const pageId = await insertPage(auditId, {
        url,
        title,
        issueCount: allIssues.length,
        issuesByImpact,
        durationMs: processingMs,
      });

      await insertIssues(
        auditId,
        pageId,
        allIssues.map((i) => ({
          rule: i.rule,
          impact: i.impact,
          description: i.description,
          help: i.help,
          helpUrl: i.helpUrl,
          wcagTags: i.wcagTags,
          selector: i.selector,
          html: i.html,
          xpath: i.xpath,
          checkSource: i.checkSource,
          category: i.violationCategory,
          suggestedFix: i.suggestedFix,
          fixConfidence: i.fixConfidence,
        })),
      );

      // Emit progress
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
      console.log(`  [${pages.length}] ${url} — ${allIssues.length} issues (${repr.tier})`);

      await emitAuditEvent(auditId, "page_analyzed", {
        url,
        title,
        issueCount: allIssues.length,
        pagesAnalyzed: pages.length,
        totalDiscovered: queue.stats.totalDiscovered,
        elapsedSeconds,
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ url, phase: "navigation", message, timestamp: new Date().toISOString() });
      console.error(`  ERROR on ${url}: ${message}`);
      await emitAuditEvent(auditId, "error", { url, message });

    } finally {
      await page.close();
    }
  }

  // Phase 3: Post-processing
  console.log("\n=== Post-processing ===");
  const sharedIssues = detectSharedIssues(pages);
  console.log(`Detected ${sharedIssues.length} shared issues`);

  await insertSharedIssues(
    auditId,
    sharedIssues.map((si) => ({
      rule: si.rule,
      impact: "serious", // shared issues are at least serious
      normalizedHtml: si.html,
      pageCount: si.pageCount,
      pageUrls: si.affectedPages,
      suggestedFix: si.suggestedFix,
      category: "structural",
    })),
  );

  // Update audit as completed
  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const allIssues = pages.flatMap((p) => p.issues);

  const countByImpact = (level: ImpactLevel) => allIssues.filter((i) => i.impact === level).length;
  const countByCategory = (cat: ViolationCategory) => allIssues.filter((i) => i.violationCategory === cat).length;

  const issuesByRule: Record<string, number> = {};
  for (const issue of allIssues) {
    issuesByRule[issue.rule] = (issuesByRule[issue.rule] || 0) + 1;
  }

  await markAuditCompleted(
    auditId,
    {
      totalPages: pages.length,
      totalIssues: allIssues.length,
      issuesByImpact: {
        critical: countByImpact("critical"),
        serious: countByImpact("serious"),
        moderate: countByImpact("moderate"),
        minor: countByImpact("minor"),
      },
      issuesByRule,
      issuesByCategory: {
        structural: countByCategory("structural"),
        interactive: countByCategory("interactive"),
        visual: countByCategory("visual"),
        media: countByCategory("media"),
        semantic: countByCategory("semantic"),
      },
      pagesWithZeroIssues: pages.filter((p) => p.issues.length === 0).length,
      averageIssuesPerPage: pages.length > 0 ? Math.round((allIssues.length / pages.length) * 100) / 100 : 0,
    },
    {
      totalUrlsDiscovered: queue.stats.totalDiscovered,
      urlsFromSitemap: queue.stats.byOrigin.sitemap,
      urlsFromLinks: queue.stats.byOrigin.link,
      urlsFromInteraction: queue.stats.byOrigin.interaction,
      urlsAnalyzed: pages.length,
      urlsSkipped: queue.stats.totalDiscovered - pages.length,
    },
    {
      totalCalls: navClient.usage.totalCalls,
      totalInputTokens: navClient.usage.totalInputTokens,
      totalOutputTokens: navClient.usage.totalOutputTokens,
      callsByPurpose: { navigation: navClient.usage.navigationCalls, enrichment: 0 },
    },
    totalDuration,
  );

  // Emit completed event
  await emitAuditEvent(auditId, "completed", {
    totalPages: pages.length,
    totalIssues: allIssues.length,
    durationSeconds: totalDuration,
  });

  // Print LLM summary
  const u = navClient.usage;
  console.log("\n=== LLM Usage ===");
  console.log(`Nav discovery (${config.navModel}): ${u.totalCalls} calls | ${u.totalInputTokens} in | ${u.totalOutputTokens} out`);
  console.log(`Audit ${auditId} completed: ${pages.length} pages, ${allIssues.length} issues in ${totalDuration}s`);
}
```

**Step 2: Commit**

```bash
git add src/worker/audit.ts
git commit -m "feat: add worker audit orchestrator — replaces Crawlee-based orchestrator"
```

---

### Task 7: Worker Main Loop

Entry point for the worker process. Connects to Browserless, polls DB for work.

**Files:**
- Create: `src/worker/index.ts`

**Step 1: Implement worker entry point**

```typescript
// src/worker/index.ts
import { chromium } from "playwright";
import { initWorkerDb, claimNextAudit, markAuditFailed } from "./db.ts";
import { runAudit } from "./audit.ts";
import type { Browser } from "playwright";

const POLL_INTERVAL_MS = 5000;
const BROWSERLESS_URL = process.env.BROWSERLESS_URL || "ws://browserless:3000/chromium/playwright";
const MAX_RETRIES = 5;

async function connectWithRetry(url: string): Promise<Browser> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const browser = await chromium.connect(url);
      console.log(`Connected to Browserless at ${url}`);
      return browser;
    } catch (err) {
      const waitMs = Math.pow(2, attempt) * 1000;
      console.warn(
        `Browserless connection failed (attempt ${attempt + 1}/${MAX_RETRIES}):`,
        err instanceof Error ? err.message : err,
      );
      if (attempt < MAX_RETRIES - 1) {
        console.log(`Retrying in ${waitMs}ms...`);
        await Bun.sleep(waitMs);
      }
    }
  }
  throw new Error(`Failed to connect to Browserless at ${BROWSERLESS_URL} after ${MAX_RETRIES} attempts`);
}

async function main() {
  console.log("=== A11y Crawler Worker ===");

  // Initialize DB
  initWorkerDb();
  console.log("Database connected");

  // Connect to Browserless
  let browser = await connectWithRetry(BROWSERLESS_URL);

  // Reconnect on disconnect
  browser.on("disconnected", async () => {
    console.warn("Browserless disconnected, reconnecting...");
    try {
      browser = await connectWithRetry(BROWSERLESS_URL);
    } catch (err) {
      console.error("Failed to reconnect to Browserless:", err);
      process.exit(1);
    }
  });

  // Graceful shutdown
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log("\nShutting down worker...");
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("Worker ready. Polling for audits...\n");

  // Main loop
  while (!stopping) {
    try {
      const audit = await claimNextAudit();

      if (!audit) {
        await Bun.sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(`\n${"=".repeat(60)}`);
      console.log(`Starting audit ${audit.id}: ${audit.url}`);
      console.log(`${"=".repeat(60)}\n`);

      try {
        await runAudit(browser, audit.id, {
          baseUrl: audit.url,
          ...audit.config,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Audit ${audit.id} failed:`, message);
        await markAuditFailed(audit.id, message);
      }

    } catch (err) {
      // DB polling error — log and continue
      console.error("Worker loop error:", err instanceof Error ? err.message : err);
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  // Cleanup
  await browser.close();
  console.log("Worker stopped gracefully");
  process.exit(0);
}

main().catch((err) => {
  console.error("Worker fatal error:", err);
  process.exit(1);
});
```

**Step 2: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: add worker main loop — polls DB, connects to Browserless"
```

---

## Phase 3: API Server Changes

Modify the existing API server to use SSE instead of WebSocket, and remove the job manager.

---

### Task 8: Add SSE Endpoint

Replace WebSocket-based progress with Server-Sent Events.

**Files:**
- Create: `src/server/routes/sse.ts`
- Modify: `src/server/index.ts` — add SSE route, remove WS

**Step 1: Implement SSE handler**

```typescript
// src/server/routes/sse.ts
import { getDb } from "../db/client.ts";

/**
 * SSE endpoint: GET /api/audits/:id/events
 * Streams audit progress events to the client.
 * Auto-closes when audit is completed or failed.
 */
export function handleSSE(req: Request, url: URL): Response | null {
  const match = url.pathname.match(/^\/api\/audits\/([^/]+)\/events$/);
  if (!match || req.method !== "GET") return null;

  const auditId = match[1];
  const db = getDb();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let lastEventId = 0;
      let closed = false;

      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Poll for new events every 2 seconds
      const interval = setInterval(async () => {
        if (closed) {
          clearInterval(interval);
          return;
        }

        try {
          // Get new events since last seen
          const events = await db`
            SELECT id, event_type, data
            FROM audit_events
            WHERE audit_id = ${auditId} AND id > ${lastEventId}
            ORDER BY id
          `;

          for (const event of events) {
            send({
              type: event.event_type,
              data: typeof event.data === "string" ? JSON.parse(event.data) : event.data,
            });
            lastEventId = event.id;
          }

          // Check if audit is done
          const audit = await db`
            SELECT status FROM audits WHERE id = ${auditId}
          `;

          if (audit.length === 0 || audit[0].status === "completed" || audit[0].status === "failed") {
            // Send final status if not already sent via events
            if (audit.length > 0) {
              send({ type: audit[0].status, data: { status: audit[0].status } });
            }
            clearInterval(interval);
            closed = true;
            controller.close();
          }
        } catch (err) {
          console.error("SSE poll error:", err);
        }
      }, 2000);

      // Cleanup on client disconnect
      req.signal?.addEventListener("abort", () => {
        clearInterval(interval);
        closed = true;
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

**Step 2: Update server index to add SSE route and remove WebSocket**

In `src/server/index.ts`, make these changes:

1. Add import: `import { handleSSE } from "./routes/sse.ts";`
2. Remove imports: `handleWsUpgrade`, `wsOpen`, `wsClose`, `wsMessage`, `startNotifyListener`
3. Remove the `startNotifyListener()` call
4. Remove the WebSocket upgrade block (`if (url.pathname.startsWith("/ws/"))`)
5. Remove the `websocket: { ... }` config from `Bun.serve()`
6. Add SSE route in `handleApiRoute()`:
   ```typescript
   // Before other /api/audits routes:
   if (url.pathname.match(/^\/api\/audits\/[^/]+\/events$/)) {
     const sseResponse = handleSSE(req, url);
     if (sseResponse) return sseResponse;
   }
   ```

**Step 3: Update audit creation to NOT spawn a child process**

In `src/server/routes/audits.ts`, the POST handler currently calls `startCrawl()` from the job manager. Change it to simply insert the audit with `status: 'pending'` and return — the worker will pick it up.

Remove: `import { startCrawl } from "../jobs/manager.ts";`
Remove: the `startCrawl(audit.id, body.url, ...)` call after insert
The audit insert already sets `status: 'pending'`, which is what the worker polls for.

**Step 4: Commit**

```bash
git add src/server/routes/sse.ts src/server/index.ts src/server/routes/audits.ts
git commit -m "feat: replace WebSocket with SSE for audit progress, remove job manager"
```

---

### Task 9: Update Frontend — SSE Instead of WebSocket

**Files:**
- Modify: Frontend files that use WebSocket for audit progress

**Step 1: Find WebSocket usage in frontend**

```bash
grep -r "WebSocket\|ws://" frontend/src/ --include="*.ts" --include="*.tsx" -l
```

**Step 2: Replace WebSocket with EventSource**

In each file that creates a WebSocket connection, replace with:

```typescript
// Before (WebSocket):
const ws = new WebSocket(`ws://${location.host}/ws/audits/${auditId}`);
ws.onmessage = (event) => { /* ... */ };

// After (SSE):
const eventSource = new EventSource(`/api/audits/${auditId}/events`);
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Same handler logic — data format is identical
};
eventSource.onerror = () => {
  eventSource.close();
};
```

**Note:** The exact files depend on the frontend structure. The implementing agent should `grep` for WebSocket usage and replace each instance. The event data format stays the same (`{ type, data }`) so handler logic doesn't change.

**Step 3: Commit**

```bash
git add frontend/src/
git commit -m "feat: migrate frontend from WebSocket to SSE for audit progress"
```

---

## Phase 4: Cleanup & Docker

---

### Task 10: Remove Crawlee and Enrichment Code

**Files to delete:**
- `src/enrichment/llm.ts`
- `src/enrichment/prompts.ts`
- `src/enrichment/` (entire directory)
- `src/server/jobs/manager.ts`
- `src/server/jobs/` (entire directory)
- `src/server/ws.ts`
- `src/orchestrator.ts`
- `src/crawler/crawler.ts` (replaced by worker/audit.ts + links.ts + interactions.ts)
- `src/crawler/worker.ts` (old subprocess-based worker)

**Step 1: Delete files**

```bash
rm -rf src/enrichment/
rm -rf src/server/jobs/
rm -f src/server/ws.ts
rm -f src/orchestrator.ts
rm -f src/crawler/crawler.ts
rm -f src/crawler/worker.ts
```

**Step 2: Remove crawlee from package.json**

```bash
bun remove crawlee
```

**Step 3: Update imports — check for broken references**

```bash
grep -r "from.*enrichment" src/ --include="*.ts" -l
grep -r "from.*orchestrator" src/ --include="*.ts" -l
grep -r "from.*jobs/manager" src/ --include="*.ts" -l
grep -r "from.*ws.ts" src/ --include="*.ts" -l
grep -r "from.*crawler/crawler" src/ --include="*.ts" -l
grep -r "crawlee" src/ --include="*.ts" -l
```

Fix any remaining imports found.

**Step 4: Update `src/types/config.ts`**

Remove enrichment-related fields:
```typescript
// Remove these fields from CrawlConfig:
// enrichModel, enrichVisualModel, enrichImpactThreshold, concurrency

// Remove from DEFAULT_CONFIG:
// enrichModel, enrichVisualModel, enrichImpactThreshold, concurrency
```

**Step 5: Run existing tests to check nothing is broken**

```bash
bun test
```

Fix any test failures (tests that imported deleted modules).

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove Crawlee, enrichment, WebSocket, old orchestrator"
```

---

### Task 11: Split Dockerfiles

**Files:**
- Rename: `Dockerfile` → `Dockerfile.bak` (keep as backup until confirmed working)
- Create: `Dockerfile.api`
- Create: `Dockerfile.worker`
- Modify: `docker-compose.coolify.yml`

**Step 1: Create Dockerfile.api**

```dockerfile
# Dockerfile.api — API Server (lightweight, no Playwright/Chromium)

# Stage 1: Build frontend
FROM oven/bun:1 AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock* ./
RUN bun install --frozen-lockfile
COPY frontend/ .
RUN bun run build

# Stage 2: API Server
FROM oven/bun:1 AS production
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy only server + types source (no crawler/analyzer code needed)
COPY src/server/ src/server/
COPY src/types/ src/types/

# Copy built frontend
COPY --from=frontend-build /app/dist/frontend/ dist/frontend/

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/server/index.ts"]
```

**Step 2: Create Dockerfile.worker**

```dockerfile
# Dockerfile.worker — Audit Worker (Playwright client, NO Chromium)

FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy all source (worker needs analyzer, crawler, repr, discovery, llm, types)
COPY src/ src/

ENV NODE_ENV=production

CMD ["bun", "run", "src/worker/index.ts"]
```

**Note:** Worker does NOT run `bunx playwright install chromium` — it connects to Browserless remotely. The `playwright` npm package includes the client protocol but does NOT bundle the browser binaries unless explicitly installed.

**Step 3: Update docker-compose.coolify.yml**

Replace entire content with the 3-service setup from the design doc (Section 10). Key changes:
- `app` service → `api` service (uses `Dockerfile.api`)
- New `worker` service (uses `Dockerfile.worker`, depends on `browserless`)
- New `browserless` service (`ghcr.io/browserless/chromium`)
- `worker` gets `LLM_API_KEY`, `BROWSERLESS_URL`, `REPORTS_DIR`
- `api` does NOT get `LLM_API_KEY` (doesn't need it)
- Both `api` and `worker` share the `reports` volume

**Step 4: Commit**

```bash
git add Dockerfile.api Dockerfile.worker docker-compose.coolify.yml
git commit -m "feat: split Docker into API + Worker + Browserless sidecar"
```

---

## Phase 5: Integration Test & Deploy

---

### Task 12: Local Integration Test

Test the full pipeline locally before deploying.

**Step 1: Start Browserless locally**

```bash
docker run -d --name browserless -p 3001:3000 ghcr.io/browserless/chromium
```

**Step 2: Run worker locally (connecting to local Browserless)**

```bash
BROWSERLESS_URL=ws://localhost:3001/chromium/playwright \
DATABASE_URL=<your-local-pg-url> \
LLM_API_KEY=<your-key> \
bun run src/worker/index.ts
```

**Step 3: Create a test audit via API or direct DB insert**

```bash
# Insert a test audit
psql $DATABASE_URL -c "INSERT INTO audits (url, config, status) VALUES ('https://example.com', '{\"maxPages\": 3}', 'pending')"
```

**Step 4: Watch worker pick it up and process**

Expected: Worker claims audit, processes 1-3 pages, prints LLM usage, marks completed.

**Step 5: Verify results in DB**

```bash
psql $DATABASE_URL -c "SELECT id, url, status, duration_seconds FROM audits ORDER BY created_at DESC LIMIT 5"
psql $DATABASE_URL -c "SELECT count(*) FROM pages WHERE audit_id = '<audit-id>'"
psql $DATABASE_URL -c "SELECT count(*) FROM issues WHERE audit_id = '<audit-id>'"
```

**Step 6: Test SSE endpoint**

```bash
curl -N http://localhost:3000/api/audits/<audit-id>/events
```

**Step 7: Cleanup**

```bash
docker stop browserless && docker rm browserless
```

**Step 8: Commit any fixes found during testing**

```bash
git add -A
git commit -m "fix: integration test fixes"
```

---

### Task 13: Deploy to VPS

**Step 1: Push changes**

```bash
git push origin master
```

**Step 2: Deploy via Coolify**

Coolify should auto-detect the `docker-compose.coolify.yml` changes and rebuild.

If Coolify doesn't rebuild automatically:
1. Go to Coolify dashboard
2. Trigger a manual redeploy
3. Verify all 3 containers are running:

```bash
ssh root@89.167.115.45 "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
```

**Step 3: Verify memory usage**

```bash
ssh root@89.167.115.45 "docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'"
```

Expected: API ~50MB, Worker ~100MB, Browserless ~400-600MB.

**Step 4: Test with finnk.com (the original failing case)**

Create an audit via the frontend at `https://a11y.pguerrero.me` targeting `https://www.finnk.com` with depth 3, max 10 pages.

Expected: Crawls multiple pages (not just 1), no "memory critically overloaded" errors.

**Step 5: Test with kutxabankinvestment.es (the working case)**

Verify it still works as before with the same or better results.

---

## Summary of All Tasks

| # | Task | Phase | Est. Effort |
|---|---|---|---|
| 1 | UrlQueue class + tests | Core Modules | 15 min |
| 2 | Link extraction + tests | Core Modules | 10 min |
| 3 | Nav interactions extraction | Core Modules | 10 min |
| 4 | Interactive accessibility tests | Core Modules | 30 min |
| 5 | Worker DB module | Worker | 15 min |
| 6 | Worker audit orchestrator | Worker | 30 min |
| 7 | Worker main loop | Worker | 15 min |
| 8 | SSE endpoint + server updates | API Changes | 20 min |
| 9 | Frontend SSE migration | API Changes | 15 min |
| 10 | Remove Crawlee + enrichment | Cleanup | 15 min |
| 11 | Split Dockerfiles | Docker | 15 min |
| 12 | Local integration test | Test & Deploy | 30 min |
| 13 | Deploy to VPS | Test & Deploy | 20 min |

**Total estimated: ~4 hours**

**Critical path:** Tasks 1-7 are sequential (each builds on previous). Tasks 8-9 can be parallelized. Task 10 should come after 8. Tasks 11-13 are sequential at the end.

**Checkpoints (stop and verify):**
- After Task 4: Run `bun test` — all new + existing tests pass
- After Task 7: Worker can start and connect to a local Browserless
- After Task 9: Full stack works locally (API + Worker + Browserless + Frontend)
- After Task 13: Production deployment verified with real sites
