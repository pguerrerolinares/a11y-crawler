# Differential Probe Phase 2: Batch Parallel + Prefetch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Overlap read-only phases (P1+P2) of the next template with mutating phases (P3+P4) of the current template, reducing probe time by 3-7s.

**Architecture:** Refactor `ProbeContextManager` to a lease-based model supporting multiple concurrent pages. Restructure the probe loop to process templates in overlapping batches: while template A runs P3+P4 (viewport mutations + screenshots), template B starts nav+P1+P2 (read-only). RAM guard degrades to sequential when memory exceeds threshold. Speculative manifest prefetch during P3+P4 only (not during batch P1+P2 to avoid 3 concurrent pages).

**Tech Stack:** TypeScript, Bun, Playwright

**Spec:** `docs/superpowers/specs/2026-03-25-differential-probe-design.md` §3.1, §3.7
**Depends on:** Phase 1 (completed — caches maximize overlap benefit)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/worker/probe-context.ts` | **Rewrite** | Lease-based ProbeContextManager with activePages tracking |
| `src/worker/__tests__/probe-context.test.ts` | **Modify** | Tests for lease-based context, recycling, concurrent pages |
| `src/worker/probe.ts` | **Modify** | Restructure template loop for overlapping P1+P2 / P3+P4 |
| `src/worker/ram-guard.ts` | **Create** | RAM threshold check, dynamic batch size |

---

### Task 1: Lease-based ProbeContextManager

**Files:**
- Rewrite: `src/worker/probe-context.ts`
- Modify: `src/worker/__tests__/probe-context.test.ts`

**Context:** Current `ProbeContextManager.get()` returns a BrowserContext and increments `pagesSinceRecycle`. It can recycle the context while a page is still open. The lease-based model returns a `{ page, release }` tuple and only recycles when `activePages === 0`.

- [ ] **Step 1: Write failing tests for lease-based API**

```typescript
// src/worker/__tests__/probe-context.test.ts
import { test, expect, mock } from "bun:test";
import { ProbeContextManager } from "../probe-context";

// Mock browser and context
function mockBrowser() {
  const pages: Array<{ close: () => Promise<void> }> = [];
  const context = {
    newPage: mock(async () => {
      const page = { close: mock(async () => {}), goto: mock(async () => {}), url: () => "http://test" };
      pages.push(page);
      return page;
    }),
    close: mock(async () => {}),
  };
  const browser = {
    newContext: mock(async () => context),
  };
  return { browser, context, pages };
}

test("lease: returns page and release function", async () => {
  const { browser } = mockBrowser();
  const mgr = new ProbeContextManager(async () => browser as any, 5);
  const lease = await mgr.lease();
  expect(lease.page).toBeDefined();
  expect(typeof lease.release).toBe("function");
  await lease.release();
  await mgr.close();
});

test("lease: does not recycle context while pages are active", async () => {
  const { browser, context } = mockBrowser();
  const mgr = new ProbeContextManager(async () => browser as any, 2);

  // Lease 2 pages (hits pagesPerContext limit)
  const lease1 = await mgr.lease();
  const lease2 = await mgr.lease();

  // Context should NOT be closed yet (2 active pages)
  expect(context.close).not.toHaveBeenCalled();

  // Release first page
  await lease1.release();
  // Still 1 active page — no recycle
  expect(context.close).not.toHaveBeenCalled();

  // Release second page — now 0 active, should recycle on next lease
  await lease2.release();

  // Next lease triggers recycle (pagesSinceRecycle >= pagesPerContext AND activePages === 0)
  const lease3 = await mgr.lease();
  expect(context.close).toHaveBeenCalledTimes(1);
  await lease3.release();
  await mgr.close();
});

