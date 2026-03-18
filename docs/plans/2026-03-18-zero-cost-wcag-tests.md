# Zero-Cost WCAG Tests + Plumbing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 5 new WCAG tests that require zero LLM cost (pure Playwright + DOM heuristics), plus the plumbing changes needed for future LLM-based tests.

**Architecture:** Each new test follows the existing pattern: `(page: Page, url: string) => Promise<Issue[]>`. Tests plug into the probe phase via `TestType` union + `buildTestPlan()` + conditional execution in `probe.ts`. Plumbing adds `LLMClient` pass-through to probe phase and `llm_confidence` DB column.

**Tech Stack:** TypeScript, Playwright, PostgreSQL, Bun

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/types/pipeline.ts` | Modify | Add 5 new TestType values |
| `src/types/issue.ts` | Modify | Add `"llm-vision"` CheckSource |
| `src/analyzer/classify.ts` | Modify | Add new tests to `buildTestPlan()` |
| `src/analyzer/category.ts` | Modify | Add rule→category mappings |
| `src/worker/probe.ts` | Modify | Import + execute new tests, accept LLMClient |
| `src/worker/pipeline.ts` | Modify | Pass LLMClient to `runProbePhase()` |
| `src/worker/db.ts` | Modify | Add `llm_confidence` column migration |
| `src/analyzer/wcag-hover-focus.ts` | Create | WCAG 1.4.13 hover/focus state machine |
| `src/analyzer/wcag-meaningful-sequence.ts` | Create | WCAG 1.3.2 Kendall tau |
| `src/analyzer/wcag-aria-states.ts` | Create | WCAG 4.1.2 dynamic ARIA verification |
| `src/analyzer/wcag-status-messages.ts` | Create | WCAG 4.1.3 live region check |
| `src/analyzer/wcag-semantic-structure.ts` | Create | WCAG 1.3.1 pseudo-heading/list/table heuristics |
| `src/analyzer/__tests__/wcag-meaningful-sequence.test.ts` | Create | Unit tests for Kendall tau |
| `src/analyzer/__tests__/wcag-semantic-structure.test.ts` | Create | Unit tests for heuristics |

---

## Task 1: Plumbing — Types, DB Migration, LLMClient Pass-Through

**Files:**
- Modify: `src/types/pipeline.ts:23-33`
- Modify: `src/types/issue.ts:3`
- Modify: `src/worker/db.ts` (migration)
- Modify: `src/worker/pipeline.ts:152` (call site)
- Modify: `src/worker/probe.ts:22-28` (signature)

- [ ] **Step 1: Add new TestType values**

In `src/types/pipeline.ts`, replace the TestType union:

```typescript
export type TestType =
  | "axe-full"
  | "interactive"
  | "reflow"
  | "text-spacing"
  | "resize-text"
  | "multimedia"
  | "timed-events"
  | "target-size"
  | "error-identification"
  | "non-text-contrast"
  // v4.3 — zero-cost WCAG tests
  | "hover-focus"
  | "meaningful-sequence"
  | "aria-states"
  | "status-messages"
  | "semantic-structure";
