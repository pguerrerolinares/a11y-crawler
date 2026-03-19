# Probe Optimization v6 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce RAM usage by ~150-300MB and audit time by ~48-68s while improving accessibility detection quality (closing hover-focus and onclick-without-role gaps).

**Architecture:** 3 implementation phases applied incrementally: (1) RAM reduction via Playwright lifecycle fixes, (2) redundancy elimination by moving axe-full to concurrent scan phase, (3) probe restructured into 4 phases (Static → Interaction → Viewport → Capture) with legacy keyboard test absorbed into Tier 2.

**Tech Stack:** Playwright, @axe-core/playwright, Bun runtime, PostgreSQL

**Spec:** `docs/superpowers/specs/2026-03-19-probe-optimization-v6-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/worker/manifest.ts` | Modify | Add `[onclick]` to element discovery selector |
| `src/worker/tier2.ts` | Modify | Add focusability pre-check, hover-focus sub-tests |
| `src/worker/tier1.ts` | Modify | Add cross-origin CSS short-circuit |
| `src/worker/adaptive-wait.ts` | Modify | Add `enableAnimations()` export |
| `src/types/pipeline.ts` | Modify | Change `pagesPerContext` default 25→5 |
| `src/types/manifest.ts` | Modify | Add `hasOnclick` field to `ElementManifest` |
| `src/worker/index.ts` | Modify | Add Chrome launch flags |
| `src/worker/slot-pool.ts` | Modify | Add incremental GC after context close |
| `src/worker/scan.ts` | Modify | Replace axe-light with axe-full, nullify response |
| `src/worker/probe.ts` | Modify | Restructure into 4 phases, axe cache, feature flag |
| `src/worker/probe-context.ts` | Modify | Add GC at phase boundaries |
| `src/analyzer/wcag-color-use.ts` | Modify | Accept output dir, write screenshots to disk |
| `src/analyzer/classify.ts` | Modify | Rename `lightIssues` → `axeIssues` |
| `src/analyzer/interactive.ts` | Modify | Remove `testKeyboardOperability` |
| `src/worker/__tests__/manifest.test.ts` | Create | Tests for onclick discovery |
| `src/worker/__tests__/tier2-focusability.test.ts` | Create | Tests for focusability pre-check |
| `src/worker/__tests__/tier1-crossorigin.test.ts` | Create | Tests for cross-origin short-circuit |
| `src/worker/__tests__/tier2-hoverfocus.test.ts` | Create | Tests for hover-focus sub-tests |
| `src/worker/__tests__/probe-phases.test.ts` | Create | Tests for phased probe structure |

---

## Task 1: Add `[onclick]` to manifest selector

**Files:**
- Modify: `src/worker/manifest.ts:55-56`
- Modify: `src/types/manifest.ts:2` (add `hasOnclick` field)
- Create: `src/worker/__tests__/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker/__tests__/manifest.test.ts
import { test, expect } from "bun:test";
import { collectManifest } from "../manifest";

// We need a real browser page for page.evaluate — use a minimal HTML fixture
test("collectManifest discovers [onclick] elements without ARIA role", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(`
    <html><body>
      <div onclick="alert(1)" style="width:100px;height:50px">Click me</div>
      <button>Real button</button>
      <div onclick="nav()" style="width:100px;height:50px">Nav div</div>
      <a href="#" onclick="return false">Link with onclick</a>
    </body></html>
  `);

  const manifest = await collectManifest(page);

  // Should find the 2 onclick divs (not the <a> or <button> which are already discovered by tag)
  const onclickDivs = manifest.filter(el => el.tag === "div" && el.hasOnclick === true);
  expect(onclickDivs.length).toBe(2);

  // Native interactive elements should NOT have hasOnclick set (they're discovered by tag)
  const button = manifest.find(el => el.tag === "button");
  expect(button).toBeDefined();

  await page.close();
  await browser.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/worker/__tests__/manifest.test.ts`
Expected: FAIL — `hasOnclick` property doesn't exist on `ElementManifest`

- [ ] **Step 3: Add `hasOnclick` to ElementManifest type**

In `src/types/manifest.ts`, add after `isFormControl: boolean;` (line 12):
```typescript
  hasOnclick: boolean;
```

- [ ] **Step 4: Add `[onclick]` to manifest selector and set `hasOnclick`**

In `src/worker/manifest.ts:55-56`, change the SELECTORS constant:
```typescript
    const SELECTORS =
      'a, button, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="link"], [tabindex], [onclick]:not(a):not(button):not(input):not(select):not(textarea)';
```

In `src/worker/manifest.ts:139-158`, add `hasOnclick` to the results.push object, after `isFormControl`:
```typescript
        hasOnclick: element.hasAttribute("onclick"),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/worker/__tests__/manifest.test.ts`
Expected: PASS

- [ ] **Step 6: Run all existing tests to check no regressions**

Run: `bun test`
Expected: All existing tests pass (some may need `hasOnclick` added to mock objects)

- [ ] **Step 7: Commit**

```bash
git add src/types/manifest.ts src/worker/manifest.ts src/worker/__tests__/manifest.test.ts
git commit -m "feat(manifest): discover [onclick] elements without ARIA role

Closes detection gap where <div onclick='...'> elements were invisible to
the tier system. Adds hasOnclick field to ElementManifest."
```