test("lease: two concurrent pages share same context", async () => {
  const { browser } = mockBrowser();
  const mgr = new ProbeContextManager(async () => browser as any, 5);

  const lease1 = await mgr.lease();
  const lease2 = await mgr.lease();

  // Both pages are in the same context (newContext called once)
  expect(browser.newContext).toHaveBeenCalledTimes(1);

  await lease1.release();
  await lease2.release();
  await mgr.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/worker/__tests__/probe-context.test.ts`
Expected: FAIL — `lease` method does not exist

- [ ] **Step 3: Rewrite ProbeContextManager with lease-based API**

```typescript
// src/worker/probe-context.ts
import type { Browser, BrowserContext, Page } from "playwright";
import { installConsentBlocker } from "../analyzer/consent-blocker";
import { installResourceBlocker } from "../analyzer/resource-blocker";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface PageLease {
  page: Page;
  release: () => Promise<void>;
}

export class ProbeContextManager {
  private context: BrowserContext | null = null;
  private pagesSinceRecycle = 0;
  private activePages = 0;

  constructor(
    private readonly getBrowser: () => Promise<Browser>,
    private readonly pagesPerContext: number = 5,
  ) {}

  /**
   * Lease a page from the managed context.
   * Returns { page, release } — caller MUST call release() when done.
   * Context recycling only happens when activePages === 0 AND pagesPerContext exceeded.
   */
  async lease(): Promise<PageLease> {
    // Only recycle when no active pages AND limit exceeded
    if (this.activePages === 0 && this.pagesSinceRecycle >= this.pagesPerContext) {
      await this.recycleContext();
    }

    const context = await this.getOrCreateContext();
    const page = await context.newPage();
    this.activePages++;
    this.pagesSinceRecycle++;

    let released = false;
    return {
      page,
      release: async () => {
        if (released) return; // Idempotent — safe to call multiple times
        released = true;
        try { await page.close(); } catch { /* already closed */ }
        this.activePages--;
      },
    };
  }

  // NOTE: Legacy get() removed. All callers must use lease().
  // This prevents mixed get()/lease() usage which could recycle
  // the context while leased pages are still active.

  async close(): Promise<void> {
    if (this.context) {
      try { await this.context.close(); } catch { /* already disconnected */ }
    }
    this.context = null;
    this.pagesSinceRecycle = 0;
    this.activePages = 0;
  }

  private async getOrCreateContext(): Promise<BrowserContext> {
    if (!this.context) {
      const browser = await this.getBrowser();
      this.context = await browser.newContext({
        userAgent: CHROME_UA,
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      await installConsentBlocker(this.context);
      await installResourceBlocker(this.context, "probe");
      this.pagesSinceRecycle = 0;
    }
    return this.context;
  }

  private async recycleContext(): Promise<void> {
    if (this.context) {
      try { await this.context.close(); } catch { /* already disconnected */ }
    }
    this.context = null;
    this.pagesSinceRecycle = 0;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/worker/__tests__/probe-context.test.ts`
Expected: 3 PASS

- [ ] **Step 5: Run full test suite + tsc**

Run: `bunx tsc --noEmit && bun test --timeout 30000`
Expected: All PASS (legacy `get()` API still works for existing probe.ts code)

- [ ] **Step 6: Commit**

```bash
git add src/worker/probe-context.ts src/worker/__tests__/probe-context.test.ts
git commit -m "feat: lease-based ProbeContextManager (concurrent pages, safe recycling)"
```

---

### Task 2: RAM guard utility

**Files:**
- Create: `src/worker/ram-guard.ts`
- Create: `src/worker/__tests__/ram-guard.test.ts`

**Context:** On 4GB VPS with ~1.9GB available, 2 concurrent renderers add ~200-300MB. RAM guard checks RSS and degrades to sequential when memory is too high.

- [ ] **Step 1: Write tests**

```typescript
// src/worker/__tests__/ram-guard.test.ts
import { test, expect } from "bun:test";
import { shouldBatch } from "../ram-guard";

test("shouldBatch: returns boolean", () => {
  const result = shouldBatch();
  expect(typeof result).toBe("boolean");
});

test("shouldBatch: injectable getAvailableMemory for deterministic testing", () => {
  // Well above threshold → batch
  expect(shouldBatch(() => 800 * 1024 * 1024)).toBe(true);
  // Below threshold → sequential
  expect(shouldBatch(() => 200 * 1024 * 1024)).toBe(false);
});
```

- [ ] **Step 2: Write implementation**

```typescript
// src/worker/ram-guard.ts
import { readFileSync } from "node:fs";

/**
 * Get total system available memory in bytes.
 * Reads /proc/meminfo on Linux (accounts for Chromium child processes).
 * Returns Infinity on non-Linux (always allows batching in dev).
 *
 * Note: MemAvailable includes reclaimable filesystem cache — intentionally
 * conservative. False degradation to sequential is better than OOM.
 */
function defaultGetAvailableMemory(): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf-8");
    const match = meminfo.match(/MemAvailable:\s+(\d+)/);
    if (match) return parseInt(match[1]) * 1024; // kB to bytes
  } catch {
    // Not Linux or no access
  }
  return Infinity;
}

const BATCH_MEMORY_THRESHOLD = 400 * 1024 * 1024; // 400MB minimum available

/**
 * Returns true if there's enough memory for 2 concurrent pages.
 * Uses system available memory (not just process RSS) because
 * Chromium renderers are separate processes.
 *
 * @param getAvailableMemory - injectable for testing
 */
export function shouldBatch(
  getAvailableMemory: () => number = defaultGetAvailableMemory,
): boolean {
  const available = getAvailableMemory();
  return available > BATCH_MEMORY_THRESHOLD;
}
```

- [ ] **Step 3: Run tests**

Run: `bun test src/worker/__tests__/ram-guard.test.ts`
Expected: 2 PASS

- [ ] **Step 4: Commit**

```bash
git add src/worker/ram-guard.ts src/worker/__tests__/ram-guard.test.ts
git commit -m "feat: RAM guard for batch parallel probe (400MB threshold)"
```

---

### Task 3: Restructure probe loop for overlapping execution

**Files:**
- Modify: `src/worker/probe.ts` (major refactor of template loop)

**Context:** Current loop processes templates sequentially: `for (cluster of templates) { nav → P1 → P2 → P3 → P4 }`. We restructure so that while template A runs P3+P4, template B starts nav+P1+P2 in a second page.

**The overlap pattern:**
```
Template A: [nav → P1 → P2] → [P3 → P4] ←─ while this runs...
Template B:                     [nav → P1 → P2] → [P3 → P4] ←─ ...this starts
Template C:                                        [nav → P1 → P2] → [P3 → P4]
```

P3+P4 run on page A while P1+P2 of page B run on a fresh page in the same context. Both pages coexist safely because P1+P2 are read-only per-page and P3+P4 mutate viewport of page A only.

- [ ] **Step 1: Extract template processing into helper functions**

Refactor the body of the template loop into two functions:

```typescript
/**
 * Phase group 1: Navigation + Tier 0 manifest + Phase 1 (static) + Phase 2 (interaction)
 * Read-only per page — safe to run concurrently with P3+P4 of another page.
 */
async function runReadOnlyPhases(
  page: Page,
  cluster: TemplateCluster,
  url: string,
  timer: TierTimer,
  config: PipelineConfig,
  llmClient: LLMClient | null,
  axeCache: Map<string, Issue[]> | undefined,
  parentSpan: { setMeta: (m: Record<string, unknown>) => void },
  caches: { tier1Cache?: Map<string, { issues: Issue[] }>; evaluateCache?: Map<string, Issue[]>; hfCache?: HoverFocusCache },
  cacheStats: typeof globalCacheStats,
): Promise<{
  issues: Issue[];
  promotedToTier3: ElementManifest[];
  manifest: ElementManifest[];
  cssFingerprint: string;
  phaseTimings: Record<string, number>;
}> {
  // nav + injectConsent + collectManifest + cssFingerprint + P1 + P2
  // Returns everything P3+P4 need
}

/**
 * Phase group 2: Phase 3 (viewport) + Phase 4 (capture)
 * Mutates viewport + takes screenshots — must run alone on the page.
 */
async function runMutatingPhases(
  page: Page,
  cluster: TemplateCluster,
  url: string,
  auditId: string,
  llmClient: LLMClient | null,
  promotedToTier3: ElementManifest[],
  manifest: ElementManifest[],
  cssFingerprint: string,
  caches: { cvdCache: Map<string, any>; viewportCache: Map<string, Issue[]> },
): Promise<{ issues: Issue[]; phaseTimings: Record<string, number> }> {
  // P3 + P4
}
```

- [ ] **Step 2: Implement the overlapping loop**

```typescript
import { shouldBatch } from "./ram-guard";

// In runProbePhase, replace the sequential for loop:
try {
  let pendingMutating: {
    promise: Promise<{ issues: Issue[]; phaseTimings: Record<string, number> }>;
    lease: PageLease;
    cluster: TemplateCluster;
    url: string;
    readOnlyResult: Awaited<ReturnType<typeof runReadOnlyPhases>>;
    // Each template gets its own span ref for correct attribution
    span: { setMeta: (m: Record<string, unknown>) => void };
  } | null = null;

  for (let i = 0; i < templates.length; i++) {
    const cluster = templates[i];
    const url = cluster.representative;

    await tracer.trace("probe:representative", async (parentSpan) => {
      parentSpan.setMeta({ url, templateId: cluster.id, testPlan: cluster.testPlan });
      const timer = new TierTimer(auditId, cluster.id, url);

      // Lease a new page
      const lease = await probeCtx.lease();
      const { page } = lease;

      try {
        // ── Read-only phases: nav + P1 + P2 ──
        const readOnlyResult = await runReadOnlyPhases(
          page, cluster, url, timer, config, llmClient, axeCache,
          parentSpan, { tier1Cache, evaluateCache, hfCache }, templateCacheStats,
        );

        // ── Wait for previous template's mutating phases (if any) ──
        if (pendingMutating) {
          const prev = pendingMutating;
          try {
            const mutatingResult = await prev.promise;
            // Finalize PREVIOUS template with ITS OWN span (not current parentSpan)
            await finalizeTemplate(prev.cluster, prev.url, prev.readOnlyResult,
              mutatingResult, auditId, prev.lease.page, prev.span, tracer);
          } finally {
            await prev.lease.release();
            pendingMutating = null;
          }
        }

        // ── Should we overlap with next template? ──
        const canBatch = shouldBatch() && i < templates.length - 1;

        if (canBatch) {
          // Start P3+P4 in background, proceed to next template
          // SAFETY: viewport and CDP are page-scoped in Playwright,
          // so P3+P4 on page A cannot affect P1+P2 on page B
          pendingMutating = {
            promise: runMutatingPhases(page, cluster, url, auditId, llmClient,
              readOnlyResult.promotedToTier3, readOnlyResult.manifest,
              readOnlyResult.cssFingerprint, { cvdCache, viewportCache }),
            lease, cluster, url, readOnlyResult,
            span: parentSpan, // Capture THIS template's span for later finalization
          };
        } else {
          // Sequential: run P3+P4 now, finalize, release
          const mutatingResult = await runMutatingPhases(page, cluster, url, auditId, llmClient,
            readOnlyResult.promotedToTier3, readOnlyResult.manifest,
            readOnlyResult.cssFingerprint, { cvdCache, viewportCache });
          await finalizeTemplate(cluster, url, readOnlyResult, mutatingResult,
            auditId, page, parentSpan, tracer);
          await lease.release();
        }
      } catch (err) {
        // Clean up BOTH current lease AND any pending mutating
        if (pendingMutating) {
          await pendingMutating.lease.release();
          pendingMutating = null;
        }
        await lease.release();
        throw err;
      }
    });
  }

  // Finalize last template if it was overlapping
  if (pendingMutating) {
    const prev = pendingMutating;
    try {
      const mutatingResult = await prev.promise;
      await finalizeTemplate(prev.cluster, prev.url, prev.readOnlyResult,
        mutatingResult, auditId, prev.lease.page, prev.span, tracer);
    } finally {
      await prev.lease.release();
    }
  }
}
```

**Key design decisions:**
- Only 1 pending mutating at a time (max 2 pages: current in P1+P2, previous in P3+P4)
- `shouldBatch()` checked per template — degrades dynamically if RAM spikes
- Last template always runs sequentially (no next template to overlap with)
- If `pendingMutating` exists when starting a new template, we await it first (never 3 pages)
- Each `pendingMutating` captures its own `span` reference — `finalizeTemplate` writes metadata to the CORRECT template's span
- Error cleanup releases BOTH current lease and any pending mutating lease (no orphaned pages)
- `release()` is idempotent (double-call guard) — safe in both catch and finally blocks
- Viewport/CDP safety comment explains why overlap is safe (page-scoped in Playwright)

- [ ] **Step 3: Implement `finalizeTemplate` helper**

Extracts the template amplification + DB insert logic currently at probe.ts lines ~155-200:

```typescript
async function finalizeTemplate(
  cluster: TemplateCluster,
  url: string,
  readOnlyResult: { issues: Issue[]; phaseTimings: Record<string, number> },
  mutatingResult: { issues: Issue[]; phaseTimings: Record<string, number> },
  auditId: string,
  page: Page,
  parentSpan: { setMeta: (m: Record<string, unknown>) => void },
  tracer: AuditTracer,
): Promise<void> {
  const allIssues = [...readOnlyResult.issues, ...mutatingResult.issues];
  const phaseTimings = { ...readOnlyResult.phaseTimings, ...mutatingResult.phaseTimings };

  // Template amplification
  const templateIssues = allIssues.filter((i) => TEMPLATE_LEVEL_RULES.has(i.rule));

  // Representative page: ALL issues
  const repPageId = await insertPageV4(auditId, {
    url,
    title: await page.title(),
    templateId: cluster.id,
    isRepresentative: true,
    issueCount: allIssues.length,
  });
  await insertIssuesV4(auditId, repPageId, allIssues.map((i) => ({
    // ... existing mapping ...
  })));

  // Other pages: ONLY template-level issues (amplified)
  for (const memberUrl of cluster.urls.filter((u) => u !== url)) {
    // ... existing amplification logic ...
  }

  parentSpan.setMeta({ phaseTimings, totalIssues: allIssues.length });
  await tracer.flush();
}
```

- [ ] **Step 4: Migrate from `probeCtx.get()` to `probeCtx.lease()`**

Replace all uses of `probeCtx.get()` + manual `page.close()` with `probeCtx.lease()` + `lease.release()`.

- [ ] **Step 5: Add overlap metrics to phaseTimings**

```typescript
phaseTimings.overlapped = canBatch; // boolean: was this template overlapped?
phaseTimings.batchSize = canBatch ? 2 : 1;
```

- [ ] **Step 6: Run full test suite**

Run: `bun test --timeout 30000`
Expected: All PASS

- [ ] **Step 7: Verify tsc**

Run: `bunx tsc --noEmit`

- [ ] **Step 8: Commit**

```bash
git add src/worker/probe.ts
git commit -m "feat: overlapping probe loop — P1+P2 of next template runs during P3+P4 of current

Lease-based page management ensures max 2 concurrent pages.
RAM guard degrades to sequential when memory exceeds 400MB available.
Overlap logged in phaseTimings for observability."
```

---

### Task 4: Speculative manifest prefetch (optional optimization)

**Files:**
- Modify: `src/worker/probe.ts` (inside overlapping loop)

**Context:** When running sequentially (batchSize=1, e.g., last template or low RAM), we can still prefetch the next page's navigation during P3+P4. This is a lighter version of full overlap — just the `page.goto()`.

**Note:** This task is optional. The overlapping loop from Task 3 already covers the main case. This handles the fallback sequential path.

- [ ] **Step 1: Add prefetch during sequential P3+P4**

In the sequential branch of the loop (when `!canBatch`):

```typescript
if (!canBatch) {
  // Start prefetching next template's page during P3+P4
  let prefetchLease: PageLease | null = null;
  let prefetchPromise: Promise<void> | null = null;

  if (i < templates.length - 1) {
    const nextUrl = templates[i + 1].representative;
    prefetchLease = await probeCtx.lease();
    prefetchPromise = prefetchLease.page.goto(nextUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).then(() => injectConsentPrehideCSS(prefetchLease!.page)).catch(() => {
      // Prefetch failure is non-fatal — next iteration will navigate normally
      prefetchLease?.release();
      prefetchLease = null;
    });
  }

  // Run P3+P4 while prefetch happens
  const mutatingResult = await runMutatingPhases(...);

  // Wait for prefetch to complete
  if (prefetchPromise) await prefetchPromise;

  // Finalize current template
  await finalizeTemplate(...);
  await lease.release();

  // If prefetch succeeded, the next iteration can skip navigation
  // (store prefetchLease for next iteration to use)
}
```

- [ ] **Step 2: Handle prefetched page in next iteration**

The next iteration checks if a prefetched page exists and uses it instead of creating a new one:

```typescript
// At top of loop:
let lease: PageLease;
if (prefetchedLease) {
  lease = prefetchedLease;
  prefetchedLease = null;
  // Skip goto — already navigated during prefetch
} else {
  lease = await probeCtx.lease();
  await lease.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
}
```

- [ ] **Step 3: Run full test suite + tsc**

Run: `bunx tsc --noEmit && bun test --timeout 30000`

- [ ] **Step 4: Commit**

```bash
git add src/worker/probe.ts
git commit -m "feat: speculative nav prefetch during sequential P3+P4"
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| 2 pages exceed VPS RAM | RAM guard (`shouldBatch()`) degrades to sequential |
| Context recycled while page active | Lease-based: recycle only when `activePages === 0` |
| P3+P4 error orphans pending page | `try/catch` in overlap loop, `lease.release()` in `finally` |
| Prefetch page fails | Non-fatal — next iteration navigates normally |
| Overlapped timings are wrong | Each phase group tracks its own timings independently |

## Expected Results

| Metric | Phase 1 (current) | Phase 2 (target) |
|--------|-------------------|------------------|
| cliente-anonimo probe | 67s | ~55-60s |
| cliente-anonimo total | 142s | ~130-135s |
| finnk probe | ~40s | ~33-35s |
| finnk total | 80s | ~73-75s |
| Max concurrent pages | 1 | 2 (with RAM guard) |

**Conservative estimates.** The overlap saves ~nav+P1+P2 time of one template (~2-3s), but this compounds across 25 templates — only ~12 overlaps happen (13 templates run sequentially due to P3+P4 needing the same viewport). Net: ~5-7s for cliente-anonimo, ~3-5s for finnk.