```

- [ ] **Step 2: Add `"llm-vision"` to CheckSource**

In `src/types/issue.ts:3`:

```typescript
export type CheckSource = "axe" | "llm" | "llm-vision" | "interactive" | "scan-light" | "wcag-custom";
```

- [ ] **Step 3: Add `llm_confidence` DB migration**

In `src/worker/db.ts`, add a new migration block after the existing `v4-pipeline-columns` migration:

```typescript
  if (!appliedSet.has("v4.3-llm-confidence")) {
    console.log("Running migration: v4.3-llm-confidence");
    await db.begin(async (tx) => {
      await tx.unsafe(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS llm_confidence TEXT`);
      await tx`INSERT INTO migrations (id) VALUES ('v4.3-llm-confidence')`;
    });
    console.log("Migration v4.3-llm-confidence applied");
  }
```

- [ ] **Step 4: Pass LLMClient to runProbePhase**

In `src/worker/probe.ts`, update the function signature:

```typescript
import type { LLMClient } from "../llm/client";

export async function runProbePhase(
  getBrowser: () => Promise<Browser>,
  auditId: string,
  templates: TemplateCluster[],
  config: PipelineConfig,
  tracer: AuditTracer,
  llmClient: LLMClient | null = null,
): Promise<void> {
```

In `src/worker/pipeline.ts`, update the call site (inside `audit:probe` trace):

```typescript
await runProbePhase(getBrowser, auditId, templates, config, tracer, llmClient);
```

- [ ] **Step 5: Update buildTestPlan to include new tests**

In `src/analyzer/classify.ts`, update `buildTestPlan()`:

```typescript
export function buildTestPlan(cluster: TemplateCluster): TestType[] {
  const plan: TestType[] = [
    "axe-full", "interactive", "reflow", "text-spacing", "resize-text",
    "target-size", "non-text-contrast",
    // v4.3 — always run (zero cost)
    "meaningful-sequence", "semantic-structure",
  ];
  if (cluster.capabilities.hasMedia) plan.push("multimedia", "timed-events");
  if (cluster.capabilities.hasCarousel) plan.push("timed-events");
  if (cluster.capabilities.hasForms) plan.push("error-identification", "status-messages");
  // hover-focus and aria-states: always run (detect interactive widgets)
  plan.push("hover-focus", "aria-states");
  return [...new Set(plan)];
}
```

- [ ] **Step 6: Add category mappings**

In `src/analyzer/category.ts`, add new entries to `CATEGORY_MAP`:

```typescript
  // v4.3 — new WCAG tests
  "meaningful-sequence": "structural",
  "meaningful-sequence-reorder": "structural",
  "semantic-pseudo-heading": "semantic",
  "semantic-pseudo-list": "semantic",
  "semantic-pseudo-table": "semantic",
  "semantic-missing-fieldset": "semantic",
  "aria-state-missing": "interactive",
  "hover-focus-not-persistent": "interactive",
  "hover-focus-not-hoverable": "interactive",
  "hover-focus-not-dismissible": "interactive",
  "status-message-no-live-region": "interactive",
```

- [ ] **Step 7: Commit**

```bash
git add src/types/pipeline.ts src/types/issue.ts src/worker/db.ts src/worker/pipeline.ts src/worker/probe.ts src/analyzer/classify.ts src/analyzer/category.ts
git commit -m "feat: plumbing for v4.3 zero-cost WCAG tests (types, migration, LLMClient pass-through)"
```

---

## Task 2: WCAG 1.3.2 — Meaningful Sequence (Kendall Tau)

**Files:**
- Create: `src/analyzer/wcag-meaningful-sequence.ts`
- Create: `src/analyzer/__tests__/wcag-meaningful-sequence.test.ts`

- [ ] **Step 1: Write unit tests for Kendall tau logic**

```typescript
// src/analyzer/__tests__/wcag-meaningful-sequence.test.ts
import { test, expect } from "bun:test";
import { computeKendallTau } from "../wcag-meaningful-sequence";

test("kendall tau = 1.0 for identical order", () => {
  expect(computeKendallTau([0, 1, 2, 3])).toBe(1.0);
});

test("kendall tau = -1.0 for fully reversed order", () => {
  expect(computeKendallTau([3, 2, 1, 0])).toBe(-1.0);
});

test("kendall tau is between -1 and 1 for partial reorder", () => {
  const tau = computeKendallTau([0, 2, 1, 3]);
  expect(tau).toBeGreaterThan(-1);
  expect(tau).toBeLessThan(1);
});

test("kendall tau = 1.0 for single element", () => {
  expect(computeKendallTau([0])).toBe(1.0);
});

test("kendall tau = 1.0 for two elements in order", () => {
  expect(computeKendallTau([0, 1])).toBe(1.0);
});

test("kendall tau = -1.0 for two elements reversed", () => {
  expect(computeKendallTau([1, 0])).toBe(-1.0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/analyzer/__tests__/wcag-meaningful-sequence.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the test**

```typescript
// src/analyzer/wcag-meaningful-sequence.ts
import type { Page } from "playwright";
import type { Issue, ImpactLevel } from "../types/issue";

function makeSequenceIssue(
  url: string, rule: string, impact: ImpactLevel,
  description: string, selector: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule, impact, description,
    help: description,
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/meaningful-sequence",
    wcagTags: ["wcag132"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 0, pageTitle: "",
    checkSource: "wcag-custom",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "1.3.2",
    violationCategory: "structural",
  };
}

/**
 * Compute Kendall's tau rank correlation between DOM order [0,1,2,...,n-1]
 * and the given visual rank ordering.
 * Returns a value from -1.0 (fully reversed) to 1.0 (identical order).
 */
export function computeKendallTau(visualRanks: number[]): number {
  const n = visualRanks.length;
  if (n <= 1) return 1.0;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // DOM order: i < j always (concordant if visual[i] < visual[j])
      if (visualRanks[i] < visualRanks[j]) concordant++;
      else if (visualRanks[i] > visualRanks[j]) discordant++;
    }
  }
  const pairs = (n * (n - 1)) / 2;
  return (concordant - discordant) / pairs;
}

/**
 * WCAG 1.3.2 — Meaningful Sequence: detect when CSS flex/grid reordering
 * causes visual order to diverge significantly from DOM order.
 *
 * Uses getBoundingClientRect to determine visual positions, then computes
 * Kendall's tau correlation against DOM index order. Tau < 0.8 = significant reorder.
 */
export async function testMeaningfulSequence(page: Page, url: string): Promise<Issue[]> {
  const TAU_THRESHOLD = 0.8;

  const violations = await page.evaluate((threshold: number) => {
    const results: Array<{
      container: string;
      display: string;
      childCount: number;
      tau: number;
      domOrder: string[];
      visualOrder: string[];
    }> = [];

    document.querySelectorAll("*").forEach((el) => {
      const style = getComputedStyle(el);
      const display = style.display;
      if (!display.includes("flex") && !display.includes("grid")) return;

      const children = Array.from(el.children)
        .filter((c) => getComputedStyle(c).display !== "none");
      if (children.length < 2) return;

      // Get DOM index + visual position for each child
      const withPos = children.map((c, domIdx) => {
        const rect = c.getBoundingClientRect();
        return {
          domIdx,
          top: rect.top,
          left: rect.left,
          text: (c.textContent ?? "").trim().slice(0, 40),
        };
      });

      // Sort by visual position (reading order: top then left)
      const lineHeight = parseFloat(style.lineHeight) || 20;
      const lineTolerance = lineHeight * 0.6;
      const visualOrder = [...withPos].sort((a, b) =>
        Math.abs(a.top - b.top) < lineTolerance
          ? a.left - b.left
          : a.top - b.top,
      );

      // Build visual rank map: visualRanks[domIdx] = visual position rank
      const visualRanks: number[] = new Array(withPos.length);
      visualOrder.forEach((item, visualIdx) => {
        visualRanks[item.domIdx] = visualIdx;
      });

      // Compute Kendall's tau
      const n = visualRanks.length;
      let concordant = 0;
      let discordant = 0;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (visualRanks[i] < visualRanks[j]) concordant++;
          else if (visualRanks[i] > visualRanks[j]) discordant++;
        }
      }
      const pairs = (n * (n - 1)) / 2;
      const tau = pairs > 0 ? (concordant - discordant) / pairs : 1;

      if (tau < threshold) {
        const container =
          el.id ? `#${el.id}` :
          el.className && typeof el.className === "string"
            ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
            : el.tagName.toLowerCase();

        results.push({
          container,
          display,
          childCount: children.length,
          tau: parseFloat(tau.toFixed(2)),
          domOrder: withPos.map((p) => p.text),
          visualOrder: visualOrder.map((p) => p.text),
        });
      }
    });

    return results;
  }, TAU_THRESHOLD);

  // Also detect explicit CSS reorder signals
  const cssSignals = await page.evaluate(() => {
    const signals: Array<{ selector: string; property: string; value: string }> = [];
    document.querySelectorAll("*").forEach((el) => {
      const style = getComputedStyle(el);
      if (parseInt(style.order) !== 0 && style.order !== "0") {
        const sel = el.id ? `#${el.id}` : el.tagName.toLowerCase();
        signals.push({ selector: sel, property: "order", value: style.order });
      }
      if (style.flexDirection?.includes("reverse")) {
        const sel = el.id ? `#${el.id}` : el.tagName.toLowerCase();
        signals.push({ selector: sel, property: "flex-direction", value: style.flexDirection });
      }
    });
    return signals;
  });

  const issues: Issue[] = [];

  for (const v of violations) {
    issues.push(makeSequenceIssue(
      url,
      "meaningful-sequence-reorder",
      "serious",
      `${v.display} container "${v.container}" has visual order diverging from DOM order (Kendall tau=${v.tau}, threshold=0.8). DOM: [${v.domOrder.join(" → ")}]. Visual: [${v.visualOrder.join(" → ")}]`,
      v.container,
    ));
  }

  for (const s of cssSignals) {
    issues.push(makeSequenceIssue(
      url,
      "meaningful-sequence",
      "moderate",
      `Element "${s.selector}" uses CSS ${s.property}: ${s.value} which may alter reading order (WCAG 1.3.2)`,
      s.selector,
    ));
  }

  return issues;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/analyzer/__tests__/wcag-meaningful-sequence.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/analyzer/wcag-meaningful-sequence.ts src/analyzer/__tests__/wcag-meaningful-sequence.test.ts
git commit -m "feat: WCAG 1.3.2 meaningful sequence test (Kendall tau + CSS reorder detection)"
```

---

## Task 3: WCAG 1.3.1 — Semantic Structure Heuristics

**Files:**
- Create: `src/analyzer/wcag-semantic-structure.ts`
- Create: `src/analyzer/__tests__/wcag-semantic-structure.test.ts`

- [ ] **Step 1: Write unit test for pseudo-heading detection logic**

```typescript
// src/analyzer/__tests__/wcag-semantic-structure.test.ts
import { test, expect } from "bun:test";
import { isPseudoHeadingStyle, isPseudoListLayout } from "../wcag-semantic-structure";

test("isPseudoHeadingStyle detects large bold text", () => {
  expect(isPseudoHeadingStyle(24, 700, 30)).toBe(true);
});

test("isPseudoHeadingStyle rejects normal paragraph text", () => {
  expect(isPseudoHeadingStyle(16, 400, 200)).toBe(false);
});

test("isPseudoHeadingStyle detects 14px+ bold short text", () => {
  expect(isPseudoHeadingStyle(14, 700, 50)).toBe(true);
});

test("isPseudoHeadingStyle rejects long text even if large", () => {
  expect(isPseudoHeadingStyle(24, 700, 200)).toBe(false);
});

test("isPseudoListLayout detects uniform-height aligned siblings", () => {
  expect(isPseudoListLayout(
    [{ height: 40, left: 10 }, { height: 42, left: 10 }, { height: 41, left: 10 }],
  )).toBe(true);
});

test("isPseudoListLayout rejects varied layout", () => {
  expect(isPseudoListLayout(
    [{ height: 40, left: 10 }, { height: 100, left: 200 }, { height: 30, left: 50 }],
  )).toBe(false);
});
```

- [ ] **Step 2: Implement the test**

```typescript
// src/analyzer/wcag-semantic-structure.ts
import type { Page } from "playwright";
import type { Issue, ImpactLevel } from "../types/issue";

function makeSemanticIssue(
  url: string, rule: string, impact: ImpactLevel,
  description: string, selector: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule, impact, description,
    help: description,
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships",
    wcagTags: ["wcag131"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 0, pageTitle: "",
    checkSource: "wcag-custom",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "1.3.1",
    violationCategory: "semantic",
  };
}

/** Exported for testing: does this computed style look like a heading? */
export function isPseudoHeadingStyle(fontSize: number, fontWeight: number, textLength: number): boolean {
  if (textLength === 0 || textLength > 120) return false;
  return fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
}

/** Exported for testing: do these rects look like a list? */
export function isPseudoListLayout(rects: Array<{ height: number; left: number }>): boolean {
  if (rects.length < 3) return false;
  const heights = rects.map((r) => r.height);
  const lefts = rects.map((r) => r.left);
  const heightDelta = Math.max(...heights) - Math.min(...heights);
  const leftDelta = Math.max(...lefts) - Math.min(...lefts);
  return heightDelta < 8 && leftDelta < 4;
}

/**
 * WCAG 1.3.1 — Info and Relationships: detect visual structures that lack
 * proper HTML semantic markup (pseudo-headings, pseudo-lists, missing fieldsets).
 */
export async function testSemanticStructure(page: Page, url: string): Promise<Issue[]> {
  const findings = await page.evaluate(() => {
    const results: Array<{ type: string; selector: string; detail: string }> = [];

    // --- Pseudo-heading detection ---
    document.querySelectorAll("div, p, span").forEach((el) => {
      const cs = getComputedStyle(el);
      const fontSize = parseFloat(cs.fontSize);
      const fontWeight = parseFloat(cs.fontWeight) || (cs.fontWeight === "bold" ? 700 : 400);
      const text = el.textContent?.trim() ?? "";
      const textLength = text.length;

      if (textLength === 0 || textLength > 120) return;
      const isHeadingStyle = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
      if (!isHeadingStyle) return;

      // Not already inside a heading
      if (el.closest("h1,h2,h3,h4,h5,h6,[role='heading']")) return;
      // Not a link or button (they have their own semantics)
      if (el.closest("a,button")) return;

      const selector =
        el.id ? `#${el.id}` :
        el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : el.tagName.toLowerCase();

      results.push({
        type: "pseudo-heading",
        selector,
        detail: `"${text.slice(0, 60)}" (${fontSize}px, weight ${fontWeight})`,
      });
    });

    // --- Pseudo-list detection ---
    document.querySelectorAll("div, section, main, article").forEach((container) => {
      const children = Array.from(container.children)
        .filter((c) => {
          const tag = c.tagName;
          return !["UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "SCRIPT", "STYLE"].includes(tag)
            && getComputedStyle(c).display !== "none";
        });
      if (children.length < 3) return;
      // Already a list
      if (container.tagName === "UL" || container.tagName === "OL") return;

      const rects = children.map((c) => c.getBoundingClientRect());
      const heights = rects.map((r) => r.height);
      const lefts = rects.map((r) => r.left);
      const heightDelta = Math.max(...heights) - Math.min(...heights);
      const leftDelta = Math.max(...lefts) - Math.min(...lefts);

      if (heightDelta >= 8 || leftDelta >= 4) return;

      // Check repeating tag structure
      const tagPatterns = children.map((c) =>
        Array.from(c.children).map((gc) => gc.tagName).join(","),
      );
      const uniquePatterns = new Set(tagPatterns);
      if (uniquePatterns.size > 2) return; // too varied

      const selector =
        container.id ? `#${container.id}` :
        container.className && typeof container.className === "string"
          ? `${container.tagName.toLowerCase()}.${container.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : container.tagName.toLowerCase();

      results.push({
        type: "pseudo-list",
        selector,
        detail: `${children.length} uniform siblings that look like a list but use <${container.tagName.toLowerCase()}>`,
      });
    });

    // --- Missing fieldset detection ---
    document.querySelectorAll("form, [role='form']").forEach((form) => {
      const inputs = form.querySelectorAll("input, select, textarea");
      if (inputs.length < 4) return;

      // Group by parent container
      const groups = new Map<string, Element[]>();
      inputs.forEach((input) => {
        const parent = input.parentElement;
        if (!parent) return;
        const key = parent.className || parent.id || parent.tagName;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(input);
      });

      for (const [, groupInputs] of groups) {
        if (groupInputs.length < 2) continue;
        const parent = groupInputs[0].parentElement;
        if (!parent) continue;
        if (parent.tagName === "FIELDSET") continue;
        if (parent.getAttribute("role") === "group") continue;
        if (parent.hasAttribute("aria-labelledby")) continue;

        const selector =
          parent.id ? `#${parent.id}` :
          parent.className && typeof parent.className === "string"
            ? `${parent.tagName.toLowerCase()}.${parent.className.trim().split(/\s+/).slice(0, 3).join(".")}`
            : parent.tagName.toLowerCase();

        results.push({
          type: "missing-fieldset",
          selector,
          detail: `${groupInputs.length} related form fields without <fieldset> or role="group"`,
        });
      }
    });

    return results;
  });

  return findings.map((f) => {
    switch (f.type) {
      case "pseudo-heading":
        return makeSemanticIssue(url, "semantic-pseudo-heading", "moderate",
          `Element "${f.selector}" looks like a heading but uses non-heading markup: ${f.detail}`, f.selector);
      case "pseudo-list":
        return makeSemanticIssue(url, "semantic-pseudo-list", "moderate",
          `Container "${f.selector}" contains ${f.detail}`, f.selector);
      case "missing-fieldset":
        return makeSemanticIssue(url, "semantic-missing-fieldset", "moderate",
          `${f.detail} in "${f.selector}"`, f.selector);
      default:
        return makeSemanticIssue(url, "semantic-structure", "moderate", f.detail, f.selector);
    }
  });
}
```

- [ ] **Step 3: Run tests**

Run: `bun test src/analyzer/__tests__/wcag-semantic-structure.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/analyzer/wcag-semantic-structure.ts src/analyzer/__tests__/wcag-semantic-structure.test.ts
git commit -m "feat: WCAG 1.3.1 semantic structure heuristics (pseudo-heading, pseudo-list, missing fieldset)"
```

---

## Task 4: WCAG 4.1.2 — Dynamic ARIA State Verification

**Files:**
- Create: `src/analyzer/wcag-aria-states.ts`

- [ ] **Step 1: Implement the test**

```typescript
// src/analyzer/wcag-aria-states.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";

function makeAriaIssue(
  url: string, description: string, selector: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule: "aria-state-missing",
    impact: "serious", description,
    help: "Interactive widgets must update ARIA states (aria-expanded, aria-selected, aria-pressed) on interaction.",
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value",
    wcagTags: ["wcag412"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 1280, pageTitle: "",
    checkSource: "interactive",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "4.1.2",
    violationCategory: "interactive",
  };
}

/**
 * WCAG 4.1.2 — Name, Role, Value (dynamic states):
 * Verify that interactive widgets update ARIA states after interaction.
 *
 * Finds elements with aria-haspopup or aria-expanded and clicks them,
 * then verifies aria-expanded changes and controlled element becomes visible.
 */
export async function testAriaStates(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Find expandable triggers
  const triggers = await page.evaluate(() => {
    const results: Array<{
      selector: string;
      text: string;
      hasAriaExpanded: boolean;
      initialExpanded: string | null;
      ariaControls: string | null;
    }> = [];

    document.querySelectorAll(
      "[aria-haspopup], [aria-expanded], button[aria-controls], [role='tab']",
    ).forEach((el) => {
      // Skip native <details>/<summary>
      if (el.closest("details")) return;

      const selector =
        el.id ? `#${el.id}` :
        el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : el.tagName.toLowerCase();

      results.push({
        selector,
        text: (el.textContent ?? "").trim().slice(0, 30),
        hasAriaExpanded: el.hasAttribute("aria-expanded"),
        initialExpanded: el.getAttribute("aria-expanded"),
        ariaControls: el.getAttribute("aria-controls"),
      });
    });

    return results.slice(0, 10); // limit to 10 to avoid excessive interaction
  });

  for (const trigger of triggers) {
    try {
      const handle = await page.$(trigger.selector);
      if (!handle) continue;

      // Record initial state
      const before = await handle.evaluate((el) => ({
        expanded: el.getAttribute("aria-expanded"),
        pressed: el.getAttribute("aria-pressed"),
        selected: el.getAttribute("aria-selected"),
      }));

      // Click
      const urlBefore = page.url();
      await handle.click();
      await page.waitForTimeout(500);

      // If navigated, go back and skip
      if (page.url() !== urlBefore) {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
        continue;
      }

      // Record after state
      const after = await handle.evaluate((el) => ({
        expanded: el.getAttribute("aria-expanded"),
        pressed: el.getAttribute("aria-pressed"),
        selected: el.getAttribute("aria-selected"),
      })).catch(() => before);

      // Check: has aria-haspopup but no aria-expanded at all
      if (!trigger.hasAriaExpanded) {
        // Check if something visual appeared (a menu, dropdown, etc.)
        const contentAppeared = await handle.evaluate((el) => {
          const next = el.nextElementSibling;
          if (next && getComputedStyle(next).display !== "none") return true;
          const controlsId = el.getAttribute("aria-controls");
          if (controlsId) {
            const target = document.getElementById(controlsId);
            if (target && getComputedStyle(target).display !== "none") return true;
          }
          return false;
        }).catch(() => false);

        if (contentAppeared) {
          issues.push(makeAriaIssue(url,
            `Widget "${trigger.text}" (${trigger.selector}) opens content but lacks aria-expanded attribute`,
            trigger.selector));
        }
      }
      // Check: has aria-expanded but it didn't toggle
      else if (before.expanded === after.expanded && before.expanded !== null) {
        issues.push(makeAriaIssue(url,
          `Widget "${trigger.text}" (${trigger.selector}) has aria-expanded="${before.expanded}" but it did not change after click`,
          trigger.selector));
      }

      // Reset: click again to close
      try {
        await handle.click();
        await page.waitForTimeout(300);
      } catch { /* ignore */ }

    } catch {
      // Interaction failed — skip
    }
  }

  return issues;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/analyzer/wcag-aria-states.ts
git commit -m "feat: WCAG 4.1.2 dynamic ARIA state verification on interactive widgets"
```

---

## Task 5: WCAG 4.1.3 — Status Messages (Live Regions)

**Files:**
- Create: `src/analyzer/wcag-status-messages.ts`

- [ ] **Step 1: Implement the test**

```typescript
// src/analyzer/wcag-status-messages.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";

function makeStatusIssue(
  url: string, description: string, selector: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule: "status-message-no-live-region",
    impact: "serious", description,
    help: "Status messages must be programmatically determinable via role or properties (role='alert', role='status', aria-live).",
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/status-messages",
    wcagTags: ["wcag413"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 1280, pageTitle: "",
    checkSource: "wcag-custom",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "4.1.3",
    violationCategory: "interactive",
  };
}

/**
 * WCAG 4.1.3 — Status Messages: after triggering form validation,
 * check that dynamically appearing messages use live regions
 * (role="alert", role="status", or aria-live).
 *
 * Uses checkValidity() (safe, no real submit) + MutationObserver to detect
 * new visible text that lacks live region markup.
 */
export async function testStatusMessages(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const forms = await page.$$("form");

  for (const form of forms) {
    const requiredFields = await form.$$('[required], [aria-required="true"]');
    if (requiredFields.length === 0) continue;

    // Inject MutationObserver before triggering validation
    await page.evaluate(() => {
      (window as any).__statusMsgLog = [];

      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          // New elements
          for (const node of m.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const el = node as Element;
            const text = el.textContent?.trim();
            if (!text || text.length < 3) continue;
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") continue;

            (window as any).__statusMsgLog.push({
              text: text.slice(0, 100),
              role: el.getAttribute("role"),
              ariaLive: el.getAttribute("aria-live"),
              tag: el.tagName,
              className: el.className,
              hasLiveRegion: !!(
                el.getAttribute("role") === "alert" ||
                el.getAttribute("role") === "status" ||
                el.getAttribute("aria-live") ||
                el.closest("[role='alert'], [role='status'], [aria-live]")
              ),
            });
          }
          // Attribute changes making elements visible
          if (m.type === "attributes" && m.target.nodeType === Node.ELEMENT_NODE) {
            const el = m.target as Element;
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") continue;
            const text = el.textContent?.trim();
            if (!text || text.length < 3) continue;

            (window as any).__statusMsgLog.push({
              text: text.slice(0, 100),
              role: el.getAttribute("role"),
              ariaLive: el.getAttribute("aria-live"),
              tag: el.tagName,
              className: el.className,
              hasLiveRegion: !!(
                el.getAttribute("role") === "alert" ||
                el.getAttribute("role") === "status" ||
                el.getAttribute("aria-live") ||
                el.closest("[role='alert'], [role='status'], [aria-live]")
              ),
            });
          }
        }
      });

      obs.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ["style", "class", "hidden", "aria-hidden"],
      });
      (window as any).__statusMsgObs = obs;
    });

    // Trigger validation via checkValidity (safe, no submit)
    await form.evaluate((f) => {
      for (const el of f.elements) {
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
          el.checkValidity();
        }
      }
      // Also try reportValidity to trigger browser's built-in validation UI
      f.reportValidity();
    });

    await page.waitForTimeout(500);

    // Collect results
    const messages: Array<{
      text: string;
      role: string | null;
      ariaLive: string | null;
      tag: string;
      className: string;
      hasLiveRegion: boolean;
    }> = await page.evaluate(() => {
      const log = (window as any).__statusMsgLog ?? [];
      // Disconnect observer
      (window as any).__statusMsgObs?.disconnect();
      return log;
    });

    const formSelector = await form.evaluate((f) => {
      const action = f.getAttribute("action") || "self";
      return `form[action="${action}"]`;
    });

    // Flag messages that appeared without live region
    for (const msg of messages) {
      if (!msg.hasLiveRegion) {
        issues.push(makeStatusIssue(url,
          `Status message "${msg.text}" appeared after form validation but lacks role="alert", role="status", or aria-live attribute`,
          formSelector));
      }
    }
  }

  return issues;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/analyzer/wcag-status-messages.ts
