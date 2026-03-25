# Differential Probe Phase 1: Extended Memoization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend existing cache patterns to all probe phases, reducing first-audit time from 68s to ~55-60s via hierarchical memoization.

**Architecture:** Add 5 new in-memory caches (interactionCache, colorUseCache, tier1Cache, evaluateCache, scanAxeCache) following the exact same Map<string, Result> pattern used by existing viewportCache and cvdCache. Each cache is keyed by a fingerprint hash computed from structural properties, not content. A shared `ProbeCache` utility computes all hash types (elementHash, domHash, cssHash, manifestHash, templateHash).

**Tech Stack:** TypeScript, Bun, Playwright, node:crypto (createHash for MD5)

**Spec:** `docs/superpowers/specs/2026-03-25-differential-probe-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/worker/probe-cache.ts` | **Create** | ProbeCache class: all hash computations (elementHash, domHash, manifestHash, templateHash) + cache Maps |
| `src/worker/probe-cache.test.ts` | **Create** | Unit tests for hash computations and cache hit/miss logic |
| `src/worker/tier2.ts` | **Modify** | Add interactionCache lookup before hover+focus (lines ~298-315) |
| `src/worker/tier2.test.ts` | **Create** | Unit tests for element-level dedup in tier2 |
| `src/worker/probe.ts` | **Modify** | Wire ProbeCache into runProbePhase, pass caches to phases |
| `src/worker/tier1.ts` | **Modify** | Add tier1Cache lookup before CSSOM analysis |
| `src/analyzer/wcag-color-use.ts` | **Modify** | Extend cvdCache key with color-dependent element fingerprint |
| `src/worker/scan.ts` | **Modify** | Add scanAxeCache by template fingerprint |

---

### Task 1: ProbeCache — Hash computation utility

**Files:**
- Create: `src/worker/probe-cache.ts`
- Create: `src/worker/__tests__/probe-cache.test.ts`

- [ ] **Step 1: Write failing tests for elementHash**

```typescript
// src/worker/__tests__/probe-cache.test.ts
import { test, expect } from "bun:test";
import { computeElementHash, computeDomHash, computeManifestHash } from "../probe-cache";

test("computeElementHash: same structure = same hash", () => {
  const a = { tag: "button", role: "button", ariaAttrs: "aria-expanded=false", cssFingerprint: "div|button|btn-primary" };
  const b = { tag: "button", role: "button", ariaAttrs: "aria-expanded=false", cssFingerprint: "div|button|btn-primary" };
  expect(computeElementHash(a)).toBe(computeElementHash(b));
});

test("computeElementHash: different role = different hash", () => {
  const a = { tag: "button", role: "button", ariaAttrs: "", cssFingerprint: "div|button|btn" };
  const b = { tag: "button", role: "menuitem", ariaAttrs: "", cssFingerprint: "div|button|btn" };
  expect(computeElementHash(a)).not.toBe(computeElementHash(b));
});

test("computeElementHash: ignores accessibleName (different text = same hash)", () => {
  const a = { tag: "button", role: "button", ariaAttrs: "", cssFingerprint: "div|button|btn" };
  const b = { tag: "button", role: "button", ariaAttrs: "", cssFingerprint: "div|button|btn" };
  // Both would have different accessibleName in real data, but hash should be identical
  expect(computeElementHash(a)).toBe(computeElementHash(b));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/worker/__tests__/probe-cache.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write computeElementHash**

```typescript
// src/worker/probe-cache.ts
import { createHash } from "node:crypto";
import type { ElementManifest } from "../types/manifest";

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/**
 * Computes a fingerprint for an element based on structural properties.
 * Excludes accessibleName — two buttons with different labels but same
 * CSS+role+tag have identical interaction behavior.
 */
export function computeElementHash(el: {
  tag: string;
  role: string | null;
  ariaAttrs: string;
  cssFingerprint: string;
}): string {
  return md5(`${el.tag}|${el.role ?? ""}|${el.ariaAttrs}|${el.cssFingerprint}`);
}

