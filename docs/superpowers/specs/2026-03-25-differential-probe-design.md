# Differential Probe — Design Spec

> Date: 2026-03-25
> Status: Review-1 (post code review — HIGH-1/2/3/4 + MEDIUM-5/9 fixed)
> Author: Paul + Claude
> Scope: Optimize probe pipeline via hierarchical memoization (intra-audit) and persistent cache (cross-audit)
> Research basis: Sprinter (NSDI 2024), STILE (JSS 2024), project research docs

---

## 1. Problem Statement

The v7.3 probe pipeline runs in 68s for 33 pages (example-client.com). While this is an 85% improvement over v4.5 (1,734s), further optimization is needed because:

- **Throughput matters more than latency.** On a 4GB VPS, each audit occupies Chromium (~1.1GB) for the full duration. Faster audits = more audits/hour on the same hardware.
- **Recurrent monitoring repeats work.** Auditing the same site weekly re-tests ~80% of unchanged pages.
- **Redundant computation exists at every level.** 702 interactions in P2, but many elements share the same CSS+role+tag fingerprint. 33 axe runs in scan, but pages in the same template produce identical results.

### Core Principle

**"No re-compute lo que no ha cambiado"** — applied at three levels:

| Level | Granularity | Example |
|-------|------------|---------|
| Cross-element | Elements within a page | 10 buttons with same CSS+role → test 1 |
| Cross-page | Templates within an audit | 2 templates with same CSS fingerprint → skip viewport tests |
| Cross-audit | Pages across audits | Page unchanged since last audit → skip entirely |

### Research Foundation

- **Sprinter (Princeton, NSDI 2024):** Compute memoization across pages. Crawls representative subset with browser, replays computations statically on rest. 5x speedup. Validates our template clustering approach.
- **STILE (JSS 2024):** Dependency-aware test parallelization. -80% vs sequential. Confirms that batching independent phases is more effective than naive parallelism.
- Full research doc: `docs/research/sprinter-high-fidelity-crawling.md`

---

## 2. Architecture: Two Orthogonal Axes

```
Eje 1 — Intra-audit: Batch-by-phase + Extended Memoization
  Goal: 68s → ~45s (first audit)

Eje 2 — Cross-audit: Differential Audit with Persistent Cache
  Goal: ~45s → ~15-25s (recurrent audits)
```

### Hierarchical Hash Tree (ProbeTree)

All caching is organized around a Merkle-style hash tree:

```
                    templateHash
                   /      |      \
          manifestHash  cssHash  domHash
             /    \
      elemHash1  elemHash2  elemHash3
```

- `templateHash = hash(manifestHash + cssHash + domHash)`
- `manifestHash = hash(sorted(elementHashes))`
- `elementHash = hash(tag + role + ariaAttributes + cssFingerprint)` (excludes accessibleName — see §3.5)
- `cssHash = computeCssFingerprint(page)` (already exists)
- `domHash = hash(sortedSelectorList + headingStructure + landmarkStructure + formStructure)`
  - `sortedSelectorList`: sorted tag+id+class of all manifest elements (captures DOM structure)
  - `headingStructure`: ordered heading levels (h1, h2, h2, h3...) — meaningful-sequence depends on this
  - `landmarkStructure`: ordered landmark roles (nav, main, footer...)
  - `formStructure`: form field types and order

**Note:** `contentHash = hash(page.content())` is NOT part of the hash tree. Raw HTML includes volatile content (CSRF tokens, timestamps, nonces) that would cause false cache misses. Structural changes are captured by domHash and manifestHash instead.

**Comparison at any level is O(1).** A single hash comparison determines whether to skip an entire template, a phase, or individual element interactions.

---

## 3. Eje 1 — Intra-audit: Batch-by-phase + Extended Memoization

### 3.1 Reorganized Probe Loop

**Current (sequential per template):**
```
Template A: nav → P1 → P2 → P3 → P4
Template B: nav → P1 → P2 → P3 → P4
```