git commit -m "feat: WCAG 4.1.3 status messages — verify live regions after form validation"
```

---

## Task 6: WCAG 1.4.13 — Content on Hover or Focus

**Files:**
- Create: `src/analyzer/wcag-hover-focus.ts`

- [ ] **Step 1: Implement the test**

```typescript
// src/analyzer/wcag-hover-focus.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";

function makeHoverIssue(
  url: string, rule: string, description: string, selector: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule,
    impact: "serious", description,
    help: "Content that appears on hover/focus must be persistent, hoverable, and dismissible.",
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus",
    wcagTags: ["wcag1413"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 1280, pageTitle: "",
    checkSource: "interactive",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "1.4.13",
    violationCategory: "interactive",
  };
}

/**
 * WCAG 1.4.13 — Content on Hover or Focus:
 * Test that tooltip/popover content triggered by hover is:
 * 1. PERSISTENT — stays visible while hover/focus is maintained
 * 2. HOVERABLE — pointer can move to the popup without it disappearing
 * 3. DISMISSIBLE — can be closed without moving pointer (Escape key)
 *
 * Exception: native `title` attribute tooltips are exempt (user-agent controlled).
 */
export async function testHoverFocus(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Discover trigger candidates
  const triggers = await page.evaluate(() => {
    const results: Array<{
      selector: string;
      text: string;
      isNativeTitle: boolean;
    }> = [];

    // Explicit tooltip triggers (testable)
    document.querySelectorAll(
      "[aria-describedby], [data-tooltip], [data-tippy-content], [data-popover], [aria-haspopup='dialog']",
    ).forEach((el) => {
      const selector =
        el.id ? `#${el.id}` :
        el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : el.tagName.toLowerCase();

      results.push({
        selector,
        text: (el.textContent ?? "").trim().slice(0, 30),
        isNativeTitle: false,
      });
    });

    return results.slice(0, 8); // limit interactions
  });

  for (const trigger of triggers) {
    if (trigger.isNativeTitle) continue; // exempt

    try {
      const handle = await page.$(trigger.selector);
      if (!handle) continue;

      // Inject MutationObserver to detect appearing content
      await page.evaluate(() => {
        (window as any).__hoverPopup = null;
        const obs = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              const el = node as Element;
              const role = el.getAttribute("role");
              if (role === "tooltip" || role === "dialog" ||
                  el.classList.contains("tooltip") ||
                  el.classList.contains("popover") ||
                  el.classList.contains("tippy-box")) {
                (window as any).__hoverPopup = {
                  selector: el.id ? `#${el.id}` : `.${el.className?.split(" ")[0] ?? "unknown"}`,
                  found: true,
                };
              }
            }
            // Also check visibility changes
            if (m.type === "attributes" && m.target.nodeType === Node.ELEMENT_NODE) {
              const el = m.target as Element;
              const role = el.getAttribute("role");
              if (role === "tooltip" && getComputedStyle(el).display !== "none") {
                (window as any).__hoverPopup = {
                  selector: el.id ? `#${el.id}` : `[role="tooltip"]`,
                  found: true,
                };
              }
            }
          }
        });
        obs.observe(document.body, {
          childList: true, subtree: true,
          attributes: true, attributeFilter: ["style", "class", "aria-hidden", "hidden"],
        });
        (window as any).__hoverObs = obs;
      });

      // Hover to trigger
      await handle.hover();
      await page.waitForTimeout(500);

      const popup = await page.evaluate(() => {
        (window as any).__hoverObs?.disconnect();
        return (window as any).__hoverPopup;
      });

      if (!popup?.found) continue; // no popup appeared — nothing to test

      const popupSelector = popup.selector;

      // --- TEST 1: PERSISTENT ---
      // Re-hover trigger, wait 3 seconds, check if popup still visible
      await handle.hover();
      await page.waitForTimeout(3000);
      const stillVisible = await page.$(popupSelector)
        .then((el) => el?.isVisible() ?? false)
        .catch(() => false);

      if (!stillVisible) {
        issues.push(makeHoverIssue(url, "hover-focus-not-persistent",
          `Tooltip/popup triggered by "${trigger.text}" (${trigger.selector}) auto-closes before user dismisses it`,
          trigger.selector));
        continue; // can't test hoverable/dismissible if popup already gone
      }

      // --- TEST 2: HOVERABLE ---
      // Move pointer from trigger to popup
      try {
        const popupEl = await page.$(popupSelector);
        if (popupEl) {
          await popupEl.hover();
          await page.waitForTimeout(300);
          const popupStillVisible = await popupEl.isVisible();
          if (!popupStillVisible) {
            issues.push(makeHoverIssue(url, "hover-focus-not-hoverable",
              `Tooltip/popup triggered by "${trigger.text}" disappears when pointer moves to it (not hoverable)`,
              trigger.selector));
          }
        }
      } catch {
        // popup might have disappeared — flag as not hoverable
        issues.push(makeHoverIssue(url, "hover-focus-not-hoverable",
          `Tooltip/popup triggered by "${trigger.text}" disappears when pointer moves away from trigger`,
          trigger.selector));
      }

      // --- TEST 3: DISMISSIBLE ---
      // Re-hover trigger, then press Escape
      await handle.hover();
      await page.waitForTimeout(500);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const dismissedVisible = await page.$(popupSelector)
        .then((el) => el?.isVisible() ?? false)
        .catch(() => false);

      if (dismissedVisible) {
        // Check exemption: does popup overlap other content?
        const overlaps = await page.evaluate((sel) => {
          const popup = document.querySelector(sel);
          if (!popup) return false;
          const rect = popup.getBoundingClientRect();
          const elements = document.elementsFromPoint(
            rect.x + rect.width / 2, rect.y + rect.height / 2,
          );
          return elements.some((el) =>
            el !== popup && !popup.contains(el) && (el.textContent?.trim().length ?? 0) > 0,
          );
        }, popupSelector);

        if (overlaps) {
          issues.push(makeHoverIssue(url, "hover-focus-not-dismissible",
            `Tooltip/popup triggered by "${trigger.text}" cannot be dismissed with Escape key`,
            trigger.selector));
        }
        // If no overlap, dismissibility is not required per WCAG 1.4.13
      }

    } catch {
      // Interaction sequence failed — skip this trigger
    }
  }

  return issues;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/analyzer/wcag-hover-focus.ts
