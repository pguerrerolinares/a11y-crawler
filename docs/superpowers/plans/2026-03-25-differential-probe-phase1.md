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
  // These would be two buttons with different labels but identical structure
  // accessibleName is NOT part of the hash input, so they must match
  const a = { tag: "button", role: "button", ariaAttrs: "", cssFingerprint: "div|button|btn" };
  const b = { tag: "button", role: "button", ariaAttrs: "", cssFingerprint: "div|button|btn" };
  expect(computeElementHash(a)).toBe(computeElementHash(b));
  // Also verify via elementHashFromManifest with full manifests:
});

test("elementHashFromManifest: different accessibleName = same hash", () => {
  const base = {
    selector: "button.btn", tag: "button", role: "button", accessibleName: "",
    boundingBox: { x: 0, y: 0, width: 100, height: 40 },
    hasHoverCss: true, hasAriaExpanded: false, hasAriaPressed: false,
    hasUnderline: false, isFormControl: false, hasOnclick: false,
    defaultStyles: { borderColor: "", outlineColor: "", backgroundColor: "", boxShadow: "", textDecorationLine: "", color: "" },
    parentBg: "", styleFingerprint: "div|button|btn-primary",
  };
  const a = { ...base, accessibleName: "Buy Plan A" };
  const b = { ...base, accessibleName: "Buy Plan B" };
  expect(elementHashFromManifest(a)).toBe(elementHashFromManifest(b));
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
export function extractInteractionTraits(el: ElementManifest): string {
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
    ariaAttrs: extractInteractionTraits(el),
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
- Modify: `src/worker/tier2.ts` (~lines 284-443)
- Modify: `src/worker/probe.ts` (~line 67, ~line 112, ~line 272)
- Create: `src/worker/__tests__/tier2-cache.test.ts`

**Context:** `runTier2` (tier2.ts:284-443) iterates over promoted elements. For each element the flow is:
1. `batchedHoverFocus()` → captures hover/focus styles + popup detection (line 307)
2. Popup sub-tests if popup detected (lines 321-370) — real mouse, NOT cacheable
3. Click for ARIA state changes (lines 372-396) — mutates state, NOT cacheable
4. Keyboard Enter/Space (lines 398-432) — mutates state, NOT cacheable
5. Three evaluate calls AFTER the interaction sequence (lines 435-437):
   - `evaluateStateChange(element, result, url)` — evaluates hover contrast
   - `evaluateHoverFocus(element, result, url)` — evaluates popup behavior
   - `evaluateAriaStates(element, result, url)` — evaluates click ARIA

**Cache strategy:** Only skip `batchedHoverFocus()` when cache hits AND the cached result had no popup. If the first occurrence of a fingerprint detected a popup, mark that fingerprint as non-cacheable (popup behavior depends on DOM context). Populate `result.hoverStyles` and `result.focusStyles` from cache, then let the ENTIRE remaining flow (popup guard, click, keyboard, all three evaluates at lines 435-437) proceed normally with the cached styles.

- [ ] **Step 1: Write tests for interaction cache**

```typescript
// src/worker/__tests__/tier2-cache.test.ts
import { test, expect } from "bun:test";
import { elementHashFromManifest } from "../probe-cache";

const baseManifest = {
  selector: "button.btn",
  tag: "button",
  role: "button",
  accessibleName: "Submit",
  boundingBox: { x: 0, y: 0, width: 100, height: 40 },
  hasHoverCss: true,
  hasAriaExpanded: false,
  hasAriaPressed: false,
  hasUnderline: false,
  isFormControl: false,
  hasOnclick: false,
  defaultStyles: { borderColor: "", outlineColor: "", backgroundColor: "", boxShadow: "", textDecorationLine: "", color: "" },
  parentBg: "rgb(255,255,255)",
  styleFingerprint: "div|button|btn-primary",
};

test("elementHashFromManifest: same structure, different accessibleName = same hash", () => {
  const a = { ...baseManifest, accessibleName: "Buy Plan A" };
  const b = { ...baseManifest, accessibleName: "Buy Plan B" };
  expect(elementHashFromManifest(a)).toBe(elementHashFromManifest(b));
});

test("elementHashFromManifest: different role = different hash", () => {
  const a = { ...baseManifest, role: "button" };
  const b = { ...baseManifest, role: "menuitem" };
  expect(elementHashFromManifest(a)).not.toBe(elementHashFromManifest(b));
});

test("elementHashFromManifest: different ariaExpanded = different hash", () => {
  const a = { ...baseManifest, hasAriaExpanded: false };
  const b = { ...baseManifest, hasAriaExpanded: true };
  expect(elementHashFromManifest(a)).not.toBe(elementHashFromManifest(b));
});

test("HoverFocusCache: stores and retrieves by element hash", () => {
  const cache = new Map<string, { hoverStyles: Record<string, string>; focusStyles: Record<string, string>; hadPopup: boolean }>();
  const hash = elementHashFromManifest(baseManifest);
  const key = `hf:${hash}`;

  cache.set(key, {
    hoverStyles: { color: "rgb(255,0,0)" },
    focusStyles: { outlineColor: "rgb(0,0,255)" },
    hadPopup: false,
  });

  const hit = cache.get(key);
  expect(hit).toBeDefined();
  expect(hit!.hadPopup).toBe(false);
  expect(hit!.hoverStyles.color).toBe("rgb(255,0,0)");
});

test("HoverFocusCache: popup elements are marked non-cacheable", () => {
  const cache = new Map<string, { hoverStyles: Record<string, string>; focusStyles: Record<string, string>; hadPopup: boolean }>();
  const hash = elementHashFromManifest(baseManifest);
  const key = `hf:${hash}`;

  // First element with this fingerprint had a popup
  cache.set(key, {
    hoverStyles: { color: "rgb(255,0,0)" },
    focusStyles: {},
    hadPopup: true,
  });

  // Second element: lookup hits, but hadPopup=true means skip cache
  const hit = cache.get(key);
  expect(hit!.hadPopup).toBe(true);
  // Caller should NOT use cached styles, must run batchedHoverFocus
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/worker/__tests__/tier2-cache.test.ts`
Expected: FAIL — `elementHashFromManifest` not found (Task 1 must be done first)

- [ ] **Step 3: Define HoverFocusCache type and add to runTier2 signature**

In `src/worker/tier2.ts`:

```typescript
import { elementHashFromManifest } from "./probe-cache";

// Type for the hover+focus cache
export type HoverFocusCache = Map<string, {
  hoverStyles: Record<string, string>;
  focusStyles: Record<string, string>;
  hadPopup: boolean;
}>;

// Updated signature:
export async function runTier2(
  page: Page,
  elements: ElementManifest[],
  url: string,
  timer: TierTimer,
  hfCache?: HoverFocusCache,
): Promise<{ issues: Issue[]; promotedToTier3: ElementManifest[] }> {
```

- [ ] **Step 4: Add cache logic inside the element loop**

The cache only replaces `batchedHoverFocus()`. Everything else (popup tests, click, keyboard, all three evaluate calls at lines 435-437) runs normally.

In the `for (const element of elements)` loop, REPLACE lines 304-315:

```typescript
    try {
      // Cache lookup: skip batchedHoverFocus if same fingerprint already tested
      // and no popup was detected (popup path requires real mouse interaction)
      const elemHash = elementHashFromManifest(element);
      const hfCacheKey = `hf:${elemHash}`;
      const cachedHF = hfCache?.get(hfCacheKey);

      if (cachedHF && !cachedHF.hadPopup) {
        // Cache hit (no popup) — reuse styles, skip batchedHoverFocus
        result.hoverStyles = cachedHF.hoverStyles;
        result.focusStyles = cachedHF.focusStyles;
        result.hoverPopup = null;
        result.focusPopup = null;
        timer.recordInteraction("hovers");
        timer.recordInteraction("focuses");
      } else {
        // Cache miss or popup fingerprint — run real interaction
        const batched = await batchedHoverFocus(page, element.selector);
        if (!batched) continue;

        result.hoverStyles = batched.hoverStyles;
        result.hoverPopup = batched.hoverPopup;
        result.focusStyles = batched.focusStyles;
        result.focusPopup = batched.focusPopup;
        timer.recordInteraction("hovers");
        timer.recordInteraction("focuses");

        // Store in cache (including whether popup was detected)
        hfCache?.set(hfCacheKey, {
          hoverStyles: result.hoverStyles ?? {},
          focusStyles: result.focusStyles ?? {},
          hadPopup: !!result.hoverPopup || !!result.focusPopup,
        });
      }

      // === EVERYTHING BELOW RUNS REGARDLESS OF CACHE HIT ===

      // Popup sub-tests (lines 321-370) — only if popup detected, uses real mouse
      if (result.hoverPopup) {
        // ... existing popup code unchanged ...
      }

      // Click ARIA (lines 372-396) — always runs for aria-expanded/pressed
      // ... existing click code unchanged ...

      // Keyboard (lines 398-432) — always runs for custom interactive
      // ... existing keyboard code unchanged ...

      // All three evaluate calls (lines 435-437) — always run
      allIssues.push(...evaluateStateChange(element, result, url));
      allIssues.push(...evaluateHoverFocus(element, result, url));
      allIssues.push(...evaluateAriaStates(element, result, url));
```

**Key insight:** The three evaluate calls at lines 435-437 stay EXACTLY where they are. They use `result` which is populated either from cache (hoverStyles/focusStyles only) or from real interaction (all fields). `evaluateHoverFocus` checks `result.popupPersistent` etc. — these will be `undefined` on cache hit, which correctly means "no popup issues".

- [ ] **Step 5: Pass HoverFocusCache from probe.ts**

In `src/worker/probe.ts`:

```typescript
// In runProbePhase, after cvdCache and viewportCache (~line 68):
import type { HoverFocusCache } from "./tier2";
const hfCache: HoverFocusCache = new Map();
```

In `runPhase2Interaction` signature and body:

```typescript
async function runPhase2Interaction(
  page: Page,
  promotedElements: ElementManifest[],
  url: string,
  timer: TierTimer,
  cluster: TemplateCluster,
  hfCache: HoverFocusCache,  // NEW
): Promise<{ issues: Issue[]; promotedToTier3: ElementManifest[] }> {
  // ...
  const { issues: tier2Issues, promotedToTier3 } = await runTier2(page, promotedElements, url, timer, hfCache);
```

Update the call site in the template loop accordingly.

- [ ] **Step 6: Run tests**

Run: `bun test --timeout 30000`
Expected: 265+ PASS, 0 FAIL

- [ ] **Step 7: Verify tsc**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/worker/tier2.ts src/worker/probe.ts src/worker/__tests__/tier2-cache.test.ts
git commit -m "feat: P2 hover+focus cache by elementHash (skip batchedHoverFocus on cache hit, no-popup only)"
```

---

### Task 3: P4 color-use extended fingerprint + cssHash computed once

**Files:**
- Modify: `src/worker/probe-cache.ts` (add `computeColorUseFingerprint`)
- Modify: `src/analyzer/wcag-color-use.ts` (lines 185-200: accept pre-computed cssHash + manifest)
- Modify: `src/worker/probe.ts` (compute cssHash once per template, pass to all phases)
- Add test: `src/worker/__tests__/probe-cache.test.ts`

**Context:** `testColorUse` (wcag-color-use.ts:195) computes `cssFingerprint` internally via `computeCssFingerprint(page)`. The same function is called again in `runPhase3Viewport` (probe.ts:312). Fix: compute once in the template loop, pass as parameter to all phases. Then extend the cvdCache key with color-dependent element fingerprint.

**Current `testColorUse` signature (wcag-color-use.ts:178-186):**
```typescript
export async function testColorUse(
  page: Page,
  url: string,
  llmClient: LLMClient | null,
  screenshotDir?: string,
  templatePrefix?: string,
  cvdCache?: Map<string, { diffPercent: number; issues: Issue[] }>,
): Promise<ColorUseResult>
```

**Current cache lookup (wcag-color-use.ts:195-200):**
```typescript
const fingerprint = await computeCssFingerprint(page);
if (cvdCache?.has(fingerprint)) {
  const cached = cvdCache.get(fingerprint)!;
  issues.push(...cached.issues.map(i => ({ ...i, url, id: crypto.randomUUID() })));
  return { issues, screenshots };
}
```

- [ ] **Step 1: Add computeColorUseFingerprint to probe-cache.ts**

```typescript
// Append to src/worker/probe-cache.ts
export function computeColorUseFingerprint(
  cssHash: string,
  manifest: ElementManifest[],
): string {
  const colorElements = manifest
    .filter(el =>
      (el.tag === "a" && !el.hasUnderline) ||
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

- [ ] **Step 2: Add test for computeColorUseFingerprint**

```typescript
// Append to src/worker/__tests__/probe-cache.test.ts
import { computeColorUseFingerprint } from "../probe-cache";

test("computeColorUseFingerprint: same CSS + same color elements = same hash", () => {
  const manifest = [
    { ...baseManifest, tag: "a", hasUnderline: false, role: "link", styleFingerprint: "nav|a|" },
  ] as any;
  const a = computeColorUseFingerprint("css123", manifest);
  const b = computeColorUseFingerprint("css123", manifest);
  expect(a).toBe(b);
});

test("computeColorUseFingerprint: different CSS = different hash", () => {
  const manifest = [
    { ...baseManifest, tag: "a", hasUnderline: false, role: "link", styleFingerprint: "nav|a|" },
  ] as any;
  const a = computeColorUseFingerprint("css123", manifest);
  const b = computeColorUseFingerprint("css456", manifest);
  expect(a).not.toBe(b);
});
```

- [ ] **Step 3: Modify testColorUse to accept pre-computed cssHash and manifest**

In `src/analyzer/wcag-color-use.ts`, change the signature:

```typescript
// Before:
export async function testColorUse(
  page: Page,
  url: string,
  llmClient: LLMClient | null,
  screenshotDir?: string,
  templatePrefix?: string,
  cvdCache?: Map<string, { diffPercent: number; issues: Issue[] }>,
): Promise<ColorUseResult> {

// After:
export async function testColorUse(
  page: Page,
  url: string,
  llmClient: LLMClient | null,
  screenshotDir?: string,
  templatePrefix?: string,
  cvdCache?: Map<string, { diffPercent: number; issues: Issue[] }>,
  precomputedFingerprint?: string,  // NEW: skip computeCssFingerprint if provided
): Promise<ColorUseResult> {
```

Replace the fingerprint computation (line 195):

```typescript
// Before:
const fingerprint = await computeCssFingerprint(page);

// After:
const fingerprint = precomputedFingerprint ?? await computeCssFingerprint(page);
```

- [ ] **Step 4: Compute cssHash once per template in probe.ts**

In `runProbePhase`, inside the template loop, after `collectManifest` (probe.ts:95):

```typescript
import { computeCssFingerprint } from "../analyzer/screenshot-cvd";
import { computeColorUseFingerprint } from "./probe-cache";

// After collectManifest, before Phase 1:
const cssFingerprint = await computeCssFingerprint(page);
```

Pass `cssFingerprint` to:
1. `runPhase3Viewport` — replace the internal `computeCssFingerprint` call with the pre-computed value
2. `runPhase4Capture` — pass to `testColorUse` as `precomputedFingerprint`
3. Compute `colorUseFingerprint = computeColorUseFingerprint(cssFingerprint, manifest)` and use as cvdCache key

In `runPhase4Capture`, update the `testColorUse` call:

```typescript
// Before:
testColorUse(page, url, llmClient, screenshotDir, cluster.id.slice(0, 8), cvdCache),

// After:
const colorFp = computeColorUseFingerprint(cssFingerprint, manifest);
testColorUse(page, url, llmClient, screenshotDir, cluster.id.slice(0, 8), cvdCache, colorFp),
```

- [ ] **Step 5: Run full test suite**

Run: `bun test --timeout 30000`
Expected: All PASS

- [ ] **Step 6: Verify tsc**

Run: `bunx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/worker/probe-cache.ts src/worker/__tests__/probe-cache.test.ts src/analyzer/wcag-color-use.ts src/worker/probe.ts
git commit -m "feat: P4 color-use extended fingerprint + cssHash computed once per template"
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

In `runProbePhase`, add hit/miss counters alongside the caches:

```typescript
// After cache declarations (~line 68):
const cacheStats = { hfHits: 0, hfMisses: 0, tier1Hits: 0, tier1Misses: 0, evalHits: 0, evalMisses: 0 };
```

Increment in the appropriate places (pass `cacheStats` to phases, increment on cache hit/miss). Then log after the template loop:

```typescript
// After the template loop, before probeCtx.close():
console.log(`[probe] Cache stats — hf: ${cacheStats.hfHits}/${cacheStats.hfHits + cacheStats.hfMisses} hits, tier1: ${cacheStats.tier1Hits}/${cacheStats.tier1Hits + cacheStats.tier1Misses}, eval: ${cacheStats.evalHits}/${cacheStats.evalHits + cacheStats.evalMisses}`);
```

- [ ] **Step 2: Add cache hit rate to probe:representative span metadata**

In the `phaseTimings` object that's already set on `parentSpan`, add:

```typescript
phaseTimings.cacheStats = {
  hfHits: cacheStats.hfHits,
  hfMisses: cacheStats.hfMisses,
  tier1Hits: cacheStats.tier1Hits,
  tier1Misses: cacheStats.tier1Misses,
  evalHits: cacheStats.evalHits,
  evalMisses: cacheStats.evalMisses,
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
