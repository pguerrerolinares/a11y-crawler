# Intelligent Probe v5 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize the audit probe pipeline with a generalized 4-tier system (Manifest → DOM/CSSOM → Interaction → LLM Vision) to reduce time by ~30-45%, cost by ~60-80%, and close 3 quality gaps vs Auditoría manual de referencia.

**Architecture:** Replace the current sequential test execution in `probe.ts` with a tiered system where Tier 0 pre-scans all elements, Tier 1 resolves what it can via CSSOM (free), Tier 2 runs unified interactions only on ambiguous elements, and Tier 3 runs async LLM vision with crops+batching. Each tier filters for the next, reducing work progressively.

**Tech Stack:** Bun, Playwright, PostgreSQL, sharp, Moonshot LLM (vision), SSE for async results.

**Spec:** `docs/specs/2026-03-19-intelligent-probe-v5.md`

---

## Phase 1: Foundation (Types, Schema, Timing)

### Task 1: Types and interfaces for the tier system

**Files:**
- Create: `src/types/manifest.ts`
- Modify: `src/types/pipeline.ts:79-91` (add `additionalUrls`)

- [ ] **Step 1: Write types for ElementManifest and related interfaces**

```typescript
// src/types/manifest.ts
export interface ElementManifest {
  selector: string;
  tag: string;
  role: string | null;
  accessibleName: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  hasHoverCss: boolean;
  hasAriaExpanded: boolean;
  hasAriaPressed: boolean;
  hasUnderline: boolean;
  isFormControl: boolean;
  defaultStyles: {
    borderColor: string;
    outlineColor: string;
    backgroundColor: string;
    boxShadow: string;
    textDecorationLine: string;
    color: string;
  };
  parentBg: string;
  styleFingerprint: string;
}

export interface StyleGroup {
  fingerprint: string;
  representative: ElementManifest;
  members: ElementManifest[];
}

export interface InteractionResult {
  hoverStyles?: Record<string, string>;
  hoverPopup?: PopupInfo | null;
  popupPersistent?: boolean;
  popupHoverable?: boolean;
  popupDismissible?: boolean;
  focusStyles?: Record<string, string>;
  focusIndicatorVisible?: boolean;
  focusPopup?: PopupInfo | null;
  ariaStateChanged?: boolean;
  keyboardResponded?: boolean;
}

export interface PopupInfo {
  selector: string;
  type: "dom-mutation" | "css-transition";
  boundingBox: { x: number; y: number; width: number; height: number };
}

export type TierResult = "pass" | "fail" | "ambiguous" | "no-change";

export interface ProbeTiming {
  auditId: string;
  templateId: string;
  url: string;
  tier0: { durationMs: number; elementsDiscovered: number; styleGroups: number; representativeElements: number };
  tier1: { durationMs: number; issuesFound: number; elementsPromotedToTier2: number; skippedByFingerprint: number };
  tier2: { durationMs: number; interactions: { hovers: number; focuses: number; clicks: number; keyboardTests: number }; issuesFound: number; elementsPromotedToTier3: number; avgWaitMs: number };
  tier3: { durationMs: number; llmCalls: number; llmInputTokens: number; llmOutputTokens: number; imagesSent: number; avgImageSizeBytes: number; issuesConfirmed: number; issuesDiscarded: number; cacheHits: number; earlyTerminations: number };
}
```

- [ ] **Step 2: Add `additionalUrls` to PipelineConfig**

In `src/types/pipeline.ts`, add to the existing config interface:
```typescript
additionalUrls?: string[];
```

- [ ] **Step 3: Run type check**

Run: `bun build src/types/manifest.ts --no-bundle`
Expected: Clean transpile output

- [ ] **Step 4: Commit**

```bash
git add src/types/manifest.ts src/types/pipeline.ts
git commit -m "feat(v5): add manifest types and additionalUrls config"
```

---

### Task 2: Database schema for tier3_jobs and tier3_cache