**Proposed (batch by phase):**
```
Batch 1 (read-only, 2 pages in parallel):
  A: nav → P1 → P2
  B: nav → P1 → P2   (parallel with A)

Batch 2 (mutating, sequential):
  A: P3 → P4
  B: P3 → P4

While B is in P3→P4, pre-load next batch:
  C: nav → P1 → P2   (parallel with P3/P4 of B)
  D: nav → P1 → P2
```

**Why it works:** P1 and P2 operate on individual pages (evaluate, hover, focus). Each page lives in its own tab — no interference. P3 and P4 mutate viewport and use CDP, so they run sequentially.

**ProbeContextManager concurrency model:**

Current `ProbeContextManager.get()` increments `pagesSinceRecycle` and may close/recreate the context. With 2 parallel pages, the second call could trigger recycling while the first page is still active.

**Solution: Lease-based context management.**

```typescript
class ProbeContextManager {
  private activePages = 0;

  async lease(): Promise<{ page: Page; release: () => Promise<void> }> {
    // Only recycle when ALL leased pages are released
    if (this.activePages === 0 && this.pagesSinceRecycle >= this.pagesPerContext) {
      await this.close();
    }
    const context = await this.getOrCreate();
    const page = await context.newPage();
    this.activePages++;
    this.pagesSinceRecycle++;

    return {
      page,
      release: async () => {
        try { await page.close(); } catch {}
        this.activePages--;
      }
    };
  }
}
```

Context recycling only happens when `activePages === 0`, so no page is ever orphaned.

**RAM guard — fallback to sequential:**

```typescript
const RSS_THRESHOLD = 0.80 * totalSystemMemory; // 80% of available

function shouldBatch(): boolean {
  const rss = process.memoryUsage().rss;
  return rss < RSS_THRESHOLD;
}

// In probe loop:
const batchSize = shouldBatch() ? 2 : 1;
```

If memory exceeds 80%, degrade to sequential mode (batchSize=1). No functionality loss, just slower.

**Speculative prefetch only during P3+P4** (not during batch P1+P2) to avoid 3 concurrent pages.

**RAM impact:** 2 renderers during P1+P2 batch = ~200-300MB extra. With RAM guard, safe.

### 3.2 Extended Memoization — What's New

| Cache | Key | What it caches | Phase | Status |
|-------|-----|---------------|-------|--------|
| `axeCache` | URL | axe-core results | Scan→Probe | Already exists |
| `viewportCache` | cssHash | P3 reflow/resize/text-spacing | P3 | Already exists |
| `cvdCache` | cssHash | P4 CVD screenshot diff | P4 | Already exists |
| `tier3_cache` | element crop hash | LLM vision results | Tier 3 | Already exists (DB) |
| `scanAxeCache` | contentHash | axe results per page | Scan | **New** |
| `evaluateCache` | domHash | P1 evaluate test results | P1 | **New** |
| `tier1Cache` | cssHash | Tier 1 CSSOM results | P1 | **New** |
| `interactionCache` | elementHash | Tier 2 per-element results | P2 | **New** |
| `colorUseCache` | cssHash + colorElements | P4 color-use fingerprint | P4 | **New** |

### 3.3 Scan axe Cache (contentHash)

During scan phase, pages are already grouped by template fingerprint (simhash from classify). Pages in the same template share structural similarity, and axe results correlate strongly with template structure, not dynamic content. Use template fingerprint as cache key instead of `page.content()` (which includes volatile CSRF tokens, timestamps, nonces that cause false misses).

```typescript
// After classify assigns templates, before probe:
// Run axe only on one page per template during scan, reuse for others
const templateAxeCache = new Map<string, Issue[]>();
for (const [url, result] of scanResults) {
  const templateFp = result.fingerprint;
  if (templateAxeCache.has(templateFp)) {
    result.axeIssues = templateAxeCache.get(templateFp)!.map(i => ({ ...i, url }));
  } else {
    templateAxeCache.set(templateFp, result.axeIssues);
  }
}
```

**Estimated savings:** 1-2s (skip ~8 redundant axe runs, but axe is already fast per-page; main value is reducing DB inserts)

### 3.4 P1 Evaluate Cache (domHash)

Tests like `testTargetSize`, `testMeaningfulSequence`, `testSemanticStructure` are `page.evaluate()` read-only. Cache results by DOM fingerprint.

