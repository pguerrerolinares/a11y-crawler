# A11y Crawler v4 — Optimized Intelligence Pipeline

> Validated design based on spike testing + deep research (March 2026).
> Replaces previous design that assumed linkedom+axe-core worked (it doesn't).

## The Problem

The current crawler (v3) treats every page identically: new BrowserContext, `networkidle` wait, 13-selector cookie click loop, full axe, all interactive tests, LLM nav discovery. Result:

- **~10-15s per page** (50 pages = 500-750s)
- **50% WCAG 2.2 AA coverage** (missing reflow, text-spacing, non-text contrast, multimedia, timed events, error identification, target size, resize text)
- **330 false positives** from CookieBot banner elements tested by `testFocusVisibility`
- **Zero template awareness** — identical issues reported 15× across product pages
- **No observability** — no way to know where time is spent or why audits fail

## What the Spikes Proved

| Hypothesis | Result |
|-----------|--------|
| axe-core on linkedom (no browser) | **FAILED** — linkedom lacks `window`/`document` globals axe requires |
| axe-core on jsdom (no browser) | **Works** but OOM on large pages (>127KB HTML), 14-100MB/page, CSR sites return empty HTML |
| fetch() returns useful HTML for most sites | **Partially** — 6/8 SSR sites OK, Angular/React-CSR return empty `<app-root>` |
| Cookie script blocking via `page.route()` | **Validated** — prevents DOM overlay entirely, no false positives |
| DOM structural fingerprinting | **Validated** — SimHash on skeleton to depth 6, ~3-8ms per page |

**Conclusion: No viable no-browser tier.** All analysis must use Playwright/Browserless. But we can make Playwright dramatically faster and smarter.

## Architecture: Three-Phase Browser Pipeline

```
  SCAN (fast browser, 3 concurrent)    CLASSIFY (in-memory)         PROBE (deep, representatives)
  ─────────────────────────────────     ────────────────────         ─────────────────────────────
  domcontentloaded + block img/font     SimHash clustering           waitUntil: load
  cookie script blocking at network     URL pattern inference         Full axe (wcag22aa tags)
  DOM fingerprint (~8ms)                Capability-driven test plan   8 new WCAG tests
  axe LIGHT (5 content rules)           Select representatives       Interactive tests
  Extract links + seed queue                                         Observability spans
  ~3s/page, 3 concurrent                ~50ms total                  ~18s/representative (avg)
       │                                      │                              │
       ▼                                      ▼                              ▼
  "50 pages scanned,                  "6 templates found:            "Template A: 4 violations
   12 content issues,                  A: product (18 pages)          Template B: reflow fail
   fingerprints for all"               B: legal (5 pages)             Template C: clean
                                       C: blog (12 pages)             Issues amplified to all
                                       D: contact (3 pages)           pages via templates"
                                       E: media (2 pages)
                                       F: home (1 page)"
```

### Why This Works on a 4GB VPS

| Resource | v3 | v4 |
|----------|----|----|
| Pages per second | 0.07-0.1 (sequential) | 0.5-1.0 (3 concurrent SCAN) |
| Memory per page | ~100-150MB (new context each) | ~60MB (per-slot context, recycled every 25 pages) |
| Peak concurrent browser tabs | 1 | 3 (SCAN) / 1 (PROBE) |
| Time for 50 pages | 500-750s | ~200s (3× faster) |
| WCAG 2.2 AA coverage | ~50% | ~75% (v4.0), ~90% (v4.2) |
| False positives from cookies | 330 | 0 |

## Phase 1: SCAN — Fast Broad Coverage

**Goal**: Visit every page cheaply, extract fingerprint + content-level issues + links.

### Playwright Optimizations (Validated by Research)

**1. One BrowserContext per concurrency slot, recycled every 25 pages**

Each concurrent SCAN worker gets its own BrowserContext. This is mandatory because a BrowserContext shares cookies, localStorage, and sessionStorage across all its pages — if page A triggers a login redirect or sets a session cookie, it contaminates pages B and C in the same context.

Known memory leak in Playwright (issue #6319): pages accumulate ~30MB that isn't freed on `page.close()`. Closing the BrowserContext forces GC. Each slot recycles its context every 25 pages.

```typescript
const PAGES_PER_CONTEXT = 25;
const CONCURRENCY = 3;

class ContextSlot {
  private context: BrowserContext | null = null;
  private pagesSinceRecycle = 0;

  async get(browser: Browser): Promise<BrowserContext> {
    if (!this.context || this.pagesSinceRecycle >= PAGES_PER_CONTEXT) {
      if (this.context) await this.context.close();
      this.context = await browser.newContext({
        userAgent: CHROME_UA,
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      await installConsentBlocker(this.context);
      await installResourceBlocker(this.context, "scan");
      this.pagesSinceRecycle = 0;
    }
    this.pagesSinceRecycle++;
    return this.context;
  }

  async close(): Promise<void> {
    if (this.context) await this.context.close();
    this.context = null;
  }
}

// 3 independent slots = 3 isolated sessions
const slots = Array.from({ length: CONCURRENCY }, () => new ContextSlot());
```

**Why not one shared context**: A single BrowserContext with 3 concurrent pages means page A's cookies leak to page B. On sites with auth redirects, CSRF tokens, or session-dependent content, this produces incorrect DOM states and unreliable axe results. One context per slot isolates sessions while still reusing contexts across sequential pages within the same slot.

**2. `domcontentloaded` instead of `networkidle`**

`networkidle` waits 500ms after zero network activity — on SPAs with analytics/polling it often hits the full 30s timeout. `domcontentloaded` fires when HTML is parsed and synchronous scripts execute. 33% faster in real-world benchmarks (Checkly).

```typescript
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
```

**3. Resource blocking at context level**

During SCAN, we only need DOM structure. Block images, fonts, and media at the network level:

```typescript
async function installResourceBlocker(context: BrowserContext, phase: "scan" | "probe") {
  const blocked = phase === "scan"
    ? ["image", "media", "font"]       // SCAN: block heavy resources
    : ["font"];                         // PROBE: keep images (for alt checks), keep CSS
  await context.route("**/*", route => {
    if (blocked.includes(route.request().resourceType())) {
      return route.abort();
    }
    return route.continue();
  });
}
```

Measured impact: page bandwidth drops from ~1.9MB to ~8.7KB on typical e-commerce pages.

**4. SlotPool: Semaphore + ContextSlot unified**

With ~830MB free and ~60MB per page: 3 concurrent pages = ~180MB, leaving 650MB headroom.

The Semaphore and ContextSlot must be a single coordinated mechanism — acquiring a concurrency permit must return the specific slot (and its isolated BrowserContext) the worker should use:

```typescript
class SlotPool {
  private available: ContextSlot[];
  private waiting: Array<(slot: ContextSlot) => void> = [];

  constructor(size: number) {
    this.available = Array.from({ length: size }, () => new ContextSlot());
  }

  /** Acquire a slot — blocks until one is available. Returns the specific slot to use. */
  async acquire(): Promise<ContextSlot> {
    const slot = this.available.pop();
    if (slot) return slot;
    return new Promise(resolve => this.waiting.push(resolve));
  }

  /** Release a slot back to the pool */
  release(slot: ContextSlot): void {
    const next = this.waiting.shift();
    if (next) {
      next(slot); // hand directly to next waiter
    } else {
      this.available.push(slot);
    }
  }

  /** Close all slots at end of SCAN phase */
  async closeAll(): Promise<void> {
    for (const slot of this.available) await slot.close();
  }
}

// Usage in SCAN phase:
const pool = new SlotPool(3);

async function scanPage(browser: Browser, url: string): Promise<ScanResult> {
  const slot = await pool.acquire();
  try {
    const context = await slot.get(browser); // creates or reuses context for THIS slot
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      // ... fingerprint + axe-light + link extraction
      return result;
    } finally {
      await page.close();
    }
  } finally {
    pool.release(slot);
  }
}

// Process all URLs concurrently through the pool:
try {
  await Promise.all(urls.map(url => scanPage(browser, url)));
} finally {
  await pool.closeAll(); // MUST close all 3 SCAN contexts before PROBE starts
}
```

Each `acquire()` returns a specific `ContextSlot` with its own BrowserContext. No mapping ambiguity — the slot IS the permit.

**5. Batch DOM queries in single `page.evaluate()`**

Every Playwright API call (`.locator()`, `.getAttribute()`) is a CDP round-trip over WebSocket to Browserless. Batch everything into one `page.evaluate()`:

```typescript
// SCAN: single evaluate extracts fingerprint + links + capabilities
const scanResult = await page.evaluate(() => {
  // DOM fingerprint (structural skeleton)
  function nodeSignature(el: Element, depth: number): string {
    if (depth > 6) return "";
    const tag = el.tagName.toLowerCase();
    const leafTags = new Set(["p","span","a","img","strong","em","br","input","button","label","li"]);
    const role = el.getAttribute("role") || "";
    const childCount = el.children.length;
    const sig = `${tag}(${role ? "r=" + role + "," : ""}n=${childCount})`;
    if (leafTags.has(tag) || depth >= 6) return sig;
    const children = Array.from(el.children)
      .map(c => nodeSignature(c as Element, depth + 1))
      .filter(Boolean).join("|");
    return children ? `${sig}[${children}]` : sig;
  }

  // Links
  const links = Array.from(document.querySelectorAll("a[href]"), a => a.href);

  // Capabilities (feed CLASSIFY phase)
  const hasForms = document.querySelectorAll("form").length > 0;
  const hasMedia = document.querySelectorAll("video, audio, iframe[src*='youtube'], iframe[src*='vimeo']").length > 0;
  const hasCarousel = !!document.querySelector('[class*="carousel" i], [class*="slider" i], [aria-roledescription="carousel"]');
  const hasDataTables = document.querySelectorAll("table:not([role='presentation'])").length > 0;

  // SPA shell detection — triggers LLM nav discovery fallback
  const isSpaShell = !!(
    document.querySelector("app-root, #root, #app, #__next, #__nuxt") &&
    document.querySelectorAll("a[href]").length < 3
  );

  return {
    fingerprint: nodeSignature(document.body, 0),
    title: document.title,
    links,
    elementCount: document.querySelectorAll("*").length,
    capabilities: { hasForms, hasMedia, hasCarousel, hasDataTables, isSpaShell },
  };
});
```

### axe LIGHT: Content-Dependent Rules Only

On every page during SCAN, run axe with only the 5 rules that vary by content (not template):

```typescript
const lightResults = await new AxeBuilder({ page })
  .withRules(["image-alt", "link-name", "button-name", "label", "document-title"])
  .options({ resultTypes: ["violations", "incomplete"] })
  .analyze();
```

These catch the #1 real-world issue (missing alt text — 54.5% of pages per WebAIM Million 2024) that template deduplication would miss.

### LLM Nav Discovery — Conditional Fallback

v3 uses LLM (kimi-k2-turbo-preview) on every page to discover navigation targets. v4 uses it as a **conditional fallback** only when `page.evaluate()` extraction finds suspiciously few links — indicating a CSR shell that hasn't rendered.

```typescript
const MIN_INTERNAL_LINKS = 3;

// After page.evaluate() extracts links:
const internalLinks = scanResult.links.filter(l => new URL(l).origin === resolvedOrigin);

if (internalLinks.length < MIN_INTERNAL_LINKS && scanResult.capabilities.isSpaShell) {
  // SPA shell detected — domcontentloaded rendered but JS framework hasn't hydrated
  // Wait for network idle as fallback, then re-extract
  await page.waitForLoadState("networkidle").catch(() => {}); // best-effort, 5s timeout
  const reExtracted = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"), a => a.href)
  );

  if (reExtracted.length < MIN_INTERNAL_LINKS) {
    // Still no links — invoke LLM nav discovery
    const llmLinks = await discoverNavTargets(page, llmClient);
    scanResult.links = [...new Set([...scanResult.links, ...llmLinks])];
    scanResult.discoveryMethod = "llm";
  } else {
    scanResult.links = reExtracted;
    scanResult.discoveryMethod = "networkidle-retry";
  }
}
```

**SPA shell detection** (inside the `page.evaluate()` batch):

```typescript
const isSpaShell = !!(
  document.querySelector("app-root, #root, #app, #__next, #__nuxt") &&
  document.querySelectorAll("a[href]").length < 3
);
```

**Cost**: ~1-2s extra on 0-5% of pages (CSR sites only). The LLM client is already initialized in the worker — no new dependency.

### SCAN Error Handling

Pages can fail during SCAN for many reasons. Each failure type has explicit handling:

| Scenario | Action |
|----------|--------|
| Timeout (15s) | Record in `crawl_errors`, skip page. No fingerprint/axe. |
| HTTP 4xx | Record in `crawl_errors` with status code. Skip. |
| HTTP 5xx | Retry 1× after 2s. If still fails, record in `crawl_errors`. |
| Redirect to different origin | Discard silently (same-origin filter). |
| Redirect same origin | Follow. Use final URL as canonical. |
| Empty response (<100 bytes) | Record as `crawl_error: "empty-response"`. Skip. |
| Navigation error (DNS, SSL) | Record in `crawl_errors`. Continue. |

```typescript
async function scanPage(browser: Browser, url: string): Promise<ScanResult | null> {
  const slot = await pool.acquire();
  try {
    const context = await slot.get(browser);
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      if (!response) { crawlErrors.push({ url, error: "no-response" }); return null; }

      const status = response.status();
      if (status >= 500) {
        // Retry once for server errors
        await page.waitForTimeout(2_000);
        const retry = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        if (!retry || retry.status() >= 400) {
          crawlErrors.push({ url, error: `http-${retry?.status() ?? status}` });
          return null;
        }
      } else if (status >= 400) {
        crawlErrors.push({ url, error: `http-${status}` });
        return null;
      }

      // Check same-origin after redirect
      const finalUrl = page.url();
      if (new URL(finalUrl).origin !== resolvedOrigin) return null;

      // ... fingerprint + axe-light + link extraction + persist ...
    } finally {
      await page.close();
    }
  } finally {
    pool.release(slot);
  }
}
```

### SCAN Persistence — Immediate INSERT

Each page's results are persisted immediately after analysis, not batched at end of SCAN. This means if CLASSIFY or PROBE crash, the audit already has content-level issues for all scanned pages — the partial report is useful.

```typescript
// Inside scanPage(), after fingerprint + axe-light:
const pageId = await insertPage(auditId, {
  url: finalUrl,
  fingerprint: scanResult.fingerprint,
  elementCount: scanResult.elementCount,
  capabilities: scanResult.capabilities,
});
if (lightIssues.length > 0) {
  await insertIssues(auditId, pageId, lightIssues); // batch INSERT for this page
}
```

**Time budget per page (SCAN):** ~3s total
- Navigation (domcontentloaded): ~1-2s
- page.evaluate (fingerprint+links+capabilities): ~10ms
- axe LIGHT (5 rules): ~200-400ms
- DB insert: ~5ms
- LLM nav discovery (conditional, ~5% of pages): +1-2s when triggered

## Cookie Consent Blocking: Two-Layer Defense

Replaces `dismissCookieBanner()` (13 selectors, 500ms each, 6.5s worst case, cause of 330 false positives).

### Layer 1: Network Abort (BrowserContext level)

Block all major CMP CDN scripts before they execute. No script = no DOM overlay.

```typescript
const CONSENT_SCRIPT_PATTERNS = [
  // Cookiebot / Usercentrics (Cookiebot brand)
  "**/consent.cookiebot.com/**",
  "**/consentcdn.cookiebot.com/**",
  "**/consent.cookiebot.eu/**",
  // OneTrust / CookiePro / Optanon
  "**/cdn.cookielaw.org/**",
  // CookieYes
  "**/cdn-cookieyes.com/**",
  "**/*.cookieyes.com/**",
  // TrustArc
  "**/consent.trustarc.com/**",
  // Quantcast Choice
  "**/quantcast.mgr.consensu.org/**",
  "**/cmp.quantcast.com/**",
  // Usercentrics
  "**/app.usercentrics.eu/**",
  "**/web.eu1.cmp.usercentrics.eu/**",
  // Didomi
  "**/sdk.privacy-center.org/**",
  // Termly
  "**/app.termly.io/consent-sync*",
  "**/app.termly.io/resource-blocker/**",
  // iubenda
  "**/cdn.iubenda.com/cs/**",
  // ConsentManager.net
  "**/cdn.consentmanager.net/**",
  // Evidon / Sourcepoint / Admiral
  "**/c.evidon.com/**",
  "**/cdn.privacy-mgmt.com/**",
  "**/cdn.admiral.digital/**",
];

async function installConsentBlocker(context: BrowserContext): Promise<void> {
  for (const pattern of CONSENT_SCRIPT_PATTERNS) {
    await context.route(pattern, route => route.abort());
  }
}
```

### Layer 2: CSS Prehide (per-page safety net)

Some CMPs have inline HTML shells that render even without their JS. Hide them via CSS:

```typescript
const CONSENT_PREHIDE_CSS = `
  #CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay,
  #onetrust-banner-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter,
  .trustarc-banner-container, .truste_popframe, .truste_overlay,
  #cmpbox, #cmpbox2, #cmpwrapper, .klaro,
  [id*="cookie-banner"], [id*="cookie-consent"], [id*="cookieConsent"],
  [class*="cookie-banner"], [class*="cookie-consent"], [class*="cookieConsent"],
  [id*="gdpr-banner"], [class*="gdpr-banner"],
  [id*="consent-banner"], [class*="consent-banner"]
  { display: none !important; visibility: hidden !important; pointer-events: none !important; }
`;

async function injectConsentPrehideCSS(page: Page): Promise<void> {
  await page.addStyleTag({ content: CONSENT_PREHIDE_CSS });
}
```

`display: none` removes elements from the accessibility tree — axe-core correctly ignores them.

## Phase 2: CLASSIFY — Template Clustering

Runs in-memory after SCAN completes. No browser needed.

### SimHash Algorithm (64-bit, ~40 lines)

```typescript
function simhash(text: string, bits = 64): bigint {
  const v = new Array(bits).fill(0);
  // Tokenize into trigrams
  for (let i = 0; i < text.length - 2; i++) {
    const token = text.slice(i, i + 3);
    let h = 2166136261n; // FNV-1a
    for (let j = 0; j < token.length; j++) {
      h ^= BigInt(token.charCodeAt(j));
      h = BigInt.asUintN(32, h * 16777619n);
    }
    const hash = h ^ (h << 32n);
    for (let b = 0; b < bits; b++) {
      v[b] += (hash >> BigInt(b)) & 1n ? 1 : -1;
    }
  }
  let fingerprint = 0n;
  for (let b = 0; b < bits; b++) {
    if (v[b] > 0) fingerprint |= 1n << BigInt(b);
  }
  return fingerprint;
}

function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let dist = 0;
  while (xor > 0n) { dist += Number(xor & 1n); xor >>= 1n; }
  return dist;
}
```

### URL Pattern Inference (complement to SimHash)

Only the **last** path segment is normalized to a placeholder. Parent segments are always preserved as literals. This prevents false grouping: `/blog/how-to-use-axe` and `/docs/getting-started` both have slug-like last segments but are completely different templates.

```typescript
function inferUrlPattern(url: string): string {
  const { pathname } = new URL(url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  // All segments except the last are kept as literals — they define the template "family"
  const parentSegments = segments.slice(0, -1);
  const lastSegment = segments[segments.length - 1];

  // Only normalize the leaf segment
  let normalizedLast: string;
  if (/^\d+$/.test(lastSegment)) {
    normalizedLast = ":id";                                      // /products/123 → /products/:id
  } else if (/^[0-9a-f-]{36}$/.test(lastSegment)) {
    normalizedLast = ":uuid";                                    // /items/550e8400-e29b-... → /items/:uuid
  } else if (/^[a-z0-9]+(-[a-z0-9]+){2,}$/.test(lastSegment)) {
    normalizedLast = ":slug";                                    // /blog/how-to-use-axe → /blog/:slug
  } else {
    normalizedLast = lastSegment;                                // /about → /about (literal)
  }

  return "/" + [...parentSegments, normalizedLast].join("/");
}

// Examples:
// /blog/how-to-use-axe       → /blog/:slug
// /docs/getting-started       → /docs/:slug       (different parent = different pattern)
// /products/shoes/123         → /products/shoes/:id
// /products/hats/456          → /products/hats/:id (different parent = different pattern)
// /about                      → /about
```

This means `/blog/:slug` and `/docs/:slug` are **different** URL patterns, which is correct — they are different sections of the site with different templates. The SimHash serves as the second check: even if two pages happen to share a URL pattern, different DOM structure keeps them in separate clusters.

### Clustering Logic

```typescript
interface TemplateCluster {
  id: string;                    // SimHash hex + URL pattern
  fingerprint: bigint;
  urlPattern: string;
  urls: string[];
  representative: string;        // URL selected for PROBE
  capabilities: {
    hasForms: boolean;
    hasMedia: boolean;
    hasCarousel: boolean;
    hasDataTables: boolean;
  };
  lightIssues: Issue[];           // From SCAN axe-light
  testPlan: TestType[];           // Generated from capabilities
}

type TestType =
  | "axe-full" | "interactive" | "reflow" | "text-spacing"
  | "resize-text" | "non-text-contrast" | "target-size"
  | "multimedia" | "timed-events" | "error-identification";

function buildTestPlan(cluster: TemplateCluster): TestType[] {
  // ── v4.0 MANDATORY tests ──
  // Structural WCAG requirements that do NOT depend on page capabilities.
  // A plain text page can still fail reflow, text-spacing, or resize-text.
  const plan: TestType[] = [
    "axe-full",           // Always: full axe-core with wcag22aa tags
    "interactive",        // Always: tab order, focus visibility, keyboard traps, skip nav
    "reflow",             // Always: 1.4.10 — any page can have fixed-width elements
    "text-spacing",       // Always: 1.4.12 — any page with text can clip on spacing change
    "resize-text",        // Always: 1.4.4 — meta-viewport restrictions, zoom overflow
  ];

  // ── v4.0 CONDITIONAL tests ──
  if (cluster.capabilities.hasMedia)    plan.push("multimedia", "timed-events");
  if (cluster.capabilities.hasCarousel) plan.push("timed-events");

  // ── v4.1 tests (uncomment when implemented) ──
  // plan.push("target-size");        // 2.5.8 — bounding box computation
  // if (cluster.capabilities.hasForms) plan.push("error-identification"); // 3.3.x

  // ── v4.2 tests (uncomment when implemented) ──
  // plan.push("non-text-contrast");  // 1.4.11 — color extraction + luminance

  // No "skip PROBE entirely" shortcut. Every template representative gets the
  // full mandatory suite. A page with zero SCAN issues can still fail reflow
  // or text-spacing — those tests require browser rendering that SCAN's
  // axe-light doesn't perform.

  return [...new Set(plan)];
}
```

### Representative Selection

The representative is the URL that will be PROBE-tested on behalf of the entire template. Choosing poorly (e.g., the first URL alphabetically) risks missing capability-dependent tests — if the representative has no forms, error-identification never runs for that template.

**Selection criteria: maximize capability coverage.**

```typescript
function selectRepresentative(
  cluster: TemplateCluster,
  scanResults: Map<string, ScanResult>,
): string {
  return cluster.urls.reduce((best, url) => {
    const page = scanResults.get(url)!;
    // Weight by test-triggering potential
    const score =
      (page.capabilities.hasForms ? 4 : 0) +      // triggers error-identification (heaviest)
      (page.capabilities.hasMedia ? 3 : 0) +       // triggers multimedia + timed-events
      (page.capabilities.hasCarousel ? 2 : 0) +    // triggers timed-events
      (page.capabilities.hasDataTables ? 1 : 0) +  // tie-breaker
      (page.lightIssueCount > 0 ? 1 : 0);          // prefer pages with known issues
    return score > best.score ? { url, score } : best;
  }, { url: cluster.urls[0], score: -1 }).url;
}
```

**Why not the first URL**: If a template has 18 product pages but only 2 have video, picking the first (no video) means multimedia tests never run for that template. The page with the most capabilities triggers the most tests, maximizing PROBE coverage.

**Hamming threshold: ≤ 8 bits** (out of 64). Google uses ≤3 for text content; DOM structure is noisier, needs wider threshold. Two pages must share BOTH similar SimHash AND same URL pattern to be grouped.

### PROBE Template Cap

Without a cap, a site with 200 highly varied pages could generate 150+ templates, making PROBE slower than v3 (150 × 18s = 2700s vs v3's 2400s). Hard limit: **MAX_PROBE_TEMPLATES = 25**.

```typescript
const MAX_PROBE_TEMPLATES = 25;

function prioritizeTemplates(clusters: TemplateCluster[]): {
  probed: TemplateCluster[];
  skipped: TemplateCluster[];
} {
  if (clusters.length <= MAX_PROBE_TEMPLATES) {
    return { probed: clusters, skipped: [] };
  }

  // Sort by: page count × capability richness (more pages + more capabilities = higher impact)
  const sorted = [...clusters].sort((a, b) => {
    const capScore = (c: TemplateCluster) =>
      1 + Object.values(c.capabilities).filter(Boolean).length;
    return (b.urls.length * capScore(b)) - (a.urls.length * capScore(a));
  });

  return {
    probed: sorted.slice(0, MAX_PROBE_TEMPLATES),
    skipped: sorted.slice(MAX_PROBE_TEMPLATES),
  };
}
```

**Skipped templates** retain their SCAN axe-light issues (already persisted) but receive no PROBE analysis. The coverage report notes them as "partial coverage — SCAN only". This caps PROBE worst-case at ~450s (25 × 18s).

### Risk: Content-Level Issues Across Templates

Per WebAIM Million 2024, the most common WCAG failures:

| Issue | Template-level? |
|-------|----------------|
| Low contrast (81%) | Yes — same CSS |
| Missing alt text (54.5%) | **No — per image** |
| Missing form labels (48.6%) | Mixed |
| Empty links (44.6%) | **No — per link** |
| Empty buttons (28.2%) | Mixed |
| Missing doc language (17.1%) | Yes |

**This is why SCAN runs axe-light on ALL pages** — `image-alt`, `link-name`, `button-name`, `label` catch the content-level issues that template deduplication would miss.

## Phase 3: PROBE — Deep Analysis on Representatives

Runs only on template representatives (typically 5-15 pages out of 50-100).

### PROBE uses different Playwright settings than SCAN

PROBE runs sequentially (1 representative at a time) but still needs context recycling. The same Playwright memory leak (#6319) applies: ~30MB accumulated per page that isn't freed on `page.close()`. With 12+ representatives, that's ~360MB of leaked memory during the most resource-intensive phase.

Recycle the PROBE context every 5 representatives (lower threshold than SCAN because PROBE pages are heavier — full resource loading, CSS computation, viewport manipulation):

```typescript
const PROBE_PAGES_PER_CONTEXT = 5;

/** Encapsulates PROBE context lifecycle — no global mutable state. */
class ProbeContextManager {
  private context: BrowserContext | null = null;
  private pagesSinceRecycle = 0;

  constructor(private readonly browser: Browser) {}

  async get(): Promise<BrowserContext> {
    if (!this.context || this.pagesSinceRecycle >= PROBE_PAGES_PER_CONTEXT) {
      await this.close(); // safe if context is null
      this.context = await this.browser.newContext({
        userAgent: CHROME_UA,
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      await installConsentBlocker(this.context);
      await installResourceBlocker(this.context, "probe"); // only block fonts
      this.pagesSinceRecycle = 0;
    }
    this.pagesSinceRecycle++;
    return this.context;
  }

  /** Always safe to call — closes context and resets state. */
  async close(): Promise<void> {
    if (this.context) {
      try { await this.context.close(); } catch { /* already disconnected */ }
    }
    this.context = null;
    this.pagesSinceRecycle = 0;
  }
}

// PROBE phase — ProbeContextManager is scoped to this phase, no global state leaks:
const probeCtx = new ProbeContextManager(browser);
try {
  for (const cluster of templates) {
    const context = await probeCtx.get();
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "load", timeout: 60_000 });
      await injectConsentPrehideCSS(page);
      // ... run full test suite ...
    } finally {
      try { await page.close(); } catch { /* already closed/disconnected */ }
      await tracer.flush(); // persist spans per representative — MUST survive page.close() failure
    }
  }
} finally {
  await probeCtx.close(); // ALWAYS runs — crash, OOM, disconnect, or success
}
```

**Why a class, not global variables**: `getProbeContext` with module-level `let probeContext` / `let probePagesSinceRecycle` leaves corrupted state if the PROBE phase throws. The next audit processed by the same worker would inherit a stale (possibly disconnected) context and a wrong recycle counter. `ProbeContextManager` is instantiated per audit, scoped inside `try/finally`, and `close()` resets all state unconditionally.

**Why 5, not 25**: PROBE pages load all resources (images, CSS, scripts), run viewport manipulations that trigger full re-layouts, and inject CSS that creates additional computed style state. Each PROBE page accumulates more residual memory than a SCAN page. 5 × ~30MB = ~150MB leaked before recycle — acceptable. 12 × ~30MB = ~360MB — risks OOM on the VPS.

### Full axe-core with WCAG 2.2 Tags

```typescript
const results = await new AxeBuilder({ page })
  .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
  .options({
    resultTypes: ["violations", "incomplete"],  // skip passes/inapplicable selectors — 40-60% faster
  })
  .analyze();
```

### 8 New WCAG Tests — Implementation by Cost Tier and Release Phase

Not all 8 tests ship in v4.0. Each is an independent feature with its own edge cases. Phased delivery:

| Phase | Tests | Rationale |
|-------|-------|-----------|
| **v4.0** (pipeline core) | reflow, text-spacing, resize-text, multimedia, timed-events | Straightforward: viewport manipulation + CSS injection + `page.evaluate()` |
| **v4.1** (post-pipeline) | error-identification, target-size (custom supplement) | Form interaction + bounding box computation, more edge cases |
| **v4.2** (research needed) | non-text-contrast | Full gap in open-source axe-core. Requires color extraction via `getComputedStyle()`, relative luminance computation, gradient/image/SVG edge cases |

`buildTestPlan` includes only the tests implemented for the current release. The WCAG coverage matrix updates honestly per release.

#### Tier A: `page.evaluate()` only (~15-25ms each)

**Multimedia (1.2.1-1.2.5)**: Detects `<video>` without `<track kind="captions">`, `<audio>` without captions, YouTube/Vimeo iframes (flagged for manual verification).

**Timed Events (2.2.1-2.2.2)**: Detects `<meta http-equiv="refresh">`, `<marquee>`, infinite CSS animations on visible elements, carousel patterns (`[aria-roledescription="carousel"]`, `.carousel`, `.slider`, `[data-ride="carousel"]`).

**Target Size (2.5.8)**: Detects interactive elements (`a`, `button`, `input`, `[role="button"]`, etc.) with bounding box < 24×24px. Note: already covered by axe-core `target-size` rule when `wcag22aa` tag is enabled — run custom check only as supplement.

#### Tier B: CSS/viewport manipulation (~150-400ms each)

**Reflow (1.4.10)**: Set viewport to 320px width, check `document.documentElement.scrollWidth > clientWidth`, identify elements with fixed px widths > 320px or `overflow: hidden` with horizontal overflow. Exempt: `<table>`, `<video>`, `<canvas>`, `<svg>`, `<pre>`, `<code>`.

**Text Spacing (1.4.12)**: Inject CSS with `line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; p { margin-bottom: 2em !important; }`. Check for elements where `scrollHeight > clientHeight` or `scrollWidth > clientWidth` with `overflow: hidden`.

**Resize Text (1.4.4)**: Static check for `meta[viewport]` with `user-scalable=no` or `maximum-scale < 2`. Halve viewport to simulate 200% zoom and check for horizontal overflow. Detect inline `font-size` using viewport units (`vw`/`vh`).

**Non-text Contrast (1.4.11)**: Extract `borderColor` and `backgroundColor` of interactive elements (`button`, `input`, `select`, `[role="checkbox"]`, etc.). Compute WCAG relative luminance and contrast ratio. Flag elements where border contrast < 3:1. Note: this is a **full gap in open-source axe-core** (only in axe DevTools Pro).

#### Tier C: Form interaction (~1-2s per form)

**Error Identification (3.3.1-3.3.3)**: For forms with required fields (skip forms with `action` matching `payment|checkout|stripe|paypal|oauth|login`): click submit without filling fields, check for `aria-invalid`, `aria-describedby` pointing to error text, `[role="alert"]`, or `.error` elements. Detect page navigation and go back immediately.

#### Test Execution Order (within a single PROBE page)

```
1. axe-core full (needs clean DOM)
2. page.evaluate()-only tests in parallel (multimedia, timing, target-size, non-text contrast)
3. Interactive tests (tab order, focus visibility, keyboard traps, skip nav)
4. Viewport tests sequentially (reflow 320px → restore → resize 640px → restore)
5. Text spacing (CSS injection — modifies page, run last before reload)
6. Error identification (form interaction — risk of navigation, run absolute last)
```

### Template Amplification — Only for Template-Level Issues

Not all issues found on a representative apply to all pages in the template. The key distinction:

- **Template-level issues** (driven by shared CSS/HTML structure): color contrast, heading hierarchy, landmark structure, missing lang, ARIA roles, reflow, text-spacing, focus order, keyboard traps. These are safe to amplify because all pages in a template share the same CSS and structural DOM.
- **Content-level issues** (vary per page): missing alt text, empty links, empty buttons, missing form labels, document title. These are NOT amplified — they were already caught by axe-light during SCAN on every individual page.
- **Capability-level issues** (depend on page-specific content): error-identification (requires forms), multimedia (requires video/audio). These are reported ONLY for the representative that was actually tested, not amplified.

```typescript
// Issue classification for amplification
const TEMPLATE_LEVEL_RULES = new Set([
  // axe-core rules driven by CSS/structure (same across template)
  "color-contrast", "color-contrast-enhanced", "heading-order",
  "landmark-one-main", "region", "bypass", "html-has-lang",
  "html-lang-valid", "page-has-heading-one", "tabindex",
  // Custom test results driven by structure
  "reflow", "text-spacing", "resize-text", "non-text-contrast",
  "focus-order", "focus-visible", "keyboard-trap", "skip-nav",
  "target-size",
]);

for (const cluster of templates) {
  const probeIssues = await runProbeTests(cluster.representative, cluster.testPlan);

  // Separate template-level issues (safe to amplify) from the rest
  const templateIssues = probeIssues.filter(i => TEMPLATE_LEVEL_RULES.has(i.rule));

  // Representative page: gets ALL issues (template + content + capability)
  const repPageId = await insertPage(auditId, {
    url: cluster.representative, templateId: cluster.id, isRepresentative: true,
  });
  await insertIssues(auditId, repPageId, probeIssues);

  // Other pages in template: get ONLY template-level issues
  for (const url of cluster.urls.filter(u => u !== cluster.representative)) {
    const pageId = await insertPage(auditId, {
      url, templateId: cluster.id, isRepresentative: false,
    });
    // Template-level issues: amplified with explicit count
    await insertIssues(auditId, pageId, templateIssues.map(issue => ({
      ...issue,
      templateId: cluster.id,
      amplifiedFrom: cluster.representative,  // traceability: where was this actually tested
      affectedPages: cluster.urls.length,
    })));
    // Content-level issues for this page came from SCAN axe-light (already in DB)
    // Capability-level issues: NOT amplified (only tested on representative)
  }
}
```

**What the report shows**: "Color contrast issue on product template (tested on /products/shoes, applies to 18 pages with same CSS)" — accurate. It does NOT say "error-identification issue on 18 pages" when only 1 was tested.
```

## Observability: Structured Spans

### Schema

```sql
CREATE TABLE audit_spans (
  id             BIGSERIAL PRIMARY KEY,
  audit_id       UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  trace_id       UUID NOT NULL,
  span_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  parent_span_id UUID,
  name           TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ,
  duration_ms    INTEGER GENERATED ALWAYS AS (
                   EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000
                 ) STORED,
  status         TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','timeout')),
  error_message  TEXT,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_spans_audit ON audit_spans(audit_id);
CREATE INDEX idx_spans_trace ON audit_spans(trace_id);
CREATE INDEX idx_spans_name ON audit_spans(name);
CREATE INDEX idx_spans_metadata ON audit_spans USING GIN(metadata);
```

### Tracer (~60 lines, zero dependencies)

```typescript
class Span {
  readonly spanId = randomUUID();
  readonly startedAt = new Date();
  private endedAt: Date | null = null;
  private status: "ok" | "error" | "timeout" = "ok";
  private errorMessage: string | null = null;
  private meta: Record<string, unknown> = {};

  constructor(
    readonly auditId: string,
    readonly traceId: string,
    readonly name: string,
    readonly parentSpanId: string | null = null,
  ) {}

  setMeta(data: Record<string, unknown>): this {
    Object.assign(this.meta, data);
    return this;
  }

  end(status: "ok" | "error" | "timeout" = "ok", error?: string): this {
    this.endedAt = new Date();
    this.status = status;
    this.errorMessage = error ?? null;
    return this;
  }

  toRecord(): SpanRecord { /* ... */ }
}

class AuditTracer {
  readonly traceId = randomUUID();
  private spans: Span[] = [];

  constructor(readonly auditId: string) {}

  async trace<T>(name: string, fn: (span: Span) => Promise<T>, parent?: string): Promise<T> {
    const span = new Span(this.auditId, this.traceId, name, parent ?? null);
    this.spans.push(span);
    try {
      const result = await fn(span);
      span.end("ok");
      return result;
    } catch (err) {
      span.end("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Flush persisted spans and clear buffer. Called at phase boundaries, not just at end. */
  async flush(): Promise<void> {
    if (this.spans.length === 0) return;
    await persistSpans(this.spans.map(s => s.toRecord()));
    this.spans = [];
  }
}
```

**Flush strategy: at phase boundaries, not just at end.**

If `flush()` is only called at the end of the audit, a crash at any point loses all observability data — exactly when you need it most (OOM, Browserless disconnect, unhandled exception).

Instead, flush at each phase boundary:

```typescript
// Phase 1: SCAN
for (const url of urls) {
  await tracer.trace("scan:page", async (span) => { /* ... */ });
}
await tracer.flush(); // ← persists all SCAN spans even if CLASSIFY/PROBE crash

// Phase 2: CLASSIFY
await tracer.trace("audit:classify", async (span) => { /* ... */ });
await tracer.flush(); // ← persists CLASSIFY span even if PROBE crashes

// Phase 3: PROBE — flush after EACH representative (heaviest, most crash-prone phase)
for (const cluster of templates) {
  await tracer.trace("probe:representative", async (span) => { /* ... */ });
  await tracer.flush(); // ← each representative's spans survive even if the next one OOMs
}

// Final flush for post-processing spans
await tracer.flush();
```

### Span Taxonomy

| Span name | metadata |
|-----------|----------|
| `audit:run` | `url`, `maxPages`, `startMemoryMb`, `endMemoryMb` |
| `audit:scan` | `pageCount`, `avgTimeMs`, `contextRecycles` |
| `audit:classify` | `templateCount`, `representativeCount` |
| `audit:probe` | `testsRun`, `issuesFound` |
| `scan:page` | `url`, `lightIssueCount`, `elementCount`, `fingerprint` |
| `probe:axe` | `url`, `violationCount`, `ruleCount` |
| `probe:interactive` | `url`, `tabStops`, `focusIssues`, `keyboardTraps` |
| `probe:reflow` | `url`, `overflowElements` |
| `probe:text-spacing` | `url`, `clippedElements` |
| `probe:multimedia` | `url`, `videosWithoutCaptions`, `iframes` |
| `probe:error-id` | `url`, `formsSubmitted`, `errorsDetected` |

## Database Changes

### New table: `audit_spans` (see schema above)

### New JSONB fields in `audits`

```sql
ALTER TABLE audits ADD COLUMN template_clusters JSONB;  -- [{id, fingerprint, urls, representative, capabilities}]
ALTER TABLE audits ADD COLUMN coverage JSONB;            -- {tested: [...], partial: [...], manual: [...], score: 87}
ALTER TABLE audits ADD COLUMN regression JSONB;          -- {newIssues: [...], resolvedIssues: [...], changedTemplates: [...]}
```

### New columns in `issues`

```sql
ALTER TABLE issues ADD COLUMN template_id TEXT;            -- links issue to template cluster
ALTER TABLE issues ADD COLUMN affected_pages INTEGER DEFAULT 1;  -- template amplification count
ALTER TABLE issues ADD COLUMN amplified_from TEXT;         -- URL of representative where issue was actually tested (NULL = tested on this page)
```

### Batch INSERT optimization

Replace per-row INSERT loop with single multi-row insert:

```typescript
// Before (v3): N round trips
await db.begin(async tx => {
  for (const issue of issues) {
    await tx`INSERT INTO issues ...`;
  }
});

// After (v4): 1 round trip
await db`INSERT INTO issues ${db(issues.map(i => ({
  audit_id: auditId, page_id: pageId,
  rule: i.rule, impact: i.impact, selector: i.selector,
  xpath: i.xpath, check_source: i.checkSource,
  category: i.category, suggested_fix: i.suggestedFix,
  fix_confidence: i.fixConfidence, template_id: i.templateId,
  affected_pages: i.affectedPages,
  amplified_from: i.amplifiedFrom ?? null,
})))}`;
```

## Dead Code Removal

| What | Where | Why |
|------|-------|-----|
| `dismissCookieBanner()` | `audit.ts:400-431` | Replaced by network blocking |
| `groupedByRule` construction | `audit.ts:194-198` | Built but never read |
| `discoveryMethods: {}` | `audit.ts:206` | Always empty |
| Duplicate `page.title()` call | `audit.ts:191` | Already fetched at line 174 |
| 9 separate `.filter()` scans | `audit.ts:296-297` | Replace with single-pass aggregation |
| `updateAuditProgress()` | `db.ts:54-63` | Never called anywhere |
| `buildMultimodalMessage` | `llm/client.ts:155-167` | No callers |
| `COST_PER_TOKEN_USD` | `llm/client.ts:150` | No callers |
| `pages[]` in-memory accumulation | `audit.ts:80` | Stream to DB instead |

## Browserless Configuration

```yaml
# docker-compose.yml
browserless:
  image: ghcr.io/browserless/chromium
  environment:
    CONCURRENT: 3
    QUEUED: 15
    TIMEOUT: 600000
    HEALTH: "true"
    MAX_MEMORY_PERCENT: 80
    MAX_CPU_PERCENT: 85
    CHROME_FLAGS: >-
      --disable-dev-shm-usage
      --disable-gpu
      --disable-extensions
      --disable-background-networking
      --no-zygote
      --disable-background-timer-throttling
      --disable-renderer-backgrounding
```

### Browser Reconnection

v3's `getBrowser()` pattern (reconnect on WebSocket disconnect) is critical for long audits. A 200-page audit (~7 min) can lose the Browserless connection due to container restart, OOM kill, or WebSocket timeout.

**The pipeline receives `getBrowser`, not `browser` directly.** SlotPool and ProbeContextManager call `getBrowser()` when they detect a disconnect:

```typescript
// Worker passes getBrowser into the pipeline (same pattern as v3)
async function runPipeline(
  getBrowser: () => Promise<Browser>,
  auditId: string,
  config: AuditConfig,
) {
  let browser = await getBrowser();

  // ContextSlot.get() checks browser health before creating context
  // If disconnected, it calls getBrowser() to reconnect
  class ContextSlot {
    async get(getBrowser: () => Promise<Browser>): Promise<BrowserContext> {
      if (!browser.isConnected()) {
        browser = await getBrowser(); // transparent reconnect
        this.context = null; // force new context on reconnected browser
      }
      if (!this.context || this.pagesSinceRecycle >= PAGES_PER_CONTEXT) {
        if (this.context) {
          try { await this.context.close(); } catch { /* disconnected */ }
        }
        this.context = await browser.newContext({ /* ... */ });
        // ... install blockers ...
      }
      return this.context;
    }
  }

  // Same pattern in ProbeContextManager.get()
}
```

**Why not `browser.on("disconnected")`**: The event fires asynchronously — by the time it runs, a SCAN page may already be mid-navigation on the dead browser. Checking `browser.isConnected()` synchronously before each context creation is more reliable.

## WCAG Coverage Matrix

Every audit produces a transparent coverage report showing which criteria are tested and how.

```
WCAG 2.2 AA Coverage by Release:

── v4.0 (~75% — 20/29 automatable criteria) ──

✅ Automated (axe-core + custom):
  1.1.1 Non-text Content (axe: image-alt, input-image-alt, ...)
  1.2.2 Captions (custom: video-caption check)
  1.3.1 Info and Relationships (axe: list, listitem, definition-list, ...)
  1.3.4 Orientation (custom: meta-viewport check)
  1.3.5 Input Purpose (custom: autocomplete check)
  1.4.1 Use of Color (axe: link-in-text-block)
  1.4.3 Contrast (axe: color-contrast)
  1.4.4 Resize Text (custom: meta-viewport + zoom simulation)
  1.4.10 Reflow (custom: 320px viewport test)
  1.4.12 Text Spacing (custom: CSS injection test)
  2.1.1 Keyboard (axe + custom: keyboard operability)
  2.1.2 No Keyboard Trap (custom: keyboard trap detection)
  2.2.1 Timing Adjustable (custom: meta-refresh, carousel detection)
  2.2.2 Pause Stop Hide (custom: autoplay, infinite animation detection)
  2.4.1 Bypass Blocks (custom: skip-nav detection)
  2.4.2 Page Titled (axe: document-title)
  2.4.3 Focus Order (custom: tab order test)
  2.4.7 Focus Visible (custom: focus indicator test)
  4.1.2 Name, Role, Value (axe: button-name, link-name, ...)

⚠️ Partially automated:
  1.2.1 Audio-only (detected, quality needs manual check)
  1.2.5 Audio Description (detected, quality needs manual check)

── v4.1 additions (~85%) ──
  2.5.8 Target Size (custom: bounding box < 24×24px detection)
  3.3.1 Error Identification (custom: form submission test)
  3.3.3 Error Suggestion (form error presence checked, suggestion quality manual)

── v4.2 additions (~90%) ──
  1.4.11 Non-text Contrast (custom: border/background contrast computation)

❌ Not automatable (manual review required — all versions):
  1.3.3 Sensory Characteristics
  2.4.6 Heading descriptiveness (structure checked, meaning manual)
  3.2.3-3.2.4 Consistent Navigation/Identification
```

## Regression Diff (v4.1 — deferred from v4.0)

> **Not implemented in v4.0.** Regression diff requires: (1) at least 2 completed audits for the same site, (2) stabilized template schema from production usage, (3) real-world testing of the multi-signal matching heuristics. The DB schema fields (`regression` JSONB) are added in v4.0 but left NULL. Frontend regression UI ships in v4.1.

### The fingerprint stability problem

SimHash fingerprints are NOT stable across audits. Any DOM change — a new banner, an A/B test, a dynamic component, a seasonal promotion widget — shifts the fingerprint. Relying on exact fingerprint match for regression would silently miss real regressions (fingerprints don't match → creates "new template" instead of detecting change in existing one).

### Solution: Multi-signal template matching

Match templates across audits using a ranked cascade, not a single fingerprint:

```typescript
interface RegressionDiff {
  matched: Array<{
    currentTemplateId: string;
    previousTemplateId: string;
    matchMethod: "url-pattern" | "fingerprint-near" | "representative-url";
    newIssues: Array<{ rule: string; impact: string }>;
    resolvedIssues: Array<{ rule: string; impact: string }>;
  }>;
  unmatchedNew: string[];      // templates in current with no previous match
  unmatchedRemoved: string[];  // templates in previous with no current match
  scoreChange: number;
}

function matchTemplatesAcrossAudits(
  current: TemplateCluster[],
  previous: TemplateCluster[],
): Map<string, string> {
  const matches = new Map<string, string>(); // current.id → previous.id

  const matchedPrevIds = () => new Set(matches.values());

  // Pass 1: Match by URL pattern (most stable signal — site structure rarely changes)
  for (const curr of current) {
    const usedPrevIds = matchedPrevIds();
    const prev = previous.find(p =>
      p.urlPattern === curr.urlPattern && !usedPrevIds.has(p.id)
    );
    if (prev) matches.set(curr.id, prev.id);
  }

  // Pass 2: Match remaining by near-fingerprint (Hamming ≤ 12, wider than clustering threshold)
  for (const curr of current.filter(c => !matches.has(c.id))) {
    const usedPrevIds = matchedPrevIds();
    const prev = previous.find(p =>
      !usedPrevIds.has(p.id) &&
      hammingDistance(curr.fingerprint, p.fingerprint) <= 12
    );
    if (prev) matches.set(curr.id, prev.id);
  }

  // Pass 3: Match by representative URL overlap (same page used as rep in both audits)
  for (const curr of current.filter(c => !matches.has(c.id))) {
    const usedPrevIds = matchedPrevIds();
    const prev = previous.find(p =>
      !usedPrevIds.has(p.id) &&
      curr.urls.some(u => p.urls.includes(u))
    );
    if (prev) matches.set(curr.id, prev.id);
  }

  return matches;
}
```

**Why this works**: URL patterns (`/products/:id`) are stable even when the DOM changes (a new banner doesn't change the URL structure). Hamming distance ≤ 12 (wider than the ≤ 8 clustering threshold) accommodates minor DOM drift between audits. Representative URL overlap catches cases where both signals fail.

**What remains unmatched**: If a template genuinely doesn't exist in the previous audit (new section of the site) or was removed, it appears in `unmatchedNew`/`unmatchedRemoved` — which is the correct behavior.

Regression comparison then uses `rule + matchedTemplateId`:

```typescript
for (const [currentId, previousId] of matches) {
  const currentIssues = getIssuesForTemplate(currentAudit, currentId);
  const previousIssues = getIssuesForTemplate(previousAudit, previousId);
  // Compare by rule name — stable across fingerprint changes
  const newRules = currentIssues.filter(i => !previousIssues.some(p => p.rule === i.rule));
  const resolvedRules = previousIssues.filter(p => !currentIssues.some(i => i.rule === p.rule));
}
```

## Performance Estimates

### Realistic PROBE time budget per representative

The PROBE phase runs the full test suite sequentially on one page. Honest per-step estimates:

| Step | Time | Notes |
|------|------|-------|
| Navigation (`waitUntil: load`) | 2-5s | Full page load including scripts/CSS |
| CSS prehide injection | ~10ms | |
| axe-core full (wcag22aa tags, violations+incomplete only) | 1-3s | `resultTypes` optimization saves 40-60% |
| page.evaluate()-only tests (multimedia, timing, target-size, non-text contrast) | ~200ms | Batched, parallel |
| Interactive tests (tab order 50 tabs, focus visibility 15 elements, keyboard traps, skip nav) | 3-8s | Sequential keyboard interaction, CDP round-trips |
| Reflow (viewport 320px → evaluate → restore) | ~400ms | Viewport resize + layout recalc |
| Resize text (viewport halve → evaluate → restore) | ~500ms | Second viewport manipulation |
| Text spacing (CSS inject → evaluate) | ~300ms | Modifies page, run late |
| Error identification (per form: click submit, wait 500ms, check DOM) | 1-3s per form | Only on pages with forms, 0-3 forms typical |
| **Total (no forms)** | **8-18s** | Typical simple page |
| **Total (with 2 forms)** | **12-24s** | Page with forms |
| **Total (complex: forms + media + carousel)** | **15-30s** | Worst case |

**Weighted average across templates**: ~18s per representative. Some templates (home, legal) are simple (~10s). Others (contact with forms, media pages) are complex (~25s).

### 50-page site with ~8 templates

| Phase | Pages | Time/page | Concurrency | Total |
|-------|-------|-----------|-------------|-------|
| SCAN | 50 | ~3s | 3 | ~50s |
| CLASSIFY | — | — | — | <1s |
| PROBE | 8 | ~18s (avg) | 1 | ~144s |
| Post-processing | — | — | — | ~5s |
| **Total** | | | | **~200s** |

**vs v3**: 50 × 12s = ~600s. **3× faster with 80% more WCAG coverage.**

### 200-page site with ~12 templates

| Phase | Pages | Time/page | Concurrency | Total |
|-------|-------|-----------|-------------|-------|
| SCAN | 200 | ~3s | 3 | ~200s |
| CLASSIFY | — | — | — | <1s |
| PROBE | 12 | ~18s (avg) | 1 | ~216s |
| **Total** | | | | **~420s** |

**vs v3**: Would take 200 × 12s = 2400s (40 minutes). v4 does it in ~7 minutes.

### Honest caveats on estimates

- SCAN ~3s/page assumes `domcontentloaded` succeeds within 2s. Sites with slow TTFB (shared hosting, geographic distance) may take 5-8s.
- PROBE ~18s average is based on v3 measurements where axe takes 1-3s and interactive tests take 3-8s, plus new viewport/CSS tests. On pages with 100+ interactive elements, interactive tests alone can take 10-15s.
- The 3× speedup comes primarily from not running full PROBE on every page, not from making individual page analysis faster. PROBE per-page is actually slower than v3 (more tests). The win is doing it on 8 pages instead of 50.

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Template fingerprint groups dissimilar pages | Conservative Hamming threshold (≤8/64). Require BOTH SimHash match AND URL pattern match. Err toward more clusters. |
| SCAN axe-light misses issues on non-representatives | Only skips template-level rules. Content rules (`image-alt`, `link-name`, `button-name`, `label`, `document-title`) run on ALL pages. |
| Cookie script blocking breaks page logic | Only blocks third-party consent CDNs. Core site functionality never depends on CookieBot/OneTrust. CSS prehide as safety net. |
| New visual tests false positives | Tolerances: 2px for overflow detection, exempt known elements (tables, video, code blocks). Observe false positive rate via spans. |
| Concurrent pages cause OOM | Semaphore hard limit at 3. One BrowserContext per slot (session isolation), each recycled every 25 pages. Browserless `HEALTH=true` + `MAX_MEMORY_PERCENT=80` rejects requests above threshold. |
| Template amplification reports false issues | Only template-level issues (CSS/structure-driven) are amplified. Content-level issues (alt, link-name) caught by SCAN on every page. Capability-level issues (form errors, multimedia) reported only for the tested representative. Every amplified issue includes `amplifiedFrom` field for traceability. |
| Regression fingerprints drift between audits | Multi-signal matching: URL pattern (most stable) → near-fingerprint (Hamming ≤12) → representative URL overlap. Unmatched templates correctly reported as new/removed. |
| Form submission test triggers real actions | Safety filters: skip forms with payment/auth keywords in action URL. Detect navigation post-submit and go back. Never fill fields — only test empty submission error handling. |
| CSR sites yield empty DOM with domcontentloaded | SPA shell detection (`app-root`, `#root`, `#__next`) + LLM nav discovery fallback. Only ~5% of pages trigger this, adding 1-2s each. |
| Too many templates overwhelm PROBE | MAX_PROBE_TEMPLATES = 25. Prioritize by page count × capability richness. Skipped templates retain SCAN axe-light issues. Caps PROBE worst-case at ~450s. |
| Browserless WebSocket disconnect mid-audit | `getBrowser()` reconnect pattern from v3. ContextSlot and ProbeContextManager check `browser.isConnected()` before context creation, reconnect transparently. |
| SCAN page failures (timeout, 4xx, DNS) | Explicit error table: 5xx retried once, all failures recorded in `crawl_errors`, never block the rest of the crawl. |

## Migration Scope

### v4.0 (pipeline core)
- **Worker**: Complete rewrite of `audit.ts` pipeline (SCAN → CLASSIFY → PROBE)
- **Analyzer**: New files for 5 WCAG tests (reflow, text-spacing, resize-text, multimedia, timed-events) + cookie blocker + fingerprinter + tracer + LLM nav fallback
- **DB**: Migration for `audit_spans` table + new columns (`template_id`, `affected_pages`, `amplified_from`, `regression` NULL placeholder)
- **API Server**: Unchanged (serves same data, new fields are additive JSONB)
- **Frontend**: Progressive adoption — template info, coverage matrix

### v4.1 (post-pipeline)
- **Analyzer**: Add error-identification + target-size custom tests
- **Regression**: Implement `matchTemplatesAcrossAudits` + regression diff UI
- **Frontend**: Regression comparison view

### v4.2 (research)
- **Analyzer**: Non-text contrast (1.4.11) — color extraction, luminance computation, edge cases

## Dependencies

No new runtime dependencies needed. All implementations use:
- `playwright` (already installed) — BrowserContext, page.evaluate, page.route, AxeBuilder
- `@axe-core/playwright` (already installed) — AxeBuilder with tag filtering
- `crypto.randomUUID()` (built-in) — for span/trace IDs

The `linkedom`, `jsdom`, and direct `axe-core` imports added during spikes should be removed.