git commit -m "feat: WCAG 1.4.13 hover/focus content — persistent, hoverable, dismissible state machine"
```

---

## Task 7: Wire Everything Into Probe Phase

**Files:**
- Modify: `src/worker/probe.ts`

- [ ] **Step 1: Add imports**

At top of `probe.ts`, add:

```typescript
import { testMeaningfulSequence } from "../analyzer/wcag-meaningful-sequence";
import { testSemanticStructure } from "../analyzer/wcag-semantic-structure";
import { testAriaStates } from "../analyzer/wcag-aria-states";
import { testStatusMessages } from "../analyzer/wcag-status-messages";
import { testHoverFocus } from "../analyzer/wcag-hover-focus";
```

- [ ] **Step 2: Add new rules to TEMPLATE_LEVEL_RULES**

Add to the `TEMPLATE_LEVEL_RULES` set:

```typescript
const TEMPLATE_LEVEL_RULES = new Set([
  "color-contrast", "color-contrast-enhanced", "heading-order",
  "landmark-one-main", "region", "bypass", "html-has-lang",
  "html-lang-valid", "page-has-heading-one", "tabindex",
  "reflow", "text-spacing", "resize-text", "non-text-contrast",
  "focus-order", "focus-visible", "keyboard-trap", "skip-nav",
  "target-size",
  // v4.3
  "meaningful-sequence", "meaningful-sequence-reorder",
  "semantic-pseudo-heading", "semantic-pseudo-list", "semantic-missing-fieldset",
  "aria-state-missing",
  "hover-focus-not-persistent", "hover-focus-not-hoverable", "hover-focus-not-dismissible",
  "status-message-no-live-region",
]);
```

- [ ] **Step 3: Add test execution in probe phase**

In the parallel evaluate block (after `non-text-contrast`), add:

```typescript
          if (cluster.testPlan.includes("meaningful-sequence")) evaluateTests.push(testMeaningfulSequence(page, url));
          if (cluster.testPlan.includes("semantic-structure")) evaluateTests.push(testSemanticStructure(page, url));