```typescript
// domHash captures actual structure, not just counts
const domHash = await page.evaluate(() => {
  const selectors = Array.from(document.querySelectorAll('*'))
    .filter(el => el.id || el.className || el.tagName !== 'DIV')
    .map(el => `${el.tagName}.${el.className}`)
    .sort().join('|');
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .map(h => h.tagName).join(',');
  const landmarks = Array.from(document.querySelectorAll('[role],nav,main,header,footer,aside'))
    .map(l => l.getAttribute('role') || l.tagName).join(',');
  const forms = Array.from(document.querySelectorAll('input,select,textarea'))
    .map(f => f.getAttribute('type') || f.tagName).join(',');
  return `${selectors}::${headings}::${landmarks}::${forms}`;
});
const domHashKey = createHash('md5').update(domHash).digest('hex');

if (evaluateCache.has(domHashKey)) {
  issues = evaluateCache.get(domHashKey)!.map(i => ({ ...i, url, id: crypto.randomUUID() }));
} else {
  issues = await Promise.all(evaluateTests);
  evaluateCache.set(domHashKey, issues);
}
```

**Note:** Cached issues get new UUIDs to avoid primary key conflicts in DB.

**Estimated savings:** 0.5-1s

### 3.5 P2 Element-Level Interaction Cache (elementHash)

Before interacting with an element, compute its fingerprint. **Excludes `accessibleName`** — two buttons "Buy plan A" and "Buy plan B" have identical interaction behavior (same hover styles, same focus indicator, same ARIA pattern). Including text content would defeat dedup.

**Cache scope is limited to observation-only interactions:**

| Sub-test | Cacheable? | Reason |
|----------|-----------|--------|
| Hover → read styles | ✅ Yes | Pure observation, no state mutation |
| Focus → read styles | ✅ Yes | Pure observation |
| Click → verify ARIA state | ❌ No | Mutates page state (aria-expanded toggle) |
| Keyboard → Enter/Space | ❌ No | May trigger navigation, form submit |

Only hover+focus results are cached. Click and keyboard tests always execute because they mutate the page and their side effects may affect subsequent elements.

```typescript
interface ElementFingerprint {
  hash: string;  // hash(tag + role + ariaAttrs + cssFingerprint) — NO accessibleName
}

// In runTier2, for each element:
const elemHash = computeElementHash(element);
// hash = md5(tag + role + ariaAttrs + cssFingerprint) — NO accessibleName

// 1. Hover+focus: cacheable (observation only)
const hoverFocusCacheKey = `hf:${elemHash}`;
let hoverFocusIssues: Issue[];
if (interactionCache.has(hoverFocusCacheKey)) {
  hoverFocusIssues = interactionCache.get(hoverFocusCacheKey)!
    .map(i => ({ ...i, url, selector: element.selector, id: crypto.randomUUID() }));
} else {
  hoverFocusIssues = await testHoverFocus(page, element);
  interactionCache.set(hoverFocusCacheKey, hoverFocusIssues);
}
issues.push(...hoverFocusIssues);

// 2. Click+keyboard: ALWAYS execute (mutates page state)
const clickKeyboardIssues = await testClickKeyboard(page, element);
issues.push(...clickKeyboardIssues);
```

**Estimated savings:** 2-3s (hover+focus deduped: 702 → ~250 unique; click+keyboard still runs for all elements with aria-expanded/pressed/selected)

**Note:** Conservative estimate vs original 3-4s because click+keyboard is not cacheable. The savings come from skipping the hover+focus roundtrips (~60% of P2 time per element).

### 3.6 P4 Color-Use Dedup (extended fingerprint)

Current `cvdCache` keys by `cssHash`. But two pages with different CSS can have the same color-dependent elements. Extend the key:

```typescript
const colorElements = manifest
  .filter(el => el.isColorDependent)
  .map(el => el.hash)
  .sort()
  .join('|');
const colorUseKey = createHash('md5').update(cssHash + ':' + colorElements).digest('hex');
```

**Estimated savings:** 5-10s (12 unique fingerprints → ~8 color-use fingerprints)

### 3.7 Speculative Manifest Prefetch