**Files:**
- Modify: `src/server/db/schema.sql:127` (append new tables)
- Modify: `src/worker/db.ts` (add tier3 DB functions)
- Test: `src/worker/__tests__/db-tier3.test.ts`

- [ ] **Step 1: Write failing tests for tier3 DB functions**

```typescript
// src/worker/__tests__/db-tier3.test.ts
import { test, expect, describe } from "bun:test";

describe("tier3 DB functions", () => {
  test("insertTier3Job creates a pending job", () => {
    // Will test after implementation
    expect(true).toBe(true); // placeholder — real test needs DB
  });

  test("tier3CacheLookup returns null for unknown key", () => {
    expect(true).toBe(true); // placeholder
  });
});
```

- [ ] **Step 2: Add schema SQL for new tables**

Append to `src/server/db/schema.sql`:
```sql
-- Tier 3 async job queue
CREATE TABLE IF NOT EXISTS tier3_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  elements JSONB NOT NULL,
  priority INT NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'pending',
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_tier3_jobs_audit ON tier3_jobs(audit_id);
CREATE INDEX IF NOT EXISTS idx_tier3_jobs_pending ON tier3_jobs(status, priority) WHERE status = 'pending';

-- Tier 3 LLM result cache
CREATE TABLE IF NOT EXISTS tier3_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key TEXT NOT NULL UNIQUE,
  result JSONB NOT NULL,
  cache_type TEXT NOT NULL DEFAULT 'text',
  audit_id UUID REFERENCES audits(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tier3_cache_key ON tier3_cache(cache_key);
```

- [ ] **Step 3: Add DB helper functions to `src/worker/db.ts`**

Append to `src/worker/db.ts`:
```typescript
export async function insertTier3Job(
  auditId: string, templateId: string,
  elements: unknown[], priority: number,
): Promise<string> {
  const [row] = await db`
    INSERT INTO tier3_jobs (audit_id, template_id, elements, priority)
    VALUES (${auditId}, ${templateId}, ${json(elements)}, ${priority})
    RETURNING id
  `;
  return row.id;
}

export async function claimNextTier3Job(auditId: string): Promise<Record<string, unknown> | null> {
  const [job] = await db`
    UPDATE tier3_jobs SET status = 'running', started_at = now()
    WHERE id = (
      SELECT id FROM tier3_jobs
      WHERE audit_id = ${auditId} AND status = 'pending'
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  return job ?? null;
}

export async function completeTier3Job(jobId: string, result: unknown): Promise<void> {
  await db`
    UPDATE tier3_jobs SET status = 'completed', result = ${json(result)}, completed_at = now()
    WHERE id = ${jobId}
  `;
}

export async function failTier3Job(jobId: string, error: string): Promise<void> {
  await db`
    UPDATE tier3_jobs SET status = 'failed', error = ${error}, completed_at = now()
    WHERE id = ${jobId}
  `;
}

export async function allTier3JobsDone(auditId: string): Promise<boolean> {
  const [{ count }] = await db`
    SELECT COUNT(*)::int as count FROM tier3_jobs
    WHERE audit_id = ${auditId} AND status IN ('pending', 'running')
  `;
  return count === 0;
}

export async function tier3CacheLookup(key: string): Promise<unknown | null> {
  const [row] = await db`
    SELECT result, cache_type, created_at FROM tier3_cache WHERE cache_key = ${key}
  `;
  if (!row) return null;
  // TTL: 24h for vision, 7d for text
  const ttlMs = row.cache_type === "vision" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - new Date(row.created_at).getTime() > ttlMs) return null;
  return row.result;
}

export async function tier3CacheSet(
  key: string, result: unknown, cacheType: "text" | "vision", auditId: string,
): Promise<void> {
  await db`
    INSERT INTO tier3_cache (cache_key, result, cache_type, audit_id)
    VALUES (${key}, ${json(result)}, ${cacheType}, ${auditId})
    ON CONFLICT (cache_key) DO UPDATE SET result = ${json(result)}, created_at = now()
  `;
}