```

After the interactive tests block, add:

```typescript
          // 3.5. New interactive tests (interaction + observation)
          if (cluster.testPlan.includes("aria-states")) {
            allIssues.push(...await testAriaStates(page, url));
          }
          if (cluster.testPlan.includes("hover-focus")) {
            allIssues.push(...await testHoverFocus(page, url));
          }
          if (cluster.testPlan.includes("status-messages")) {
            allIssues.push(...await testStatusMessages(page, url));
          }
```

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: ALL PASS (230+ tests)

- [ ] **Step 5: Commit**

```bash
git add src/worker/probe.ts
git commit -m "feat: wire 5 new zero-cost WCAG tests into probe phase"
```

---

## Task 8: Integration Smoke Test

- [ ] **Step 1: Start dev environment**

```bash
docker start a11y-postgres a11y-browserless-dev
bash dev.sh
```

- [ ] **Step 2: Run an audit via the dashboard**

Navigate to `http://localhost:5173`, submit an audit for a test site (e.g., `https://example-client.com/`).

- [ ] **Step 3: Verify new issue types appear**

Query the database for new rule names:

```bash
bun -e "
import postgres from 'postgres';
const sql = postgres('postgresql://postgres:dev@localhost:5433/a11y');
const rows = await sql\`
  SELECT rule, check_source, count(*)::int as cnt
  FROM issues
  WHERE rule IN ('meaningful-sequence', 'meaningful-sequence-reorder',
    'semantic-pseudo-heading', 'semantic-pseudo-list', 'semantic-missing-fieldset',
    'aria-state-missing', 'hover-focus-not-persistent', 'hover-focus-not-hoverable',
    'hover-focus-not-dismissible', 'status-message-no-live-region')
  GROUP BY rule, check_source
  ORDER BY cnt DESC
\`;
console.log(rows);
await sql.end();
"
```