/**
 * Extract ARIA attribute string from ElementManifest for hashing.
 * Only includes boolean ARIA state attributes that affect interaction behavior.
 */
export function extractAriaAttrs(el: ElementManifest): string {
  const parts: string[] = [];
  if (el.hasAriaExpanded) parts.push("expanded");
  if (el.hasAriaPressed) parts.push("pressed");
  if (el.isFormControl) parts.push("form");
  if (el.hasOnclick) parts.push("onclick");
  return parts.sort().join(",");
}

/**
 * Convenience: compute elementHash directly from an ElementManifest.
 */
export function elementHashFromManifest(el: ElementManifest): string {
  return computeElementHash({
    tag: el.tag,
    role: el.role,
    ariaAttrs: extractAriaAttrs(el),
    cssFingerprint: el.styleFingerprint,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/worker/__tests__/probe-cache.test.ts`
Expected: 3 PASS

- [ ] **Step 5: Add tests for computeDomHash and computeManifestHash**

```typescript
// Append to src/worker/__tests__/probe-cache.test.ts

test("computeManifestHash: same elements in different order = same hash (sorted)", () => {
  const hashes = ["abc123", "def456", "ghi789"];
  const reversed = ["ghi789", "def456", "abc123"];
  expect(computeManifestHash(hashes)).toBe(computeManifestHash(reversed));
});

test("computeManifestHash: different elements = different hash", () => {
  const a = ["abc123", "def456"];
  const b = ["abc123", "xyz999"];
  expect(computeManifestHash(a)).not.toBe(computeManifestHash(b));
});

test("computeDomHash: same structure = same hash", () => {
  const a = { selectors: "A.nav|BUTTON.btn|H1.", headings: "H1,H2,H2", landmarks: "nav,main,footer", forms: "text,email,submit" };
  const b = { selectors: "A.nav|BUTTON.btn|H1.", headings: "H1,H2,H2", landmarks: "nav,main,footer", forms: "text,email,submit" };
  expect(computeDomHash(a)).toBe(computeDomHash(b));
});

test("computeDomHash: different headings = different hash", () => {
  const a = { selectors: "A.nav", headings: "H1,H2", landmarks: "main", forms: "" };
  const b = { selectors: "A.nav", headings: "H1,H2,H3", landmarks: "main", forms: "" };
  expect(computeDomHash(a)).not.toBe(computeDomHash(b));
});
```

- [ ] **Step 6: Write computeDomHash and computeManifestHash**

```typescript
// Append to src/worker/probe-cache.ts

export function computeManifestHash(elementHashes: string[]): string {
  return md5(elementHashes.slice().sort().join("|"));
}

export interface DomStructure {
  selectors: string;
  headings: string;
  landmarks: string;
  forms: string;
}

export function computeDomHash(dom: DomStructure): string {
  return md5(`${dom.selectors}::${dom.headings}::${dom.landmarks}::${dom.forms}`);
}

/**
 * Collect DOM structure from a Playwright page for domHash computation.
 * Runs a single page.evaluate() — cheap (~5ms).
 */
export async function collectDomStructure(page: import("playwright").Page): Promise<DomStructure> {
  return await page.evaluate(() => {
    const selectors = Array.from(document.querySelectorAll("*"))
      .filter(el => el.id || el.className || el.tagName !== "DIV")
      .map(el => `${el.tagName}.${el.className}`)
      .sort().join("|");
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
      .map(h => h.tagName).join(",");
    const landmarks = Array.from(document.querySelectorAll("[role],nav,main,header,footer,aside"))
      .map(l => l.getAttribute("role") || l.tagName).join(",");
    const forms = Array.from(document.querySelectorAll("input,select,textarea"))
      .map(f => f.getAttribute("type") || f.tagName).join(",");
    return { selectors, headings, landmarks, forms };
  });
}

export function computeTemplateHash(manifestHash: string, cssHash: string, domHash: string): string {
  return md5(`${manifestHash}|${cssHash}|${domHash}`);
}
```

- [ ] **Step 7: Run all tests**

Run: `bun test src/worker/__tests__/probe-cache.test.ts`
Expected: 7 PASS

- [ ] **Step 8: Verify tsc**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/worker/probe-cache.ts src/worker/__tests__/probe-cache.test.ts
git commit -m "feat: add ProbeCache hash computation utility (elementHash, domHash, manifestHash, templateHash)"
```

---

### Task 2: P2 element-level interaction cache (hover+focus only)

**Files:**
- Modify: `src/worker/tier2.ts` (~lines 284-315)
- Modify: `src/worker/probe.ts` (~line 67, ~line 112)
- Create: `src/worker/__tests__/tier2-cache.test.ts`

**Context:** `runTier2` iterates over promoted elements and calls `batchedHoverFocus()` for each. We cache the hover+focus result by elementHash. Click+keyboard always execute (they mutate state).

- [ ] **Step 1: Write failing test for interaction cache**

```typescript
// src/worker/__tests__/tier2-cache.test.ts
import { test, expect } from "bun:test";
import { computeElementHash } from "../probe-cache";

test("elements with same structure produce same hash for cache lookup", () => {
  const btn1 = { tag: "button", role: "button", ariaAttrs: "expanded", cssFingerprint: "div|button|btn-primary" };
  const btn2 = { tag: "button", role: "button", ariaAttrs: "expanded", cssFingerprint: "div|button|btn-primary" };
  expect(computeElementHash(btn1)).toBe(computeElementHash(btn2));
});

test("cache Map returns stored value for same elementHash", () => {
  const cache = new Map<string, { issues: Array<{ rule: string }> }>();
  const hash = computeElementHash({ tag: "a", role: "link", ariaAttrs: "", cssFingerprint: "nav|a|" });
  cache.set(`hf:${hash}`, { issues: [{ rule: "hover-focus-not-persistent" }] });

  const lookup = cache.get(`hf:${hash}`);
  expect(lookup).toBeDefined();
  expect(lookup!.issues).toHaveLength(1);
  expect(lookup!.issues[0].rule).toBe("hover-focus-not-persistent");
});
```

- [ ] **Step 2: Run test to verify it passes** (this is a unit test of the cache pattern, not integration)

Run: `bun test src/worker/__tests__/tier2-cache.test.ts`
Expected: 2 PASS

- [ ] **Step 3: Add interactionCache parameter to runTier2**

In `src/worker/tier2.ts`, modify the function signature:

```typescript
// Before:
export async function runTier2(
  page: Page,
  elements: ElementManifest[],
  url: string,
  timer: TierTimer,
): Promise<{ issues: Issue[]; promotedToTier3: ElementManifest[] }> {

// After:
export async function runTier2(
  page: Page,
  elements: ElementManifest[],
  url: string,
  timer: TierTimer,
  interactionCache?: Map<string, { hoverStyles?: Record<string, string>; focusStyles?: Record<string, string>; hoverIssues: Issue[]; focusIssues: Issue[] }>,
): Promise<{ issues: Issue[]; promotedToTier3: ElementManifest[] }> {
```

- [ ] **Step 4: Add cache lookup before batchedHoverFocus**

In `runTier2`, inside the `for (const element of elements)` loop, before the `batchedHoverFocus` call (~line 307):

```typescript
import { elementHashFromManifest } from "./probe-cache";

// Inside the loop, after const handle = await page.$(element.selector):
const elemHash = elementHashFromManifest(element);
const hfCacheKey = `hf:${elemHash}`;

// Check cache for hover+focus results
if (interactionCache?.has(hfCacheKey)) {
  const cached = interactionCache.get(hfCacheKey)!;
  // Reuse hover+focus results, remap to current element
  result.hoverStyles = cached.hoverStyles;
  result.focusStyles = cached.focusStyles;
  allIssues.push(...cached.hoverIssues.map(i => ({ ...i, url, selector: element.selector, id: crypto.randomUUID() })));
  allIssues.push(...cached.focusIssues.map(i => ({ ...i, url, selector: element.selector, id: crypto.randomUUID() })));
  timer.recordInteraction("hovers");
  timer.recordInteraction("focuses");
  // Skip to click+keyboard (which always executes)
} else {
  // Existing batchedHoverFocus call
  const batched = await batchedHoverFocus(page, element.selector);
  if (!batched) continue;
  result.hoverStyles = batched.hoverStyles;
  result.hoverPopup = batched.hoverPopup;
  result.focusStyles = batched.focusStyles;
  result.focusPopup = batched.focusPopup;
  timer.recordInteraction("hovers");
  timer.recordInteraction("focuses");

  // Evaluate hover+focus issues and store in cache
  const hoverIssues = evaluateStateChange(element, { hoverStyles: result.hoverStyles }, url);
  const focusIssues = evaluateFocusIndicator(element, result, url);
  interactionCache?.set(hfCacheKey, {
    hoverStyles: result.hoverStyles,
    focusStyles: result.focusStyles,
    hoverIssues,
    focusIssues,
  });
}
```

**Note:** The popup sub-tests (persistence, hoverability, dismissibility) are NOT cached — they are rare-path and require real mouse interaction. They execute normally when `result.hoverPopup` is detected.

- [ ] **Step 5: Pass interactionCache from probe.ts**

In `src/worker/probe.ts`, in `runProbePhase`:

```typescript
// Add after cvdCache and viewportCache declarations (~line 68):
const interactionCache = new Map<string, { hoverStyles?: Record<string, string>; focusStyles?: Record<string, string>; hoverIssues: Issue[]; focusIssues: Issue[] }>();
```

In `runPhase2Interaction`, pass it through:

```typescript
// Modify runPhase2Interaction signature and call to runTier2:
const { issues: tier2Issues, promotedToTier3 } = await runTier2(page, promotedElements, url, timer, interactionCache);
```

- [ ] **Step 6: Run full test suite**

Run: `bun test --timeout 30000`
Expected: 263+ PASS, 0 FAIL

- [ ] **Step 7: Verify tsc**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/worker/tier2.ts src/worker/probe.ts src/worker/__tests__/tier2-cache.test.ts
git commit -m "feat: P2 element-level interaction cache (hover+focus dedup by elementHash)"
```

---

### Task 3: P4 color-use extended fingerprint

**Files:**
- Modify: `src/analyzer/wcag-color-use.ts` (~line 190-210, cvdCache key)
- Modify: `src/worker/probe.ts` (~line 356, testColorUse call)

**Context:** Current `cvdCache` keys by `cssHash` only. Two pages with different CSS but same color-dependent elements get different keys even though CVD results would be identical. Extend key with color-dependent element fingerprint.

- [ ] **Step 1: Examine current cvdCache usage**

Read `src/analyzer/wcag-color-use.ts` around the cache lookup (near the top of `testColorUse` function). Understand the current `cvdCache: Map<string, { diffPercent: number; issues: Issue[] }>` interface.

- [ ] **Step 2: Add color-dependent element extraction to manifest**

In `src/worker/probe-cache.ts`, add:

```typescript
/**
 * Compute a fingerprint for color-use test that includes which elements
 * are color-dependent (links without underline, status indicators).
 * More specific than cssHash alone.
 */
export function computeColorUseFingerprint(
  cssHash: string,
  manifest: ElementManifest[],
): string {
  const colorElements = manifest
    .filter(el =>
      (el.tag === "a" && !el.hasUnderline) || // links distinguished only by color
      el.role === "status" ||
      el.role === "alert" ||
      el.isFormControl
    )
    .map(el => `${el.tag}|${el.role}|${el.styleFingerprint}`)
    .sort()
    .join(";");
  return md5(`${cssHash}:${colorElements}`);
}
```

- [ ] **Step 3: Replace cvdCache key in probe.ts Phase 4**

In `runPhase4Capture` in `src/worker/probe.ts`, where `testColorUse` is called with `cvdCache`, compute the extended key and pass it. The exact integration depends on how testColorUse uses the cache — it may need the new key passed in, or the cache itself needs the new key type.

Review `testColorUse` signature and modify the cache key computation before the call.

- [ ] **Step 4: Run full test suite**

Run: `bun test --timeout 30000`
Expected: All PASS

- [ ] **Step 5: Verify tsc**

Run: `bunx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/worker/probe-cache.ts src/analyzer/wcag-color-use.ts src/worker/probe.ts
git commit -m "feat: P4 color-use extended fingerprint (cssHash + color-dependent elements)"
```

---

### Task 4: P1 Tier 1 cache + P1 evaluate cache

**Files:**
- Modify: `src/worker/probe.ts` (runPhase1Static, ~lines 212-268)
- Modify: `src/worker/tier1.ts` (add cache parameter)
- Add tests in: `src/worker/__tests__/probe-cache.test.ts`

**Context:** Tier 1 CSSOM analysis depends on cssHash — if two templates have the same CSS, Tier 1 results are identical. P1 evaluate tests (targetSize, meaningfulSequence, etc.) depend on domHash.

- [ ] **Step 1: Add tier1Cache to runProbePhase**

In `src/worker/probe.ts`, after the existing cache declarations:

```typescript
const tier1Cache = new Map<string, { issues: Issue[]; promotedElements: ElementManifest[] }>();
const evaluateCache = new Map<string, Issue[]>();
```

- [ ] **Step 2: Add cssHash lookup before runTier1 in runPhase1Static**

In `runPhase1Static`, before calling `runTier1`:

```typescript
import { computeCssFingerprint } from "../analyzer/screenshot-cvd";
import { collectDomStructure, computeDomHash } from "./probe-cache";

// Tier 1 cache by cssHash
const cssHash = await computeCssFingerprint(page);

if (tier1Cache.has(cssHash)) {
  const cached = tier1Cache.get(cssHash)!;
  issues.push(...cached.issues.map(i => ({ ...i, url, id: crypto.randomUUID() })));
  promotedElements = cached.promotedElements;
} else {
  const { issues: tier1Issues, promotedElements: promoted } = await runTier1(page, styleGroups, url, timer);
  issues.push(...tier1Issues);
  promotedElements = promoted;
  tier1Cache.set(cssHash, { issues: tier1Issues, promotedElements: promoted });
}
```

- [ ] **Step 3: Add domHash lookup before evaluate tests**

After the Tier 1 block, before the evaluate tests array:

```typescript
const domStructure = await collectDomStructure(page);
const domHashKey = computeDomHash(domStructure);

if (evaluateCache.has(domHashKey)) {
  issues.push(...evaluateCache.get(domHashKey)!.map(i => ({ ...i, url, id: crypto.randomUUID() })));
} else {
  // Existing evaluate tests block
  const evaluateTests: Promise<Issue[]>[] = [];
  // ... existing test pushes ...
  const evalResults = await Promise.all(evaluateTests);
  const evalIssues = evalResults.flat();
  issues.push(...evalIssues);
  evaluateCache.set(domHashKey, evalIssues);
}
```

- [ ] **Step 4: Pass caches through function signatures**

Update `runPhase1Static` signature to accept `tier1Cache` and `evaluateCache` as parameters, and pass them from `runProbePhase`.

- [ ] **Step 5: Run full test suite**

Run: `bun test --timeout 30000`
Expected: All PASS

- [ ] **Step 6: Verify tsc**

Run: `bunx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/worker/probe.ts src/worker/tier1.ts src/worker/probe-cache.ts
git commit -m "feat: P1 Tier 1 cache (cssHash) + P1 evaluate cache (domHash)"
```

---

### Task 5: Scan axe cache by template fingerprint

**Files:**
- Modify: `src/worker/pipeline.ts` (~lines 170-175, axeCache construction)
- Modify: `src/worker/scan.ts` (if axe dedup needed during scan)

**Context:** After classify groups pages by fingerprint, pages in the same template have structurally similar DOM. Axe results correlate with template structure. Instead of running axe on all 33 pages, run on one per template fingerprint and reuse results.

- [ ] **Step 1: Modify axeCache construction in pipeline.ts**

Currently (pipeline.ts ~170-175):
```typescript
const axeCache = new Map<string, Issue[]>();
for (const [pageUrl, result] of scanResults) {
  if (result.axeIssues.length > 0) {
    axeCache.set(pageUrl, result.axeIssues);
  }
}
```

Change to deduplicate by template fingerprint:
```typescript
// Dedup axe results by template fingerprint — pages in same template
// share structural DOM, so axe produces equivalent results.
const axeCache = new Map<string, Issue[]>();
const seenFingerprints = new Set<string>();
for (const [pageUrl, result] of scanResults) {
  if (!seenFingerprints.has(result.fingerprint) && result.axeIssues.length > 0) {
    seenFingerprints.add(result.fingerprint);
  }
  // Always map by URL for probe lookup (probe uses URL as key)
  if (result.axeIssues.length > 0) {
    axeCache.set(pageUrl, result.axeIssues);
  }
}
// Log dedup stats
const totalAxePages = [...scanResults.values()].filter(r => r.axeIssues.length > 0).length;
console.log(`[pipeline] axeCache: ${totalAxePages} pages with issues, ${seenFingerprints.size} unique fingerprints`);
```

**Note:** The real savings here come from Phase 3 (cross-audit). For intra-audit, the axeCache is already populated during scan for all pages. The dedup during scan would require restructuring scan to skip axe for duplicate fingerprints, which is a larger change. For Phase 1, we log the stats to validate the dedup potential and prepare for Phase 3.

- [ ] **Step 2: Run full test suite**

Run: `bun test --timeout 30000`
Expected: All PASS

- [ ] **Step 3: Verify tsc**

Run: `bunx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/worker/pipeline.ts
git commit -m "feat: scan axe cache dedup logging by template fingerprint (prep for Phase 3)"
```

---

### Task 6: Integration test + performance measurement

**Files:**
- Modify: `src/worker/probe.ts` (add cache stats to phaseTimings metadata)

- [ ] **Step 1: Add cache hit/miss counters to probe**

In `runProbePhase`, after the `for` loop, log aggregated cache stats:

```typescript
// After the template loop, before probeCtx.close():
console.log(`[probe] Cache stats — interactionCache: ${interactionCache.size} entries, tier1Cache: ${tier1Cache.size}, evaluateCache: ${evaluateCache.size}, viewportCache: ${viewportCache.size}, cvdCache: ${cvdCache.size}`);
```

- [ ] **Step 2: Add cache hit rate to probe:representative span metadata**

In the `phaseTimings` object that's already set on `parentSpan`, add:

```typescript
phaseTimings.cacheHits = {
  interactionCache: interactionCache.size,
  tier1Cache: tier1Cache.size,
  evaluateCache: evaluateCache.size,
};
```

- [ ] **Step 3: Run full test suite**

Run: `bun test --timeout 30000`
Expected: All PASS

- [ ] **Step 4: Verify tsc**

Run: `bunx tsc --noEmit`

- [ ] **Step 5: Final commit**

```bash
git add src/worker/probe.ts
git commit -m "feat: probe cache hit stats in span metadata (Phase 1 observability)"
```

- [ ] **Step 6: Deploy and run audit to measure real impact**

Deploy to VPS and run audit on example-client.com. Compare:
- Total duration vs 68s baseline
- Cache hit rates per cache type
- P2 interaction count vs 702 baseline

Document results in `docs/superpowers/specs/2026-03-25-differential-probe-design.md` §7 Success Metrics as actuals vs estimates.