---

## Task 2: Add focusability pre-check in Tier 2

**Files:**
- Modify: `src/worker/tier2.ts:146-158` (evaluateKeyboard function)
- Modify: `src/worker/tier2.ts:292-313` (keyboard section in runTier2)
- Create: `src/worker/__tests__/tier2-focusability.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker/__tests__/tier2-focusability.test.ts
import { test, expect } from "bun:test";
import { evaluateKeyboard } from "../tier2";
import type { ElementManifest, InteractionResult } from "../../types/manifest";

function makeElement(overrides: Partial<ElementManifest> = {}): ElementManifest {
  return {
    selector: "div.custom-btn",
    tag: "div",
    role: "button",
    accessibleName: "Submit",
    boundingBox: { x: 0, y: 0, width: 100, height: 50 },
    hasHoverCss: false,
    hasAriaExpanded: false,
    hasAriaPressed: false,
    hasUnderline: false,
    isFormControl: false,
    hasOnclick: true,
    defaultStyles: { borderColor: "", outlineColor: "", backgroundColor: "", boxShadow: "", textDecorationLine: "", color: "" },
    parentBg: "rgb(255,255,255)",
    styleFingerprint: "",
    ...overrides,
  };
}

test("evaluateKeyboard emits custom-element-not-focusable when isFocusable is false", () => {
  const element = makeElement({ role: "button" });
  const result: InteractionResult = { keyboardResponded: undefined };

  // New: pass isFocusable flag
  const issues = evaluateKeyboard(element, result, "https://example.com", false);

  expect(issues.length).toBe(1);
  expect(issues[0].rule).toBe("custom-element-not-focusable");
  expect(issues[0].impact).toBe("critical");
});

test("evaluateKeyboard skips focusability check for native interactive elements", () => {
  const element = makeElement({ tag: "button", role: null });
  const result: InteractionResult = {};

  const issues = evaluateKeyboard(element, result, "https://example.com", false);
  expect(issues.length).toBe(0); // native elements are filtered by isNativeInteractive
});

test("evaluateKeyboard detects non-focusable onclick element without role", () => {
  const element = makeElement({ tag: "div", role: null, hasOnclick: true });
  const result: InteractionResult = {};

  const issues = evaluateKeyboard(element, result, "https://example.com", false);
  expect(issues.length).toBe(1);
  expect(issues[0].rule).toBe("custom-element-not-focusable");
  expect(issues[0].description).toContain("[onclick]");
});

test("evaluateKeyboard reports keyboard-operability when focusable but not responding", () => {
  const element = makeElement({ role: "button" });
  const result: InteractionResult = { keyboardResponded: false };

  const issues = evaluateKeyboard(element, result, "https://example.com", true);
  expect(issues.length).toBe(1);
  expect(issues[0].rule).toBe("keyboard-operability");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/worker/__tests__/tier2-focusability.test.ts`
Expected: FAIL — `evaluateKeyboard` doesn't accept 4th parameter

- [ ] **Step 3: Update `evaluateKeyboard` to accept and check focusability**

In `src/worker/tier2.ts:146-158`, replace the function:
```typescript
export function evaluateKeyboard(
  element: ElementManifest,
  result: InteractionResult,
  url: string,
  isFocusable: boolean = true,
): Issue[] {
  // Skip native interactive elements (keyboard handled by browser)
  if (isNativeInteractive(element.tag)) return [];
  // Skip elements that are neither custom role nor onclick
  if (!element.role && !element.hasOnclick) return [];

  // Pre-check: custom interactive element must be focusable
  if (!isFocusable) {
    return [makeIssue(element.selector, url, "custom-element-not-focusable",
      `Custom interactive element (${element.role ? `role="${element.role}"` : "[onclick]"}) is not keyboard focusable — needs tabindex="0" (WCAG 2.1.1)`,
      "2.1.1", "critical")];
  }

  if (result.keyboardResponded === false) {
    const label = element.role ? `role="${element.role}"` : "[onclick]";
    return [makeIssue(element.selector, url, "keyboard-operability",
      `Custom interactive element (${label}) does not respond to Enter/Space keyboard (WCAG 2.1.1)`,
      "2.1.1")];
  }
  return [];
}
```

- [ ] **Step 4: Update `runTier2` keyboard section to check focusability**

In `src/worker/tier2.ts:292-318`, replace the keyboard block:
```typescript
      // 4. KEYBOARD (custom interactive elements + onclick without role)
      const isCustomInteractive = (element.role && !isNativeInteractive(element.tag)) ||
                                   (!element.role && element.hasOnclick);
      if (isCustomInteractive) {
        // Pre-check focusability
        const isFocusable = await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement;
          if (!el) return false;
          // Natively focusable or has tabindex
          if (el.tabIndex >= 0) return true;
          return false;
        }, element.selector);

        if (isFocusable) {
          await page.evaluate((sel) => {
            (document.querySelector(sel) as HTMLElement)?.focus();
          }, element.selector);
          const urlBefore = page.url();
          const originBefore = new URL(urlBefore).origin;
          await page.keyboard.press("Enter");
          await adaptiveWait(page, element.selector, "keyboard", 100);
          const urlAfter = page.url();
          const navigated = urlAfter !== urlBefore;
          result.keyboardResponded = navigated || !!result.ariaStateChanged;
          if (navigated) {
            const originAfter = new URL(urlAfter).origin;
            if (originAfter === originBefore) {
              await page.goBack({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
            } else {
              await page.goto(urlBefore, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
            }
          }
        }

        timer.recordInteraction("keyboardTests");
        allIssues.push(...evaluateKeyboard(element, result, url, isFocusable));
      } else {
        allIssues.push(...evaluateKeyboard(element, result, url));
      }
```