Expected: At least some of the new rules appear with `check_source: "wcag-custom"` or `"interactive"`.

- [ ] **Step 4: Final commit with plan doc**

```bash
git add docs/plans/2026-03-18-zero-cost-wcag-tests.md
git commit -m "docs: implementation plan for v4.3 zero-cost WCAG tests"
```

---

## Summary

| Task | WCAG | Rule(s) | Test Type | Commit |
|---|---|---|---|---|
| 1 | — | — | Plumbing | `feat: plumbing for v4.3` |
| 2 | 1.3.2 | meaningful-sequence, meaningful-sequence-reorder | evaluate (parallel) | `feat: WCAG 1.3.2 meaningful sequence` |
| 3 | 1.3.1 | semantic-pseudo-heading, semantic-pseudo-list, semantic-missing-fieldset | evaluate (parallel) | `feat: WCAG 1.3.1 semantic structure` |
| 4 | 4.1.2 | aria-state-missing | interaction (sequential) | `feat: WCAG 4.1.2 dynamic ARIA states` |
| 5 | 4.1.3 | status-message-no-live-region | interaction (sequential) | `feat: WCAG 4.1.3 status messages` |
| 6 | 1.4.13 | hover-focus-not-persistent/hoverable/dismissible | interaction (sequential) | `feat: WCAG 1.4.13 hover/focus` |
| 7 | — | — | Wiring | `feat: wire 5 new tests into probe` |
| 8 | — | — | Smoke test | `docs: implementation plan` |

Total: 8 tasks, 8 commits, 5 new WCAG criteria covered, 11 new rule names.