While the current template is in P2/P3/P4, pre-load the next page and compute its manifest. If the manifest fingerprint matches an already-tested template, skip P2 entirely.

```typescript
// Start prefetch while current template runs P2+
const prefetchPromise = (async () => {
  const page = await context.newPage();
  await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const manifest = await collectManifest(page);
  const manifestHash = computeManifestHash(manifest);
  return { page, manifest, manifestHash };
})();

// ... current template finishes P2, P3, P4 ...

const prefetched = await prefetchPromise;
if (manifestCache.has(prefetched.manifestHash)) {
  // Skip P2 for this template
}
```

**Estimated savings:** 2-3s

### 3.8 Eje 1 Summary

| Optimization | From | To | Savings | Confidence |
|---|---|---|---|---|
| Batch P1+P2 parallel (2 pages) | Sequential | Overlapped | 3-5s | Medium (RAM-dependent, lease-based ctx) |
| Element dedup P2 (hover+focus only) | 702 interactions | ~250 unique h+f | 2-3s | High (click+keyboard still runs) |
| Evaluate cache P1 | Re-run per template | Cache by domHash | 0.5-1s | High |
| Tier 1 cache P1 | Re-run per template | Cache by cssHash | 0.5s | High |
| Scan axe cache | 33 axe runs | ~25 unique (by template fp) | 1-2s | Medium |
| Speculative prefetch | Sequential nav | Pre-load during P3/P4 only | 1-2s | Medium (only when batchSize=1) |
| P4 color-use dedup | 12 fingerprints | ~8 unique | 2-5s | Medium (savings=0 on form pages where status-messages is bottleneck) |
| **Total** | **68s** | **~52-58s** | **~10-16s** | |

**Note on estimates:** Adjusted down from original 20-25s after code review identified: (1) P2 click+keyboard not cacheable, (2) scanAxeCache contentHash replaced with template fp (lower hit rate expected), (3) P4 savings only when color-use is the bottleneck in the Promise.all pair, (4) speculative prefetch only during P3+P4 to avoid 3 concurrent pages.

---

## 4. Eje 2 — Cross-audit: Differential Audit

### 4.1 Concept

First audit = full probe (~55s with Eje 1). Subsequent audits of the same site = **only test what changed**.

Like `git diff`: compare hashes, process only deltas.

### 4.2 Data Model — Immutable Cache

Cache entries are **append-only** per audit. Never overwritten. Consistency is guaranteed by only reading cache from successfully completed audits.

```sql
CREATE TABLE probe_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id        TEXT NOT NULL REFERENCES audits(id),
  domain          TEXT NOT NULL,
  template_hash   TEXT NOT NULL,
  manifest_hash   TEXT NOT NULL,
  css_hash        TEXT NOT NULL,
  dom_hash        TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  scanner_version TEXT NOT NULL,
  results_json    JSONB NOT NULL,
  element_results JSONB NOT NULL,
  phase_timings   JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_probe_cache_lookup
  ON probe_cache(domain, template_hash, created_at DESC);

CREATE INDEX idx_probe_cache_cleanup
  ON probe_cache(created_at);
```

### 4.3 Consistency Rules

1. **Only read cache from audits with status `completed` or `completed-base`.**
   Failed audits' cache entries exist in DB but are never read.

2. **Write per template, not per audit.**
   Each completed template is INSERT'd immediately. If audit fails at template 15/25, the 14 completed entries exist but are ignored (audit not `completed`).

3. **Scanner version invalidation.**
   Lookup includes `WHERE scanner_version = $currentVersion`. Upgrading axe-core or adding new WCAG tests automatically invalidates all cache.

4. **TTL cleanup (30 days).**
   Periodic `DELETE FROM probe_cache WHERE created_at < NOW() - INTERVAL '30 days'`.
   50 sites × 25 templates × 4 audits/month = ~5,000 rows. ~25MB. Trivial for PostgreSQL.

### 4.4 Differential Probe Flow