Also remove the old `evaluateKeyboard` call from line 318 (it's now inside the keyboard block).

- [ ] **Step 5: Run tests**

Run: `bun test src/worker/__tests__/tier2-focusability.test.ts`
Expected: PASS

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/worker/tier2.ts src/worker/__tests__/tier2-focusability.test.ts
git commit -m "feat(tier2): add focusability pre-check for custom interactive elements

Detects <div role='button'> and [onclick] elements without tabindex as
CRITICAL keyboard-operability issues. Prerequisite for removing legacy
testKeyboardOperability."
```

---

## Task 3: Short-circuit Tier 1 on cross-origin CSS

**Files:**
- Modify: `src/worker/tier1.ts:82-96`
- Create: `src/worker/__tests__/tier1-crossorigin.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker/__tests__/tier1-crossorigin.test.ts
import { test, expect } from "bun:test";
import { runTier1 } from "../tier1";
import { TierTimer } from "../tier-timer";
import type { StyleGroup, ElementManifest } from "../../types/manifest";

function makeGroup(selector: string): StyleGroup {
  const el: ElementManifest = {
    selector, tag: "a", role: null, accessibleName: "Link",
    boundingBox: { x: 0, y: 0, width: 100, height: 20 },
    hasHoverCss: false, hasAriaExpanded: false, hasAriaPressed: false,
    hasUnderline: false, isFormControl: false, hasOnclick: false,
    defaultStyles: { borderColor: "rgb(0,0,0)", outlineColor: "rgb(0,0,0)", backgroundColor: "transparent", boxShadow: "none", textDecorationLine: "none", color: "rgb(0,0,255)" },
    parentBg: "rgb(255,255,255)", styleFingerprint: "body|a|link",
  };
  return { fingerprint: el.styleFingerprint, representative: el, members: [el] };
}

test("runTier1 short-circuits when all stylesheets are cross-origin", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Page with only a cross-origin stylesheet (simulated by blocking access)
  await page.setContent(`
    <html>
    <head><link rel="stylesheet" href="https://cdn.example.com/style.css"></head>
    <body><a href="#">Link</a></body>
    </html>
  `);

  const timer = new TierTimer("test-audit", "test-template", "https://example.com");
  const groups = [makeGroup("a")];
  const result = await runTier1(page, groups, "https://example.com", timer);

  // Should promote ALL elements (no CSSOM analysis possible)
  expect(result.promotedElements.length).toBe(1);
  expect(result.issues.length).toBe(0);

  // Timer should show skipped
  const timing = timer.getTiming();
  expect(timing.tier1.durationMs).toBeLessThan(100); // near-instant

  await page.close();
  await browser.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/worker/__tests__/tier1-crossorigin.test.ts`
Expected: FAIL — Tier 1 runs full CSSOM analysis even on cross-origin CSS

- [ ] **Step 3: Add cross-origin detection at top of `runTier1`**

In `src/worker/tier1.ts`, after `timer.startTier("tier1");` (line 88), add:
```typescript
  // Short-circuit: if no same-origin stylesheets are accessible, CSSOM analysis
  // cannot resolve any elements. Promote all to Tier 2 immediately.
  const hasAccessibleCSS = await page.evaluate(() => {
    return Array.from(document.styleSheets).some(sheet => {
      try { sheet.cssRules; return true; } catch { return false; }
    });
  });

  if (!hasAccessibleCSS) {
    const allElements = groups.map(g => g.representative);
    timer.endTier("tier1", {
      issuesFound: 0,
      elementsPromotedToTier2: allElements.length,
      skippedByFingerprint: 0,
      shortCircuited: "cross-origin-css",
    });
    return { issues: [], promotedElements: allElements };
  }
```

- [ ] **Step 4: Run test**

Run: `bun test src/worker/__tests__/tier1-crossorigin.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/worker/tier1.ts src/worker/__tests__/tier1-crossorigin.test.ts
git commit -m "perf(tier1): short-circuit CSSOM analysis on cross-origin CSS sites

Detects when all stylesheets are cross-origin (CDN) and promotes all
elements directly to Tier 2, skipping useless CSSOM traversal.
Closes HIGH-5 from backlog."
```

---

## Task 4: Implement hover-focus sub-tests in Tier 2

**Files:**
- Modify: `src/worker/tier2.ts:248-253` (after detectPopup in hover section)
- Create: `src/worker/__tests__/tier2-hoverfocus.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker/__tests__/tier2-hoverfocus.test.ts
import { test, expect } from "bun:test";
import { evaluateHoverFocus } from "../tier2";
import type { ElementManifest, InteractionResult } from "../../types/manifest";

function makeElement(): ElementManifest {
  return {
    selector: "a.nav-link", tag: "a", role: null, accessibleName: "Menu",
    boundingBox: { x: 100, y: 100, width: 200, height: 40 },
    hasHoverCss: false, hasAriaExpanded: false, hasAriaPressed: false,
    hasUnderline: false, isFormControl: false, hasOnclick: false,
    defaultStyles: { borderColor: "", outlineColor: "", backgroundColor: "", boxShadow: "", textDecorationLine: "", color: "" },
    parentBg: "rgb(255,255,255)", styleFingerprint: "",
  };
}

test("evaluateHoverFocus reports not-persistent when popup disappears", () => {
  const el = makeElement();
  const result: InteractionResult = {
    hoverPopup: { selector: ".tooltip", type: "css-transition", boundingBox: { x: 100, y: 140, width: 200, height: 30 } },
    popupPersistent: false,
    popupHoverable: true,
    popupDismissible: true,
  };
  const issues = evaluateHoverFocus(el, result, "https://example.com");
  expect(issues.length).toBe(1);
  expect(issues[0].rule).toBe("hover-focus");
  expect(issues[0].description).toContain("disappears");
});

test("evaluateHoverFocus reports not-hoverable", () => {
  const el = makeElement();
  const result: InteractionResult = {
    hoverPopup: { selector: ".tooltip", type: "css-transition", boundingBox: { x: 100, y: 140, width: 200, height: 30 } },
    popupPersistent: true,
    popupHoverable: false,
    popupDismissible: true,
  };
  const issues = evaluateHoverFocus(el, result, "https://example.com");
  expect(issues.length).toBe(1);
  expect(issues[0].description).toContain("not hoverable");
});

test("evaluateHoverFocus reports not-dismissible", () => {
  const el = makeElement();
  const result: InteractionResult = {
    hoverPopup: { selector: ".tooltip", type: "css-transition", boundingBox: { x: 100, y: 140, width: 200, height: 30 } },
    popupPersistent: true,
    popupHoverable: true,
    popupDismissible: false,
  };
  const issues = evaluateHoverFocus(el, result, "https://example.com");
  expect(issues.length).toBe(1);
  expect(issues[0].description).toContain("dismissed");
});

test("evaluateHoverFocus returns no issues when all 3 pass", () => {
  const el = makeElement();
  const result: InteractionResult = {
    hoverPopup: { selector: ".tooltip", type: "css-transition", boundingBox: { x: 100, y: 140, width: 200, height: 30 } },
    popupPersistent: true,
    popupHoverable: true,
    popupDismissible: true,
  };
  const issues = evaluateHoverFocus(el, result, "https://example.com");
  expect(issues.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `bun test src/worker/__tests__/tier2-hoverfocus.test.ts`
Expected: Tests should pass already since `evaluateHoverFocus` checks these fields. The issue is that `runTier2` never SETS these fields.

- [ ] **Step 3: Implement popup sub-tests in `runTier2` hover section**

In `src/worker/tier2.ts`, after `result.hoverPopup = await detectPopup(page, element);` (line 251), add the hover-focus sub-tests:

```typescript
      // WCAG 1.4.13 sub-tests: persistence, hoverability, dismissibility
      // These use page.mouse.move() (real pointer movement) unlike the dispatchEvent
      // approach above, because we need to test actual mouse interaction behavior.
      if (result.hoverPopup) {
        const popup = result.hoverPopup;
        const triggerBox = element.boundingBox;

        // Re-trigger hover with real mouse to ensure browser :hover is active
        // (dispatchEvent doesn't activate CSS :hover pseudo-class)
        await page.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
        await adaptiveWait(page, popup.selector, "re-hover-real", 200);

        // 1. PERSISTENCE: move mouse away from trigger, check if popup stays
        await page.mouse.move(triggerBox.x - 50, triggerBox.y - 50);
        await adaptiveWait(page, popup.selector, "persistence", 300);
        const stillVisible = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const cs = getComputedStyle(el);
          return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0"
            && el.getBoundingClientRect().height > 0;
        }, popup.selector);
        result.popupPersistent = stillVisible;

        // 2. HOVERABILITY: move mouse to popup, check if it remains
        if (stillVisible) {
          const popupBox = popup.boundingBox;
          await page.mouse.move(popupBox.x + popupBox.width / 2, popupBox.y + popupBox.height / 2);
          await adaptiveWait(page, popup.selector, "hoverability", 100);
          result.popupHoverable = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const cs = getComputedStyle(el);
            return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0"
              && el.getBoundingClientRect().height > 0;
          }, popup.selector);
        } else {
          result.popupHoverable = false;
        }

        // 3. DISMISSIBILITY: press Escape, check if popup closes
        // Re-trigger hover first to restore popup
        await page.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
        await adaptiveWait(page, popup.selector, "re-hover", 200);
        await page.keyboard.press("Escape");
        await adaptiveWait(page, popup.selector, "dismiss", 200);
        const dismissed = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return true; // element removed = dismissed
          const cs = getComputedStyle(el);
          return cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0"
            || el.getBoundingClientRect().height === 0;
        }, popup.selector);
        result.popupDismissible = dismissed;
      }

      // Clean up hover state before next element
      await handle.dispatchEvent("mouseout");
```

Also remove the existing `await handle.dispatchEvent("mouseout");` on line 252 (moved into the block above, after sub-tests).

- [ ] **Step 4: Run hover-focus tests**

Run: `bun test src/worker/__tests__/tier2-hoverfocus.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/worker/tier2.ts src/worker/__tests__/tier2-hoverfocus.test.ts
git commit -m "feat(tier2): implement WCAG 1.4.13 hover-focus sub-tests

Tests popup persistence, hoverability, and dismissibility using real
mouse movement (page.mouse.move). Closes hover-focus gap from Auditoria manual de referencia
comparison in /equipo/."
```

---

## Task 5: Phase 1 RAM optimizations

**Files:**
- Modify: `src/types/pipeline.ts:100`
- Modify: `src/worker/index.ts:13-16`
- Modify: `src/worker/scan.ts:47-63, 130-135`
- Modify: `src/worker/slot-pool.ts:24`
- Modify: `src/worker/adaptive-wait.ts`
- Modify: `src/worker/pipeline.ts` (GC at phase boundaries)

- [ ] **Step 1: Change `pagesPerContext` default from 25 to 5**

In `src/types/pipeline.ts:100`, change:
```typescript
  pagesPerContext: 5,
```

- [ ] **Step 2: Add Chrome launch flags for local dev**

In `src/worker/index.ts:13-16`, replace the local launch:
```typescript
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
      ],
    });
```

- [ ] **Step 3: Nullify response in scan**

In `src/worker/scan.ts`, after the status code check block (after line 85), add:
```typescript
          // Release response reference — context accumulates metadata per Playwright #6319
          response = null;
```

Change `let response;` at line 47 to `let response: any = null;` to allow nullification.

- [ ] **Step 4: Add `setLegacyMode(true)` to axe calls**

First, check axe-core version:
Run: `grep @axe-core/playwright package.json`
Expected: Version >= 4.4

In `src/worker/scan.ts:132-134`, add `.setLegacyMode(true)`:
```typescript
            const axeResults = await new AxeBuilder({ page })
              .setLegacyMode(true)
              .withRules(AXE_LIGHT_RULES)
              .options({ resultTypes: ["violations", "incomplete"] })
              .analyze();
```

In `src/worker/probe.ts:273-276`, add `.setLegacyMode(true)`:
```typescript
  const results = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(tags)
    .options({ resultTypes: ["violations", "incomplete"] })
    .analyze();
```

- [ ] **Step 5: Add incremental GC to slot-pool**

In `src/worker/slot-pool.ts:24`, after `await this.context.close();`:
```typescript
        if (typeof Bun !== 'undefined') Bun.gc(false);
```

- [ ] **Step 6: Add `enableAnimations` to adaptive-wait**

In `src/worker/adaptive-wait.ts`, add after the `disableAnimations` function:
```typescript
/**
 * Re-enable CSS animations/transitions. Call at the boundary between
 * Phase 2 (interaction) and Phase 3 (viewport) to ensure viewport tests
 * and screenshots see real animation state.
 */
export async function enableAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const tag = document.querySelector('style[data-disable-animations]');
    if (tag) tag.remove();
  });
}
```

Also update `disableAnimations` to tag the style element (use the `ElementHandle` returned by `addStyleTag` for race-free tagging):
```typescript
export async function disableAnimations(page: Page): Promise<void> {
  const handle = await page.addStyleTag({
    content: `
      *, *::before, *::after {
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        animation-duration: 0s !important;
        animation-delay: 0s !important;
      }
    `,
  });
  await handle.evaluate(el => el.setAttribute('data-disable-animations', 'true'));
}
```

- [ ] **Step 7: Add full GC at phase boundaries in pipeline**

In `src/worker/pipeline.ts`, after the scan phase flush (line 127):
```typescript
      if (typeof Bun !== 'undefined') Bun.gc(true);
```

And after the classify phase (line 154):
```typescript
      if (typeof Bun !== 'undefined') Bun.gc(true);
```

- [ ] **Step 8: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add src/types/pipeline.ts src/worker/index.ts src/worker/scan.ts src/worker/slot-pool.ts src/worker/adaptive-wait.ts src/worker/pipeline.ts src/worker/probe.ts
git commit -m "perf: Phase 1 RAM optimizations

- pagesPerContext 25→5 (Playwright #6319 context memory fix)
- Chrome --disable-dev-shm-usage flag for VPS
- setLegacyMode(true) for axe-core (skip blank page per analyze)
- Incremental GC on context recycle, full GC at phase boundaries
- Nullify response objects in scan
- enableAnimations() for phase boundary cleanup"
```

---

## Task 6: Move axe-full to scan phase

**Files:**
- Modify: `src/worker/scan.ts:16, 130-163`
- Modify: `src/types/pipeline.ts:11-21` (ScanResult type)
- Modify: `src/worker/probe.ts:85-90`

- [ ] **Step 1: Update `ScanResult` to hold full axe issues**

In `src/types/pipeline.ts:11-21`, rename `lightIssues` to `axeIssues`:
```typescript
export interface ScanResult {
  url: string;
  fingerprint: string;
  title: string;
  links: string[];
  elementCount: number;
  capabilities: PageCapabilities;
  axeIssues: Issue[];  // was: lightIssues
  pageId: string;
  discoveryMethod: "standard" | "networkidle-retry" | "llm";
}
```

- [ ] **Step 2: Replace axe-light with axe-full in scan**

In `src/worker/scan.ts:16`, remove `AXE_LIGHT_RULES` constant.

Replace the axe block at lines 130-163 with:
```typescript
          // axe-core FULL — all WCAG AA rules (replaces light scan, results cached for probe)
          let axeIssues: Issue[] = [];
          try {
            const axeResults = await new AxeBuilder({ page })
              .setLegacyMode(true)
              .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
              .options({ resultTypes: ["violations", "incomplete"] })
              .analyze();

            axeIssues = axeResults.violations.flatMap((v) =>
              v.nodes.map((node) => ({
                id: crypto.randomUUID(),
                url: finalUrl,
                rule: v.id,
                impact: (v.impact ?? "minor") as Issue["impact"],
                description: v.description,
                help: v.help,
                helpUrl: v.helpUrl,
                wcagTags: v.tags,
                selector: node.target.join(", "),
                html: node.html,
                surroundingHtml: "",
                xpath: "",
                viewportWidth: 1280,
                pageTitle: domData.title,
                checkSource: "axe" as const,
                suggestedFix: node.failureSummary ?? "",
                fixConfidence: null,
                llmConfidence: null,
                wcagCriterion: "",
                violationCategory: "structural" as const,
              })),
            );
          } catch {
            // axe failure is non-fatal
          }
```

Update the `ScanResult` construction to use `axeIssues` instead of `lightIssues`.

- [ ] **Step 3: Update probe to use cached axe results**

In `src/worker/probe.ts`, the `runProbePhase` function receives `templates` which have access to `scanResults` via the pipeline. We need to pass the scan results map into the probe phase.

First, update `runProbePhase` signature to accept a scan results cache:
```typescript
export async function runProbePhase(
  getBrowser: () => Promise<Browser>,
  auditId: string,
  templates: TemplateCluster[],
  config: PipelineConfig,
  tracer: AuditTracer,
  llmClient: LLMClient | null = null,
  axeCache?: Map<string, Issue[]>,  // NEW: cached axe results from scan
): Promise<void> {
```

Then replace the axe-full block (lines 85-90):
```typescript
          // 1. axe-core (use scan cache when available, fallback to full scan)
          let axeIssues: Issue[];
          if (axeCache?.has(url)) {
            axeIssues = axeCache.get(url)!;
          } else if (cluster.testPlan.includes("axe-full")) {
            axeIssues = await runAxeFull(page, url, config);
          } else {
            axeIssues = [];
          }
          allIssues.push(...axeIssues);
          parentSpan.setMeta({ axeViolations: axeIssues.length });
```

Update the call in `pipeline.ts:165` to pass the cache:
```typescript
        // Build axe cache from scan results
        const axeCache = new Map<string, Issue[]>();
        for (const [url, result] of scanResults) {
          if (result.axeIssues.length > 0) {
            axeCache.set(url, result.axeIssues);
          }
        }
        await runProbePhase(getBrowser, auditId, templates, config, tracer, llmClient, axeCache);
```

- [ ] **Step 4: Update ALL references to `lightIssues` → `axeIssues`**

Run: `grep -r "lightIssues" src/` and update every occurrence. **Critical files** (missing any will break the build):
- `src/worker/scan.ts` — result construction
- `src/worker/pipeline.ts` — if referenced
- `src/types/pipeline.ts` — `ScanResult` and `TemplateCluster` types both have `lightIssues`
- `src/analyzer/classify.ts` — uses `lightIssues` at lines 16, 30 (aggregation logic)
- `src/analyzer/__tests__/classify.test.ts` — ~8 occurrences in test fixtures

In `TemplateCluster` type, rename `lightIssues` to `axeIssues`.

**Note**: Existing audit data in PostgreSQL will have `checkSource: "scan-light"`. New data will use `checkSource: "axe"`. Grep for `scan-light` in frontend/API code and update any filters.

**RAM note**: `classify.ts` aggregates issues across cluster members. With full axe results (vs 5-rule light), the aggregated arrays will be larger during classification. This is bounded by scan phase (33 pages) and transient — results are persisted to DB and released.

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All pass (some tests may need `lightIssues` → `axeIssues` renaming)

- [ ] **Step 6: Commit**

```bash
git add src/worker/scan.ts src/worker/probe.ts src/worker/pipeline.ts src/types/pipeline.ts
git commit -m "perf: move axe-full to scan phase with result caching

Replaces axe-light (5 rules) in scan with axe-full (all WCAG AA rules),
running with concurrency=3. Probe reuses cached results by URL, eliminating
~2.5s of sequential axe-full per template. Net savings: ~32-42s."
```

---

## Task 7: Update screenshots to write directly to disk

> **Note:** This must run BEFORE probe restructure (Task 8) because Phase 4 uses the new `testColorUse` API with `screenshotDir` parameter.

**Files:**
- Modify: `src/analyzer/wcag-color-use.ts`
- Modify: `src/worker/probe.ts` (current screenshot write logic at lines 164-178)

- [ ] **Step 1: Update `testColorUse` to accept output directory**

Add `screenshotDir` and `templatePrefix` parameters to `testColorUse`. Use `page.screenshot({ path })` directly instead of returning buffers.

Update the return type: `ColorUseResult.screenshots` becomes `{ deficiency: string; normalPath: string; cvdPath: string }[]` instead of `{ deficiency: string; normalPng: Buffer; cvdPng: Buffer }[]`.

- [ ] **Step 2: Remove `Bun.write()` calls from probe.ts**

Replace the screenshot writing block at `probe.ts:164-178` with a simpler call that passes the directory:
```typescript
if (cluster.testPlan.includes("color-use")) {
  const screenshotDir = join(process.env.REPORTS_DIR || "./reports", auditId, "screenshots");
  await Bun.write(join(screenshotDir, ".keep"), "");
  const colorResult = await withTimeout(
    testColorUse(page, url, llmClient, screenshotDir, cluster.id.slice(0, 8)),
    45_000,
  );
  if (colorResult) allIssues.push(...colorResult.issues);
}
```

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/analyzer/wcag-color-use.ts src/worker/probe.ts
git commit -m "perf: write CVD screenshots directly to disk

Eliminates ~50MB peak buffer memory by using page.screenshot({ path })
instead of buffering PNGs in memory then writing with Bun.write()."
```

---

## Task 8: Restructure probe.ts into 4 phases

**Files:**
- Modify: `src/worker/probe.ts` (major restructure)
- Create: `src/worker/__tests__/probe-phases.test.ts`

This is the largest task. The current ~120-line probe body becomes 4 named functions.

- [ ] **Step 1: Extract current probe body as `runProbeLegacy`**

Rename the current probe body content (inside the template loop) to a private function `runProbeLegacy`. This preserves the old behavior for the feature flag.

- [ ] **Step 2: Create phase functions**

Create 4 functions in `src/worker/probe.ts`:

```typescript
async function runPhase1Static(
  page: Page, cluster: TemplateCluster, url: string,
  timer: TierTimer, manifest: ElementManifest[], styleGroups: StyleGroup[],
  axeCache: Map<string, Issue[]> | undefined, config: PipelineConfig,
  llmClient: LLMClient | null,
): Promise<{ issues: Issue[]; promotedElements: ElementManifest[] }> {
  const issues: Issue[] = [];

  // Tier 1: CSSOM
  const { issues: tier1Issues, promotedElements } = await runTier1(page, styleGroups, url, timer);
  issues.push(...tier1Issues);

  // axe-core (from cache or fallback)
  if (axeCache?.has(url)) {
    issues.push(...axeCache.get(url)!);
  } else if (cluster.testPlan.includes("axe-full")) {
    issues.push(...await runAxeFull(page, url, config));
  }

  // Error identification (must run before interactions — :invalid persists)
  if (cluster.testPlan.includes("error-identification")) {
    issues.push(...await testErrorIdentification(page, url));
  }

  // page.evaluate() tests (parallel, read-only)
  const evaluateTests: Promise<Issue[]>[] = [];
  if (cluster.testPlan.includes("target-size")) evaluateTests.push(testTargetSize(page, url));
  if (cluster.testPlan.includes("multimedia")) evaluateTests.push(testMultimedia(page, url));
  if (cluster.testPlan.includes("timed-events")) evaluateTests.push(testTimedEvents(page, url));
  if (cluster.testPlan.includes("non-text-contrast")) evaluateTests.push(testNonTextContrast(page, url));
  if (cluster.testPlan.includes("meaningful-sequence")) evaluateTests.push(testMeaningfulSequence(page, url));
  if (cluster.testPlan.includes("semantic-structure")) evaluateTests.push(testSemanticStructure(page, url));
  if (cluster.testPlan.includes("legal-a11y")) evaluateTests.push(testLegalA11y(page, url));
  const evalResults = await Promise.all(evaluateTests);
  issues.push(...evalResults.flat());

  // Sensory instructions (LLM text — can run during static phase)
  if (cluster.testPlan.includes("sensory-instructions")) {
    const r = await withTimeout(testSensoryInstructions(page, url, llmClient), 30_000);
    if (r) issues.push(...r);
  }

  return { issues, promotedElements };
}

async function runPhase2Interaction(
  page: Page, promotedElements: ElementManifest[], url: string,
  timer: TierTimer, cluster: TemplateCluster,
): Promise<{ issues: Issue[]; promotedToTier3: ElementManifest[] }> {
  const issues: Issue[] = [];

  // Tier 2: unified interaction pass
  const { issues: tier2Issues, promotedToTier3 } = await runTier2(page, promotedElements, url, timer);
  issues.push(...tier2Issues);

  // Legacy interactive tests (minus keyboard-operability, now in Tier 2)
  if (cluster.testPlan.includes("interactive")) {
    const interactiveIssues = await runInteractiveTests(page, url);
    issues.push(...interactiveIssues);
  }

  // Re-enable animations (disabled by Tier 2)
  await enableAnimations(page);

  return { issues, promotedToTier3 };
}

async function runPhase3Viewport(
  page: Page, url: string, cluster: TemplateCluster,
): Promise<Issue[]> {
  const issues: Issue[] = [];

  if (cluster.testPlan.includes("reflow")) {
    issues.push(...await testReflow(page, url));
  }
  if (cluster.testPlan.includes("resize-text")) {
    issues.push(...await testResizeText(page, url));
  }
  if (cluster.testPlan.includes("text-spacing")) {
    issues.push(...await testTextSpacing(page, url));
  }

  return issues;
}

async function runPhase4Capture(
  page: Page, url: string, cluster: TemplateCluster,
  auditId: string, llmClient: LLMClient | null,
  promotedToTier3: ElementManifest[],
): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Defensive viewport reset
  await page.setViewportSize({ width: 1280, height: 720 });

  // Color-use CVD
  if (cluster.testPlan.includes("color-use")) {
    const screenshotDir = join(process.env.REPORTS_DIR || "./reports", auditId, "screenshots");
    const colorResult = await withTimeout(
      testColorUse(page, url, llmClient, screenshotDir, cluster.id.slice(0, 8)),
      45_000,
    );
    if (colorResult) issues.push(...colorResult.issues);
  }

  // Status messages
  if (cluster.testPlan.includes("status-messages")) {
    const r = await withTimeout(testStatusMessages(page, url), 30_000);
    if (r) issues.push(...r);
  }

  // Tier 3 queue
  if (promotedToTier3.length > 0 && llmClient) {
    const tier3Elements = promotedToTier3.map(el => ({
      selector: el.selector,
      context: `${el.tag} element: ${el.accessibleName || el.selector}`,
      promptType: "color-use-link",
    }));
    await insertTier3Job(auditId, cluster.id, tier3Elements, 2).catch(err => {
      console.warn(`[probe] Failed to insert tier3 job: ${err}`);
    });
  }

  return issues;
}
```

- [ ] **Step 3: Wire up the phased probe with feature flag**

```typescript
const USE_PHASED_PROBE = process.env.PROBE_V2 !== "false";

// Inside the template loop:
if (USE_PHASED_PROBE) {
  // Tier 0: Manifest (computed before phases, shared across Phase 1 and 2)
  timer.startTier("tier0");
  const manifest = await collectManifest(page);
  const styleGroups = groupByFingerprint(manifest);
  timer.endTier("tier0", {
    elementsDiscovered: manifest.length,
    styleGroups: styleGroups.length,
    representativeElements: styleGroups.length,
  });

  // Phase 1: Static
  const { issues: phase1Issues, promotedElements } =
    await runPhase1Static(page, cluster, url, timer, manifest, styleGroups, axeCache, config, llmClient);
  allIssues.push(...phase1Issues);

  // Phase 2: Interaction
  const { issues: phase2Issues, promotedToTier3 } =
    await runPhase2Interaction(page, promotedElements, url, timer, cluster);
  allIssues.push(...phase2Issues);

  // Phase 3: Viewport
  const phase3Issues = await runPhase3Viewport(page, url, cluster);
  allIssues.push(...phase3Issues);

  // Phase 4: Capture + Async
  const phase4Issues = await runPhase4Capture(page, url, cluster, auditId, llmClient, promotedToTier3);
  allIssues.push(...phase4Issues);
} else {
  // Legacy probe (unchanged)
  await runProbeLegacy(page, cluster, ...);
}
```

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/worker/probe.ts src/worker/__tests__/probe-phases.test.ts
git commit -m "refactor: restructure probe into 4 phases (Static/Interaction/Viewport/Capture)

Separates probe by DOM mutation profile:
- Phase 1 (Static): Tier 0/1, axe, evaluate tests — no DOM mutation
- Phase 2 (Interaction): Tier 2, tab order, focus visibility — per-element mutation
- Phase 3 (Viewport): reflow, resize-text, text-spacing — viewport mutation
- Phase 4 (Capture): color-use screenshots, status messages, Tier 3 queue

Feature flag PROBE_V2 (default: enabled) allows instant rollback."
```

---

## Task 9: Remove `testKeyboardOperability` from legacy

**Files:**
- Modify: `src/analyzer/interactive.ts`

**Prerequisite check:** Tasks 1 and 2 must be merged and verified.

- [ ] **Step 1: Verify prerequisites**

Run: `bun test src/worker/__tests__/manifest.test.ts src/worker/__tests__/tier2-focusability.test.ts`
Expected: Both PASS — confirming onclick discovery and focusability pre-check work.

- [ ] **Step 2: Remove `testKeyboardOperability` from `runInteractiveTests`**

In `src/analyzer/interactive.ts`, find the `runInteractiveTests` function and remove the call to `testKeyboardOperability`. Keep `testTabOrder`, `testFocusVisibility`, `testSkipNavigation`.

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/analyzer/interactive.ts
git commit -m "perf: remove legacy testKeyboardOperability (covered by Tier 2)

Tier 2 now handles keyboard operability with:
- [onclick] discovery via manifest (Task 1)
- Focusability pre-check (Task 2)
Saves ~15-25s per audit by eliminating duplicate keyboard testing."
```

---

## Verification

After all tasks are complete:

- [ ] **Run full test suite**: `bun test`
- [ ] **Run a real audit** against a test site to verify end-to-end
- [ ] **Check RAM usage**: Compare `heapUsed` at `pipeline.ts:39` before vs after
- [ ] **Check audit duration**: Compare performance API output before vs after
- [ ] **Verify hover-focus detection**: Run against a site with tooltips/popups
- [ ] **Test feature flag rollback**: Set `PROBE_V2=false` and verify legacy probe still works