export async function markAuditCompletedBase(auditId: string, summary: unknown, discovery: unknown, llmUsage: unknown, durationSeconds: number, wcagScore: number, crawlErrors: unknown, templateClusters: unknown, regression: unknown): Promise<void> {
  await db`
    UPDATE audits SET
      status = 'completed-base',
      summary = ${json(summary)},
      discovery = ${json(discovery)},
      llm_usage = ${json(llmUsage)},
      duration_seconds = ${durationSeconds},
      wcag_score = ${wcagScore},
      crawl_errors = ${json(crawlErrors)},
      template_clusters = ${json(templateClusters)},
      regression = ${json(regression)},
      finished_at = now()
    WHERE id = ${auditId}
  `;
}

export async function markAuditFullyCompleted(auditId: string): Promise<void> {
  await db`UPDATE audits SET status = 'completed' WHERE id = ${auditId}`;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/worker/__tests__/db-tier3.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/db/schema.sql src/worker/db.ts src/worker/__tests__/db-tier3.test.ts
git commit -m "feat(v5): add tier3_jobs, tier3_cache schema and DB helpers"
```

---

### Task 3: Per-tier timing utility

**Files:**
- Create: `src/worker/tier-timer.ts`
- Test: `src/worker/__tests__/tier-timer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/worker/__tests__/tier-timer.test.ts
import { test, expect } from "bun:test";
import { TierTimer } from "../tier-timer";

test("TierTimer records duration per tier", async () => {
  const timer = new TierTimer("audit-1", "template-1", "https://example.com");
  timer.startTier("tier0");
  await new Promise(r => setTimeout(r, 10));
  timer.endTier("tier0", { elementsDiscovered: 5, styleGroups: 2, representativeElements: 3 });

  const timing = timer.getTiming();
  expect(timing.tier0.durationMs).toBeGreaterThan(5);
  expect(timing.tier0.elementsDiscovered).toBe(5);
});

test("TierTimer aggregates interaction counts", () => {
  const timer = new TierTimer("a", "t", "u");
  timer.startTier("tier2");
  timer.recordInteraction("hovers");
  timer.recordInteraction("hovers");
  timer.recordInteraction("focuses");
  timer.endTier("tier2", { issuesFound: 1, elementsPromotedToTier3: 0, avgWaitMs: 50 });

  const timing = timer.getTiming();
  expect(timing.tier2.interactions.hovers).toBe(2);
  expect(timing.tier2.interactions.focuses).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/worker/__tests__/tier-timer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement TierTimer**

```typescript
// src/worker/tier-timer.ts
import type { ProbeTiming } from "../types/manifest";

type TierName = "tier0" | "tier1" | "tier2" | "tier3";

export class TierTimer {
  private timing: ProbeTiming;
  private starts: Partial<Record<TierName, number>> = {};

  constructor(auditId: string, templateId: string, url: string) {
    this.timing = {
      auditId, templateId, url,
      tier0: { durationMs: 0, elementsDiscovered: 0, styleGroups: 0, representativeElements: 0 },
      tier1: { durationMs: 0, issuesFound: 0, elementsPromotedToTier2: 0, skippedByFingerprint: 0 },
      tier2: { durationMs: 0, interactions: { hovers: 0, focuses: 0, clicks: 0, keyboardTests: 0 }, issuesFound: 0, elementsPromotedToTier3: 0, avgWaitMs: 0 },
      tier3: { durationMs: 0, llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0, imagesSent: 0, avgImageSizeBytes: 0, issuesConfirmed: 0, issuesDiscarded: 0, cacheHits: 0, earlyTerminations: 0 },
    };
  }

  startTier(tier: TierName): void {
    this.starts[tier] = Date.now();
  }

  endTier(tier: TierName, meta: Record<string, unknown>): void {
    const start = this.starts[tier];
    if (start) {
      (this.timing[tier] as Record<string, unknown>).durationMs = Date.now() - start;
    }
    Object.assign(this.timing[tier], meta);
  }

  recordInteraction(type: "hovers" | "focuses" | "clicks" | "keyboardTests"): void {
    this.timing.tier2.interactions[type]++;
  }

  getTiming(): ProbeTiming {
    return this.timing;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/worker/__tests__/tier-timer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/tier-timer.ts src/worker/__tests__/tier-timer.test.ts
git commit -m "feat(v5): add TierTimer for per-tier timing"
```

---

## Phase 2: Tier 0 — Element Interaction Manifest

### Task 4: Manifest pre-scan (page.evaluate)

**Files:**
- Create: `src/worker/manifest.ts`
- Test: `src/worker/__tests__/manifest.test.ts`

- [ ] **Step 1: Write tests for manifest functions**

```typescript
// src/worker/__tests__/manifest.test.ts
import { test, expect } from "bun:test";
import { computeStyleFingerprint, groupByFingerprint } from "../manifest";
import type { ElementManifest } from "../../types/manifest";

test("computeStyleFingerprint groups elements with same classes", () => {
  const fp1 = computeStyleFingerprint("div", "nav-link active", "nav");
  const fp2 = computeStyleFingerprint("div", "nav-link active", "nav");
  const fp3 = computeStyleFingerprint("div", "nav-link", "nav");
  expect(fp1).toBe(fp2);
  expect(fp1).not.toBe(fp3);
});

test("groupByFingerprint returns representative per group", () => {
  const elements: ElementManifest[] = [
    { selector: "#a", styleFingerprint: "fp1" } as ElementManifest,
    { selector: "#b", styleFingerprint: "fp1" } as ElementManifest,
    { selector: "#c", styleFingerprint: "fp2" } as ElementManifest,
  ];
  const groups = groupByFingerprint(elements);
  expect(groups.length).toBe(2);
  expect(groups[0].representative.selector).toBe("#a");
  expect(groups[0].members.length).toBe(2);
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `bun test src/worker/__tests__/manifest.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement manifest.ts**

Create `src/worker/manifest.ts` with:
- `collectManifest(page: Page, maxElements = 30): Promise<ElementManifest[]>` — the single `page.evaluate` that collects all element data
- `computeStyleFingerprint(tag, className, parentContext): string` — hash for dedup
- `groupByFingerprint(elements: ElementManifest[]): StyleGroup[]` — group elements
- `collectMobileBoxes(page: Page, elements: ElementManifest[]): Promise<void>` — optional viewport resize for multi-viewport tests (only called when needed)

Implementation follows spec Section 3.1-3.2 exactly. The `page.evaluate` collects selectors via `CSS.escape`, computed styles, bounding boxes, ARIA states, and parent background color. Style fingerprint includes `parentTag.parentClass + className + data-* attributes`.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/worker/__tests__/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/manifest.ts src/worker/__tests__/manifest.test.ts
git commit -m "feat(v5): add Tier 0 manifest pre-scan with style fingerprinting"
```

---

## Phase 3: Tier 1 — DOM/CSSOM Analysis

### Task 5: CSSOM hover analysis

**Files:**
- Create: `src/worker/tier1-cssom.ts`
- Test: `src/worker/__tests__/tier1-cssom.test.ts`

- [ ] **Step 1: Write tests for CSSOM hover resolution**

Test the pure logic: given default styles and hover rules, determine if contrast ratio meets 3:1.

```typescript
// src/worker/__tests__/tier1-cssom.test.ts
import { test, expect } from "bun:test";
import { evaluateHoverContrast } from "../tier1-cssom";

test("sufficient hover contrast returns pass", () => {
  const result = evaluateHoverContrast(
    { backgroundColor: "rgb(255,255,255)" },     // default
    { backgroundColor: "rgb(0,0,0)" },             // hover
    "rgb(255,255,255)",                             // parent bg
  );
  expect(result).toBe("pass");
});

test("insufficient hover contrast returns fail", () => {
  const result = evaluateHoverContrast(
    { backgroundColor: "rgb(200,200,200)" },
    { backgroundColor: "rgb(210,210,210)" },
    "rgb(255,255,255)",
  );
  expect(result).toBe("fail");
});

test("no hover rules returns ambiguous", () => {
  const result = evaluateHoverContrast(
    { backgroundColor: "rgb(255,255,255)" },
    null, // CSSOM couldn't resolve
    "rgb(255,255,255)",
  );
  expect(result).toBe("ambiguous");
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `bun test src/worker/__tests__/tier1-cssom.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement tier1-cssom.ts**

Create `src/worker/tier1-cssom.ts` with:
- `buildCssomHoverQuery(): string` — returns the `page.evaluate` script that reads CSSOM `:hover` rules (with try/catch for cross-origin, recursive traversal, CSS variable detection, and `promoteToTier2` flag as per spec Section 4.1)
- `evaluateHoverContrast(defaultStyles, hoverStyles, parentBg): TierResult` — pure function that computes contrast ratio using existing `stateChangeRatio` from `src/analyzer/contrast.ts`

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/worker/__tests__/tier1-cssom.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/tier1-cssom.ts src/worker/__tests__/tier1-cssom.test.ts
git commit -m "feat(v5): add Tier 1 CSSOM hover analysis"
```

---

### Task 6: Tier 1 orchestrator (runs all DOM-only tests on manifest)

**Files:**
- Create: `src/worker/tier1.ts`
- Test: `src/worker/__tests__/tier1.test.ts`

- [ ] **Step 1: Write test for tier1 orchestration logic**

Test that tier1 processes style group representatives and amplifies results.

- [ ] **Step 2: Implement tier1.ts**

Create `src/worker/tier1.ts` with:
- `runTier1(page: Page, groups: StyleGroup[], url: string, timer: TierTimer): Promise<{ issues: Issue[]; promotedElements: ElementManifest[] }>`
- Runs CSSOM hover analysis on each representative
- Calls existing test functions (from `src/analyzer/`) that only need `page.evaluate`: semantic-structure, meaningful-sequence, legal-a11y
- Amplifies PASS/FAIL to all group members
- Promotes AMBIGUOUS elements to tier2 list
- Records timing via `timer.endTier("tier1", {...})`

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

```bash
git add src/worker/tier1.ts src/worker/__tests__/tier1.test.ts
git commit -m "feat(v5): add Tier 1 orchestrator with amplification"
```

---

## Phase 4: Tier 2 — Unified Interaction Pass

### Task 7: Adaptive wait utility

**Files:**
- Create: `src/worker/adaptive-wait.ts`
- Test: `src/worker/__tests__/adaptive-wait.test.ts`

- [ ] **Step 1: Write test**

```typescript
import { test, expect } from "bun:test";
import { adaptiveWait } from "../adaptive-wait";

test("adaptiveWait resolves immediately if no animations", async () => {
  // Mock page with no animations — should resolve in <50ms
  // This is a unit test of the logic, not the Playwright call
  expect(typeof adaptiveWait).toBe("function");
});
```

- [ ] **Step 2: Implement adaptive-wait.ts**

Implement `adaptiveWait(page, selector, trigger, maxMs)` as per spec Section 5.2. Uses `page.waitForFunction` to check `el.getAnimations()` completion with `maxMs` as ceiling.

- [ ] **Step 3: Commit**

```bash
git add src/worker/adaptive-wait.ts src/worker/__tests__/adaptive-wait.test.ts
git commit -m "feat(v5): add adaptive wait utility (replaces waitForTimeout)"
```

---

### Task 8: Unified interaction pass

**Files:**
- Create: `src/worker/tier2.ts`
- Test: `src/worker/__tests__/tier2.test.ts`

- [ ] **Step 1: Write tests for interaction result evaluation**

Test the pure functions that convert InteractionResult → issues (no Playwright needed):
- `evaluateStateChange(element, result): Issue[]`
- `evaluateHoverFocus(element, result): Issue[]`
- `evaluateAriaStates(element, result): Issue[]`
- `evaluateKeyboard(element, result): Issue[]`

- [ ] **Step 2: Implement tier2.ts**

Create `src/worker/tier2.ts` with:
- `runTier2(page: Page, elements: ElementManifest[], url: string, timer: TierTimer): Promise<{ issues: Issue[]; promotedToTier3: ElementManifest[] }>`
- `unifiedInteractionPass(page, element, manifest)` — single loop per element as per spec Section 5.1
- Safety guards for click (spec Section 5.1 step 4)
- Navigation guard for keyboard (spec Section 5.1 step 5)
- CSS popup detection (spec Section 5.3) — opacity/visibility/display transitions
- Pure evaluation functions that convert InteractionResult → Issue[]
- Tier 2 amplification rules: only "no-change" results amplified (spec Section 4.3)

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

```bash
git add src/worker/tier2.ts src/worker/__tests__/tier2.test.ts
git commit -m "feat(v5): add Tier 2 unified interaction pass"
```

---

### Task 9: Form auto-fill for status-messages (GAP 1 fix)

**Files:**
- Create: `src/worker/form-autofill.ts`
- Test: `src/worker/__tests__/form-autofill.test.ts`

- [ ] **Step 1: Write test for field type detection**

```typescript
test("getAutoFillValue returns correct value per input type", () => {
  expect(getAutoFillValue("email", "input")).toBe("test@example.com");
  expect(getAutoFillValue("tel", "input")).toBe("+34600000000");
  expect(getAutoFillValue("text", "input")).toBe("Test accessibility audit");
  expect(getAutoFillValue(null, "textarea")).toBe("Test accessibility audit");
});
```

- [ ] **Step 2: Implement form-autofill.ts**

`autoFillAndSubmit(page, formSelector)` as per spec Section 5.4. Uses `adaptiveWait` after submit (not `waitForTimeout`). Sets up MutationObserver before submit to detect live region changes.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

```bash
git add src/worker/form-autofill.ts src/worker/__tests__/form-autofill.test.ts
git commit -m "feat(v5): add form auto-fill for status-messages gap fix"
```

---

## Phase 5: Tier 3 — Optimized LLM Vision

### Task 10: Crop screenshot utility

**Files:**
- Create: `src/worker/crop-screenshot.ts`
- Test: `src/worker/__tests__/crop-screenshot.test.ts`

- [ ] **Step 1: Write test**

Test that crop dimensions are calculated correctly and clamped to viewport bounds.

- [ ] **Step 2: Implement crop-screenshot.ts**

`cropScreenshot(page, selector, padding)` as per spec Section 6.1. Re-queries bounding box at capture time (not from manifest). Saves crops to `reports/{auditId}/crops/` on disk.

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

```bash
git add src/worker/crop-screenshot.ts src/worker/__tests__/crop-screenshot.test.ts
git commit -m "feat(v5): add crop screenshot utility for Tier 3"
```

---

### Task 11: Specialized CoT prompts and batch LLM calls

**Files:**
- Create: `src/worker/tier3-prompts.ts`
- Modify: `src/llm/client.ts` (add `chatVisionBatch`, increase `max_tokens` for batch)
- Test: `src/worker/__tests__/tier3-prompts.test.ts`

- [ ] **Step 1: Write tests for prompt template rendering**

- [ ] **Step 2: Create tier3-prompts.ts**

CoT prompt templates per violation type (color-use-link, color-use-status, sensory-instructions) as per spec Section 6.3.

- [ ] **Step 3: Add `chatVisionBatch` to LLMClient**

Modify `src/llm/client.ts`:
- Add `chatVisionBatch(messages, maxTokens = 1500)` method
- Track `visionCalls` separately from `enrichmentCalls` (resolves MEDIUM-8)
- Support `detail: "low"` in image_url (verify Moonshot compatibility)

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/worker/tier3-prompts.ts src/llm/client.ts src/worker/__tests__/tier3-prompts.test.ts
git commit -m "feat(v5): add specialized CoT prompts and batch LLM vision"
```

---

### Task 12: Tier 3 async queue worker

**Files:**
- Create: `src/worker/tier3-queue.ts`
- Test: `src/worker/__tests__/tier3-queue.test.ts`

- [ ] **Step 1: Write tests for queue processing logic**

Test job claim, completion, failure, and cache lookup/set logic (mock DB).

- [ ] **Step 2: Implement tier3-queue.ts**

- `processTier3Queue(auditId, llmClient)` — loop that claims jobs, executes batch LLM calls with crops, inserts confirmed issues, pushes SSE events
- Cache lookup before LLM call (intra-audit + cross-audit with TTL)
- Confidence-based early termination (spec Section 6.7)
- 5-minute timeout → auto-transition to `completed`
- Crash recovery: reset `running` jobs to `pending`

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

```bash
git add src/worker/tier3-queue.ts src/worker/__tests__/tier3-queue.test.ts
git commit -m "feat(v5): add Tier 3 async queue worker with cache"
```

---

## Phase 6: Pipeline Integration

### Task 13: Rewrite probe.ts to use tier system

**Files:**
- Modify: `src/worker/probe.ts` (major rewrite)
- Test: Run existing tests + integration test

- [ ] **Step 1: Rewrite `runProbePhase` in probe.ts**

Replace the current sequential test execution (lines 56-234) with:

```typescript
// For each template cluster:
//   1. Tier 0: collectManifest + groupByFingerprint
//   2. Run existing axe-full (unchanged)
//   3. Run existing page.evaluate tests in parallel (unchanged)
//   4. Tier 1: runTier1(page, groups, url, timer)
//   5. Tier 2: runTier2(page, promotedElements, url, timer)
//   6. Collect Tier 3 candidates → insert tier3_jobs
//   7. Run viewport tests (reflow, resize-text, text-spacing) — unchanged
//   8. Template amplification — unchanged
//   9. Persist timing via tracer
```

Key: existing analyzer functions (`testReflow`, `testResizeText`, etc.) stay as library calls. Only the interactive tests (state-change-contrast, hover-focus, aria-states) are replaced by Tier 1-2.

- [ ] **Step 2: Run all existing tests**

Run: `bun test`
Expected: All 253 tests pass (existing tests should not break — analyzer library functions unchanged)

- [ ] **Step 3: Commit**

```bash
git add src/worker/probe.ts
git commit -m "refactor(v5): rewrite probe.ts to use tier system"
```

---

### Task 14: Pipeline status transitions and additionalUrls

**Files:**
- Modify: `src/worker/pipeline.ts` (additionalUrls seeding, completed-base status)
- Modify: `src/server/routes/audits.ts` (accept completed-base status)
- Modify: `src/server/routes/export.ts` (allow export on completed-base)
- Modify: `src/server/middleware/cache.ts` (cache completed-base with short TTL)

- [ ] **Step 1: Seed additionalUrls in pipeline.ts**

Before SCAN phase, add:
```typescript
if (config.additionalUrls?.length) {
  for (const url of config.additionalUrls) {
    const resolved = new URL(url, baseUrl).href;
    urlQueue.add(resolved, { source: 'manual', depth: 0 });
  }
}
```

- [ ] **Step 2: Update status transitions**

In `pipeline.ts`, after probe completes Tier 0-2:
- Call `markAuditCompletedBase()` instead of `markAuditCompleted()`
- Launch `processTier3Queue()` in background (non-blocking)
- Tier 3 queue calls `markAuditFullyCompleted()` when done

- [ ] **Step 3: Update consumers for completed-base**

Per spec Section 6.5 consumer table:
- `audits.ts`: add `"completed-base"` to valid statuses
- `export.ts`: allow export on `completed-base` (add note header)
- `cache.ts`: cache `completed-base` with 30s TTL

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/pipeline.ts src/server/routes/audits.ts src/server/routes/export.ts src/server/middleware/cache.ts
git commit -m "feat(v5): add completed-base status, additionalUrls, and Tier 3 background launch"
```

---

## Phase 7: Performance API

### Task 15: Performance endpoint

**Files:**
- Create: `src/server/routes/performance.ts`
- Modify: `src/server/index.ts` (register route)
- Test: `src/server/__tests__/performance.test.ts`

- [ ] **Step 1: Implement performance.ts**

`GET /api/audits/:id/performance` that:
1. Reads `audit_spans` where `name LIKE 'probe:tier:%'` for the audit
2. Aggregates timing data from span metadata
3. Reads LLM usage from audit record
4. Returns the full performance breakdown as per spec Section 8.3

- [ ] **Step 2: Register route in index.ts**

Add route match before the catch-all audits route (line ~133):
```typescript
if (url.pathname.match(/^\/api\/audits\/[^/]+\/performance$/)) {
  return handlePerformance(req, url);
}
```

- [ ] **Step 3: Write test**

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/performance.ts src/server/index.ts src/server/__tests__/performance.test.ts
git commit -m "feat(v5): add GET /api/audits/:id/performance endpoint"
```

---

## Phase 8: Validation

### Task 16: Integration test — run audit on example-client.com

**Files:**
- No new files — manual validation

- [ ] **Step 1: Apply DB migrations**

Run the new schema SQL against the database to create `tier3_jobs` and `tier3_cache` tables.

- [ ] **Step 2: Start server and worker**

Run: `bun run src/server/index.ts` and `bun run src/worker/index.ts`

- [ ] **Step 3: Trigger audit**

```bash
curl -X POST http://localhost:3000/api/audits -H 'Content-Type: application/json' \
  -d '{"url":"https://example-client.com/","config":{"maxDepth":3,"maxPages":50,"wcagLevel":"AA"}}'
```

- [ ] **Step 4: Monitor progress**

Watch for:
- Tier 0-2 completes → status transitions to `completed-base`
- Issues are visible immediately
- Tier 3 jobs process in background
- SSE events fire for tier3 results
- Status transitions to `completed`

- [ ] **Step 5: Verify performance endpoint**

```bash
curl http://localhost:3000/api/audits/{id}/performance | python3 -m json.tool
```

Verify: tier breakdown, timing per template, LLM usage with vision/text split.

- [ ] **Step 6: Compare results**

Compare against previous audit (`bdb0087b`):
- Total issues should be similar or higher (gaps closed)
- Time should be -30-45% lower
- LLM cost should be -60-80% lower
- All 31 detected rules should still be present
- WCAG criterion mapping should remain 100%

- [ ] **Step 7: Commit any fixes**

```bash
git commit -m "fix(v5): integration test fixes"
```

---

## Task Dependency Graph

```
Task 1 (types) ──────────────┐
Task 2 (schema/db) ──────────┤
Task 3 (timer) ──────────────┤
                              ▼
Task 4 (manifest) ──────── Phase 2
                              │
                              ▼
Task 5 (CSSOM) ────────┐
Task 6 (tier1 orch) ───┤── Phase 3
                        │
                        ▼
Task 7 (adaptive wait) ─┐
Task 8 (tier2) ──────────┤── Phase 4
Task 9 (form autofill) ──┘
                          │
                          ▼
Task 10 (crop) ──────┐
Task 11 (prompts) ───┤── Phase 5
Task 12 (queue) ─────┘
                      │
                      ▼
Task 13 (probe rewrite) ─┐
Task 14 (pipeline) ──────┤── Phase 6
                          │
                          ▼
Task 15 (perf API) ────── Phase 7
                          │
                          ▼
Task 16 (integration) ─── Phase 8
```

**Parallelizable:** Tasks 1-3 can run in parallel. Tasks 5+7 can run in parallel. Tasks 10+11 can run in parallel.

**Sequential gates:** Task 4 needs Task 1. Task 6 needs Tasks 4+5. Task 8 needs Tasks 6+7. Task 13 needs Tasks 6+8+12. Task 16 needs everything.