```
New audit for finnk.com:

1. SCAN (normal) → discover pages, compute contentHash per page

2. CLASSIFY (normal) → templates with fingerprints

3. PRE-PROBE: for each template, lookup probe_cache:

   a) templateHash match → SKIP entire template
      Reuse all issues from previous audit.
      Mark as "cached" in audit_spans.

   b) manifestHash match, cssHash changed
      Dependency matrix (per-test, not per-phase):
      → P1 evaluate tests (targetSize, meaningfulSequence, semanticStructure): SKIP (DOM-dependent, DOM same)
      → P1 Tier 1 CSSOM analysis: RE-RUN (CSS-dependent)
      → P2 hover+focus styles: RE-RUN (CSS-dependent — computed styles changed)
      → P2 click+keyboard: SKIP (behavior depends on DOM/JS, not CSS)
      → P3 viewport: RE-RUN (CSS changed)
      → P4 capture: RE-RUN (CSS changed)

   c) cssHash match, domHash changed
      → P1 evaluate tests: RE-RUN (DOM changed — new headings, landmarks, form fields)
      → P1 Tier 1 CSSOM: SKIP (CSS same)
      → P2 hover+focus: depends on manifestHash — if same, SKIP; if changed, RE-RUN
      → P2 click+keyboard: RE-RUN (new elements may exist)
      → P3 viewport: SKIP (CSS same)
      → P4 capture: SKIP (CSS same)

   d) No match → full probe

   **Dependency matrix summary:**

   | Test | Depends on |
   |------|-----------|
   | P1 evaluate (targetSize, sequence, structure) | domHash |
   | P1 Tier 1 CSSOM | cssHash |
   | P2 hover+focus styles | cssHash + manifestHash |
   | P2 click+keyboard ARIA | domHash + manifestHash |
   | P3 viewport (reflow, resize, text-spacing) | cssHash |
   | P4 CVD screenshots | cssHash |
   | P4 status-messages | domHash (forms) — NOT cacheable |

4. PROBE: execute only what's needed

5. POST-PROBE: INSERT results into probe_cache
   → If audit completes → status = 'completed' → cache becomes readable
   → If audit fails → status = 'failed' → this audit's cache ignored
```

### 4.5 Force Full Probe

API parameter `?force=true` skips all cache lookups. Useful for:
- After scanner version upgrade (automatic via version check)
- User wants fresh results
- Debugging cache issues

### 4.6 Eje 2 Summary

| Scenario | Without Differential | With Differential |
|----------|---------------------|-------------------|
| First audit | ~45s (Eje 1) | ~45s (same) |
| Recurrent (80% unchanged) | ~45s | ~25-30s |
| Recurrent (95% unchanged) | ~45s | ~15-20s |
| Daily monitoring (annual) | ~45s × 365 | ~20s × 365 |

---

## 5. Memoization Coverage Map

| Phase | Cross-element | Cross-page (intra) | Cross-audit |
|-------|--------------|-------------------|-------------|
| Scan axe | N/A | ✅ contentHash (new) | ✅ contentHash (new) |
| P1 evaluate | N/A | ✅ domHash (new) | ✅ domHash (new) |
| P1 Tier 1 | ✅ style groups (exists) | ✅ cssHash (new) | ✅ cssHash (new) |
| P2 Tier 2 | ✅ elementHash (new) | ✅ manifestHash (new) | ✅ manifestHash (new) |
| P3 viewport | N/A | ✅ cssHash (exists) | ✅ cssHash (new) |
| P4 CVD | N/A | ✅ cssHash (exists) | ✅ cssHash (new) |
| Tier 3 LLM | N/A | ✅ crop hash (exists) | ✅ tier3_cache (exists) |

**Not cacheable (by design):**
- Link extraction (~10ms, cheaper than cache overhead)
- Classify (pure compute, no IO)
- Status-messages test (depends on form interaction, non-deterministic)
- Regression diff / WCAG score (derived, needs full picture)

---

## 6. Implementation Phases

### Phase 1 — Extended Memoization (low risk, high impact)

Extend existing cache patterns to remaining phases. No architectural changes.

| # | Task | Savings | Complexity | Priority |
|---|------|---------|------------|----------|
| 1.1 | P2 element-level cache (hover+focus only) by elementHash | 2-3s | Medium | First — highest interaction count |
| 1.2 | P4 color-use extended fingerprint | 2-5s | Medium | Second — extends existing cvdCache |
| 1.3 | P1 Tier 1 cache by cssHash cross-page | 0.5s | Low | Third — trivial extension |
| 1.4 | P1 evaluate cache by domHash (structural) | 0.5-1s | Low | Fourth — needs domHash definition |
| 1.5 | Scan axe cache by template fingerprint | 1-2s | Low | Last — lowest real-world hit rate |

**Target: 68s → ~55-60s**

### Phase 2 — Batch Parallel + Prefetch (medium risk)

Restructure probe loop for batch execution. Requires lease-based ProbeContextManager with RAM guard.

| # | Task | Savings | Complexity |
|---|------|---------|------------|
| 2.1 | ProbeContextManager: lease-based concurrency (see §3.1) | — | Medium |
| 2.2 | RAM guard: fallback to sequential when RSS > 80% | — | Low |
| 2.3 | Refactor probe loop: batch P1+P2 with 2 parallel pages | 3-5s | Medium-High |
| 2.4 | Speculative manifest prefetch (only during P3+P4, not batch) | 1-2s | Medium |

**Target: ~57s → ~52-55s**

### Phase 3 — Cross-audit Differential (highest payoff)

Persist hash tree to DB. Add lookup logic and invalidation.

| # | Task | Savings | Complexity |
|---|------|---------|------------|
| 3.1 | DB migration: `probe_cache` table | — | Low |
| 3.2 | Compute + persist ProbeTree per template on completion | — | Medium |
| 3.3 | Pre-probe: hierarchical lookup against last successful audit | — | Medium |
| 3.4 | Scanner version tracking for invalidation | — | Low |
| 3.5 | Cleanup job (30-day TTL) | — | Low |
| 3.6 | API: expose cache hit rate in `/api/audits/:id/performance` | — | Low |
| 3.7 | API: `?force=true` to bypass cache | — | Low |

**Target: recurrent audits ~55s → ~25-35s (80% unchanged), ~15-20s (95% unchanged)**

### Phase Order

```
Phase 1 (memoization)  → first, low risk, validates the concept
Phase 2 (batch)        → after Phase 1, needs caches to maximize overlap
Phase 3 (cross-audit)  → last, needs Phase 1 to have something to persist
```

---

## 7. Success Metrics

| Metric | Current | Phase 1 | Phase 2 | Phase 3 (recurrent) |
|--------|---------|---------|---------|---------------------|
| Duration (33 pages) | 68s | ~55-60s | ~52-55s | ~25-35s |
| P2 hover+focus interactions | 702 | ~250 | ~250 | ~50 (delta only) |
| P2 click+keyboard (always) | 702 | 702 | 702 | ~140 (delta only) |
| P4 screenshots | 12 | ~8 | ~8 | ~2-3 (delta only) |
| axe runs | 33 | ~25 | ~25 | ~5 (delta only) |
| Cache hit rate | 0% | ~20% | ~25% | ~80% |

**Note:** Estimates are conservative post-code-review. Phase 1+2 savings (~10-16s) are less dramatic than originally projected but are low-risk and compound with Phase 3. The cross-audit differential (Phase 3) remains the highest-payoff optimization for recurrent monitoring.

---

## 8. Future: Hash Tree as Library

The hierarchical content-addressable cache pattern is generic — applicable beyond a11y:
- CI/CD: which tests to re-run when a file changes
- Build systems: what to recompile (like Turborepo but generic)
- ETL pipelines: which data to re-process
- Monitoring: which metrics to recalculate

Plan: implement as `ProbeCache` class (~80-100 LOC) inside a11y-crawler first, extract as npm package when API is validated in production.

---

## 9. References

- Sprinter (NSDI 2024): https://www.usenix.org/system/files/nsdi24-goel.pdf
- STILE (JSS 2024): https://www.sciencedirect.com/science/article/pii/S0164121424003480
- Project research: `docs/research/sprinter-high-fidelity-crawling.md`
- v5 spec (tier system): `docs/specs/2026-03-19-intelligent-probe-v5.md`
- v6 spec (probe optimization): `docs/superpowers/specs/2026-03-19-probe-optimization-v6-design.md`
