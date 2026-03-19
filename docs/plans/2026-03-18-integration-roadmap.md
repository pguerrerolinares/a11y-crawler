# Integration Roadmap: LLM-Augmented WCAG Testing

> Date: 2026-03-18
> Status: Draft
> Context: Integration analysis of research findings with existing a11y-crawler-v2 architecture
> Prerequisites: `docs/research/llm-automated-wcag-human-judgment.md`, `docs/research/web-page-representation-for-llm-agents.md`

---

## 1. Current State Assessment

### 1.1 What We Have

The scanner currently covers ~70-75% of what a manual audit (like Aiblu's) covers, across 33+ pages vs 6 in a manual audit.

**Test coverage:**
- axe-core: ~80 WCAG rules (A, AA, AAA configurable)
- Interactive tests: tab order (2.4.3), focus visibility (2.4.7), skip nav (2.4.1), keyboard operability (2.1.1)
- Custom WCAG tests: reflow (1.4.10), text-spacing (1.4.12), resize-text (1.4.4), multimedia (1.2.1-1.2.5), timed events (2.2.1-2.2.2), target size (2.5.8), error identification (3.3.1-3.3.3), non-text contrast (1.4.11)

**Architecture (3-phase pipeline):**
```
SCAN → CLASSIFY → PROBE
 │        │         │
 │        │         └── Sequential per template, ordered execution:
 │        │              1. axe-full (clean DOM)
 │        │              2. error-identification (form submit)
 │        │              3. parallel evaluate: target-size, multimedia, timed-events, non-text-contrast
 │        │              4. interactive (Tab/focus/keyboard)
 │        │              5. reflow, resize-text (viewport changes)
 │        │              6. text-spacing (CSS injection, last)
 │        │
 │        └── clusterPages() by URL pattern + SimHash → buildTestPlan() → selectRepresentative()
 │
 └── Concurrent page loading (SlotPool, 3 slots) → DOM fingerprint + links + axe-LIGHT + LLM nav discovery
```

### 1.2 What's Missing (8 "Human Judgment" Criteria)

| # | WCAG | Criterion | Gap Type |
|---|---|---|---|
| 1 | 1.4.1 | Use of Color | Needs CVD simulation + LLM vision |
| 2 | 1.3.3 | Sensory Characteristics | Needs LLM text analysis |
| 3 | 1.4.13 | Content on Hover/Focus | Needs Playwright state machine |
| 4 | 1.3.2 | Meaningful Sequence | Needs Kendall tau algorithm |
| 5 | 1.3.1 | Info and Relationships | Needs computedStyle heuristics + LLM |
| 6 | 4.1.2 | Name, Role, Value (dynamic) | Needs interaction + ARIA assertion |
| 7 | 4.1.3 | Status Messages | Needs MutationObserver post-submit |
| 8 | 1.3.1/1.3.2 | Multicolumn Order | Needs Kendall tau + multi-viewport |

---

## 2. Bugs in Existing Tests

Quality review of the current test suite revealed these issues:

### 2.1 Critical Bugs

#### BUG-1: `parseRgba` doesn't handle modern CSS color syntax
- **File:** `src/analyzer/contrast.ts:7-8`
- **Impact:** Non-text contrast test silently falls back to white `[255,255,255]` for any element using space-separated `rgb(255 0 0 / 0.5)` syntax (Chrome 101+). Produces **systematically wrong contrast ratios**.
- **Fix:** Extend regex to: `/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/`

#### BUG-2: `testResizeText` confuses zoom 200% with viewport 640px
- **File:** `src/analyzer/wcag-tests.ts:194-217`
- **Impact:** WCAG 1.4.4 is about text enlargement at 200% zoom, NOT responsive layout. Halving viewport tests responsive breakpoints. False positives on responsive sites, false negatives on sites that clamp font-size via viewport units.
- **Fix:** Use `document.documentElement.style.zoom = '2'` or CSS `transform: scale(2)` to simulate actual zoom.

#### BUG-3: `testErrorIdentification` submits real forms on production sites
- **File:** `src/analyzer/wcag-tests.ts:456-542`
- **Impact:** Clicking submit on live forms can create database records, send emails, trigger CAPTCHAs, or get the crawler IP banned. The `SKIP_ACTIONS` regex is a safeguard but misses forms with relative actions like `action=""`.
- **Fix:** Replace `submitBtn.click()` with `form.checkValidity()` for HTML5 constraint validation. Only submit forms in an opt-in "destructive tests" mode.

#### BUG-4: Viewport not restored on error in reflow/resize tests
- **File:** `src/analyzer/wcag-tests.ts:40-84` (reflow), `src/analyzer/wcag-tests.ts:195-222` (resize)
- **Impact:** If `page.evaluate()` throws, viewport stays at 320px/640px for all subsequent tests on the same page. All following tests (text-spacing, target-size, etc.) run at wrong viewport.
- **Fix:** Wrap viewport modification in `try/finally` to guarantee restoration.

### 2.2 High Bugs

#### BUG-5: Focus visibility uses wrong logical operator
- **File:** `src/analyzer/interactive.ts:188`
- **Impact:** `noChange || outlineRemoved` should be `noChange && outlineRemoved`. Currently flags elements that DO have focus indicators via box-shadow/border change but happen to have `outline: none`. Generates false positives.
- **Fix:** Change `||` to `&&` — flag only when NO visual property changed at all.

#### BUG-6: Reflow test iterates ALL `body *` elements, duplicating issues
- **File:** `src/analyzer/wcag-tests.ts:54-66`
- **Impact:** If a `<section>` overflows, every `<p>`, `<span>`, `<a>` inside it also exceeds 320px, generating dozens of duplicate issues for a single root cause. O(n) layout-triggering on large pages.
- **Fix:** After finding an overflowing element, skip its descendants via `el.contains()` check.

#### BUG-7: Keyboard operability uses innerHTML length delta as proxy
- **File:** `src/analyzer/interactive.ts:316-317`
- **Impact:** `Math.abs(domBefore - domAfter) < 10` is arbitrary. Tooltip = false positive, counter increment = false negative.
- **Fix:** Use MutationObserver targeted at `aria-controls` element, or compare accessibility tree snapshots.

#### BUG-8: Duplicated axe-core runner with divergent behavior
- **File:** `src/worker/probe.ts:163-200` vs `src/analyzer/axe.ts:15-59`
- **Impact:** Two implementations that differ in: resultTypes handling, category assignment (hardcoded "structural" vs `getViolationCategory()`), ID generation (UUID vs hash), selector joining (`, ` vs ` > `). One is likely dead code.
- **Fix:** Consolidate into single function or delete unused `axe.ts`.

### 2.3 Medium Issues

#### BUG-9: `makeIssue` lacks WCAG criterion metadata
- **File:** `src/analyzer/wcag-tests.ts:5-34`
- **Impact:** Issues from custom tests have empty `wcagTags`, `wcagCriterion`, `helpUrl`. Compare with `createInteractiveIssue` which properly populates these. Makes issues less useful in reports and impossible to filter by criterion.
- **Fix:** Add `wcagCriterion` and `wcagTags` parameters to `makeIssue`.

#### BUG-10: Target-size test doesn't exempt inline links
- **File:** `src/analyzer/wcag-tests.ts:403-448`
- **Impact:** WCAG 2.5.8 explicitly exempts inline text links, native controls with user-agent sizing, and targets with sufficient spacing. Current test flags ALL undersized interactive elements, generating hundreds of false positives on content-heavy pages.
- **Fix:** Filter out `<a>` inside flow content (`p`, `li`, `td`) and native `<input>`/`<select>`.

#### BUG-11: Text-spacing test misses overflow variants
- **File:** `src/analyzer/wcag-tests.ts:111`
- **Impact:** Only checks `overflow === "hidden"`. Misses `overflow: clip`, `overflow-y: hidden`, `overflow-x: hidden`. `getComputedStyle().overflow` returns two values when x/y differ.
- **Fix:** Check `overflow`, `overflowX`, `overflowY` individually against both `"hidden"` and `"clip"`.

#### BUG-12: CSS selector generation copy-pasted 8 times
- **Files:** `wcag-tests.ts` (lines 59-63, 114-117, 241, 343, 421-425), `interactive.ts` (lines 86-91, 191-196, 281-285)
- **Impact:** Each copy has slightly different truncation behavior. DRY violation, will diverge further.
- **Fix:** Extract shared `cssSelector(el: Element): string` utility.

#### BUG-13: Skip navigation detection overly broad
- **File:** `src/analyzer/interactive.ts:223-224`
- **Impact:** Selector `a[href^="#"]:first-of-type` matches any anchor starting with `#` that is first child of parent, not first link on page. `<footer><a href="#top">` would match.
- **Fix:** Restrict to first few focusable elements on the page.

---

## 3. Architecture Integration Plan

### 3.1 Plumbing Changes Required

#### PLUMB-1: Pass LLMClient to probe phase
- **Current:** `LLMClient` exists in worker but only reaches scan phase (nav discovery)
- **Change:** `runProbePhase()` at `probe.ts:22-28` needs `llmClient: LLMClient | null` parameter. `pipeline.ts:152` already has `llmClient` in scope — just forward it.
- **Unblocks:** All LLM-based tests in probe phase.

#### PLUMB-2: Add `llm_confidence` column to issues table
- **Current:** `llmConfidence` exists on `Issue` type (`issue.ts:31`) but is NOT persisted to database
- **Change:** Add `llm_confidence TEXT` column via migration in `db.ts`. Add to `insertIssuesV4()` at `db.ts:317-331`.
- **Unblocks:** Confidence-based filtering in dashboard.

#### PLUMB-3: Add `"llm-vision"` to CheckSource
- **Current:** `"axe" | "llm" | "interactive" | "scan-light" | "wcag-custom"`
- **Change:** Add `"llm-vision"` to `src/types/issue.ts:3`
- **Unblocks:** Distinguishing LLM-vision findings from deterministic ones.

#### PLUMB-4: Screenshot capture helper
- **Current:** `page.screenshot()` available but no utility function
- **Change:** Create `captureScreenshot(page, selector?): Promise<string>` returning base64. Integrate with `buildMultimodalMessage()` from `llm/client.ts:152-164`.
- **Unblocks:** CVD simulation, evidence screenshots, LLM vision calls.

#### PLUMB-5: Shared cssSelector utility
- **Current:** 8 copy-pasted selector generation blocks
- **Change:** Extract to `src/analyzer/utils.ts`
- **Unblocks:** Consistent selector generation across all tests.

### 3.2 New TestType Values

Add to `src/types/pipeline.ts:23-33`:
```typescript
type TestType =
  // existing
  | "axe-full" | "interactive" | "reflow" | "text-spacing" | "resize-text"
  | "multimedia" | "timed-events" | "target-size" | "error-identification"
  | "non-text-contrast"
  // new — zero LLM cost
  | "hover-focus"           // WCAG 1.4.13
  | "meaningful-sequence"   // WCAG 1.3.2
  | "aria-states"           // WCAG 4.1.2 dynamic
  | "status-messages"       // WCAG 4.1.3
  | "semantic-structure"    // WCAG 1.3.1 heuristics
  // new — requires LLM
  | "color-use"             // WCAG 1.4.1 (DOM heuristics + CVD + LLM)
  | "sensory-instructions"  // WCAG 1.3.3
```

### 3.3 Probe Phase Execution Order (Updated)

```
PROBE PHASE (per template representative):

1. axe-full                        ← existing (clean DOM, runs first)
2. error-identification            ← existing (form interaction)
3. PARALLEL page.evaluate() block: ← no DOM mutation, safe to parallelize
   ├── target-size                   (existing)
   ├── multimedia                    (existing)
   ├── timed-events                  (existing)
   ├── non-text-contrast             (existing)
   ├── NEW: semantic-structure       (pseudo-heading/list/table/fieldset heuristics)
   ├── NEW: meaningful-sequence      (Kendall tau DOM vs visual order)
   └── NEW: color-use-dom           (Tier 1: link underlines, form errors, status indicators)
4. interactive                     ← existing (Tab/focus/keyboard)
   ├── NEW: aria-states             (click trigger → verify aria-expanded/selected/current)
   ├── NEW: hover-focus             (hover → test persistent/hoverable/dismissible)
   └── NEW: status-messages         (submit → MutationObserver → verify live regions)
5. reflow                          ← existing (viewport 320px)
   └── NEW: meaningful-sequence @ 320px  (Kendall tau at mobile viewport)
6. resize-text                     ← existing (FIX: zoom 2x instead of viewport 640px)
7. text-spacing                    ← existing (CSS injection, last)
8. NEW: cvd-screenshots            ← NEW slot, after text-spacing restore
   └── CDP setEmulatedVisionDeficiency → pixelmatch diff → LLM vision if diff > 0.5%
9. NEW: sensory-instructions       ← LLM text analysis of form instructions (can run anytime)
```

### 3.4 Template Amplification (New Rules)

Add to `TEMPLATE_LEVEL_RULES` set at `probe.ts:13-20`:
```
meaningful-sequence, semantic-pseudo-heading, semantic-pseudo-list,
color-use-link, color-use-form, aria-state-missing,
hover-focus-not-persistent, hover-focus-not-hoverable, hover-focus-not-dismissible,
status-message-no-live-region
```

### 3.5 Category Mappings

Add to `src/analyzer/category.ts`:
```typescript
// New rule → category mappings
'meaningful-sequence': 'structural',
'semantic-pseudo-heading': 'semantic',
'semantic-pseudo-list': 'semantic',
'semantic-pseudo-table': 'semantic',
'semantic-missing-fieldset': 'semantic',
'color-use-link': 'visual',
'color-use-form': 'visual',
'color-use-status': 'visual',
'color-use-cvd': 'visual',
'aria-state-missing': 'interactive',
'hover-focus-not-persistent': 'interactive',
'hover-focus-not-hoverable': 'interactive',
'hover-focus-not-dismissible': 'interactive',
'status-message-no-live-region': 'interactive',
'sensory-instruction': 'structural',
```

Note: May need to add `"semantic"` as a new `ViolationCategory` value, or use `"structural"` as fallback.

---

## 4. Infrastructure Already Available (Reuse)

| Need | Already Built | Location |
|---|---|---|
| LLM client with rate limiting + circuit breaker | Yes | `src/llm/client.ts:48-88` |
| Multimodal/vision message builder | Yes | `src/llm/client.ts:152-164` (`buildMultimodalMessage`) |
| JSON extraction from LLM responses | Yes | `src/llm/client.ts:139-147` (`extractJsonFromLlm`) |
| Token estimation | Yes | `src/llm/client.ts:130-133` |
| WCAG contrast math (luminance, ratio) | Yes | `src/analyzer/contrast.ts:1-48` |
| Issue factory with deterministic IDs | Yes | `src/analyzer/interactive.ts:33-65` (`createInteractiveIssue`) |
| Browser context recycling | Yes | `src/worker/probe-context.ts` (`ProbeContextManager`) |
| Template amplification | Yes | `src/worker/probe.ts:89-145` |
| Page capabilities detection | Yes | `src/analyzer/classify.ts` |
| Playwright page + CDP access | Yes | Via Browserless connection |

**Key finding:** `buildMultimodalMessage()` already supports base64 PNG images for LLM vision calls. The only missing piece is capturing screenshots and piping them through.

---

## 5. Constraints

| Constraint | Value | Impact |
|---|---|---|
| VPS RAM | 4GB total, ~1.8GB available | Limits concurrent browser tabs |
| Browserless timeout | 600s per connection | Single probe template must complete within window |
| LLM rate limit | 10 RPM (TokenBucket) | Max 10 LLM calls per minute across all tests |
| Probe concurrency | Sequential per template | Adding LLM tests adds wall-clock time per template |
| Browser tab memory | ~50-150MB each | With concurrency=3 in scan, peak ~450MB |
| LLM cost | ~$0.003/page for vision | ~$0.10-0.30 per full audit (33 pages) |

---

## 6. Competitive Positioning

### 6.1 Coverage Comparison

| Criterion | axe-core | pa11y | WAVE | Aiblu (manual) | a11y-crawler (current) | a11y-crawler (proposed) |
|---|---|---|---|---|---|---|
| 1.4.1 Use of Color | No | No | No | Yes | No | **Yes (CVD+LLM)** |
| 1.4.13 Hover/Focus | No | No | No | Yes | No | **Yes (state machine)** |
| 1.3.2 CSS Reorder | No | No | No | Yes | No | **Yes (Kendall tau)** |
| 1.3.1 Semantic Structure | Partial | No | Partial | Yes | No | **Yes (heuristics+LLM)** |
| 4.1.2 Dynamic ARIA | No | No | No | Yes | No | **Yes (interaction)** |
| 4.1.3 Status Messages | No | No | No | Yes | Partial | **Yes (MutationObserver)** |
| 1.3.3 Sensory Instructions | No | No | No | Yes | No | **Yes (LLM text)** |
| Pages per audit | 1 | 1 | 1 | 5-10 | 33+ | 33+ |
| Cost | Free | Free | Free | €€€€ | ~$0 | ~$0.30 |

### 6.2 Unique Differentiators

1. **CVD screenshot simulation** — No automated tool does this. Chrome DevTools has it for developers, but no scanner uses it to detect 1.4.1 violations.
2. **Hover/focus state machine** — Confirmed research gap (Springer 2025). Zero existing tools test the 3 conditions.
3. **Kendall tau reading order** — CSS WG acknowledges no tools detect this (Issue #7387).
4. **LLM-augmented semantic detection** — ScreenAudit (CHI 2025) showed 83.3% precision. We combine with deterministic heuristics for higher accuracy.
5. **Scale** — 33+ pages automated vs 6 manual, with template amplification for structural issues.

---

## 7. Product Ideas

### 7.1 Accessibility Confidence Score

Instead of binary pass/fail, each criterion gets a confidence score based on the detection tier:

```
WCAG 1.4.1 Use of Color:
  Tier 1 (DOM heuristics): 3 links without underline → confidence: 95% (deterministic)
  Tier 2 (CVD diff): 2.3% pixel diff → confidence: 80% (statistical)
  Tier 3 (LLM vision): "chart legend affected" → confidence: 70% (semantic)

  → Overall: FAIL (highest-confidence evidence: 95%)
```

**Implementation:** Persist `llm_confidence` already on Issue type. Add `detection_tier` field.

### 7.2 Progressive Audit (SaaS Tiers)

```
Level 1: "Quick Scan" (free, 30s)
  → axe-core scan-light only
  → ~40% WCAG coverage

Level 2: "Deep Scan" (basic plan, 5min)
  → Full probe phase + new DOM heuristics + interaction tests
  → ~75% WCAG coverage

Level 3: "Expert Scan" (premium plan, $0.30, 8min)
  → + CVD simulation + LLM vision + semantic analysis
  → ~90% WCAG coverage
  → Includes screenshot evidence
```

### 7.3 Evidence-Based Issues (Screenshot Proof)

For LLM-vision and CVD issues, store screenshots as evidence:
- 1.4.1: normal + deuteranopia + diff image
- 1.3.1: screenshot crop of pseudo-heading + HTML fragment
- 1.4.13: sequence of 3 screenshots (hover → popup → after ESC)

Store in `REPORTS_DIR` alongside PDF reports.

### 7.4 Comparative Report

Generate output showing: "This analysis covers 90% of criteria a manual audit of €X would cover. Criteria requiring additional human validation: [short list]. Time: 5 minutes. Pages: 33."

### 7.5 Malaga Bridge (Future)

University of Malaga paper (arXiv 2602.17887) does detection + automated remediation (80-86% fix rate) but has no crawling. Our crawler has crawling + detection but no remediation. Complementary integration: detect → quantify → repair.

---

## 8. Execution Phases

### Phase A: Fix Existing Bugs — COMPLETED (2026-03-18)

11 bugs fixed across `contrast.ts`, `wcag-tests.ts`, `interactive.ts`, `utils.ts`.
Plan: `docs/plans/2026-03-18-bugfix-existing-tests.md`

### Phase B: Plumbing — COMPLETED (2026-03-18)

LLMClient passed to probe, `llm_confidence` DB column, `"llm-vision"` CheckSource, vision model config, `buildTestPlan()` updated, category mappings added.

### Phase C: Zero-Cost Tests — COMPLETED (2026-03-18)

5 new tests implemented, wired into probe, with 30s timeouts per interactive test.
Plan: `docs/plans/2026-03-18-zero-cost-wcag-tests.md`

### Phase D: LLM Tests — COMPLETED (2026-03-18/19)

2 LLM tests (color-use 3-tier, sensory-instructions). Dependencies: sharp, pixelmatch.
Plan: `docs/plans/2026-03-18-llm-wcag-tests.md`

### Phase E: Evidence & Reporting — PARTIALLY COMPLETED (2026-03-19)

| Feature | Status |
|---|---|
| CVD screenshot storage (per template) | Done |
| Screenshot serving API | Done |
| `pageUrl`, `llmConfidence`, `wcagCriterion` in API | Done |
| Confidence badges + evidence links in UI | Done |
| Coverage summary tab | Done |
| Page column + page filter in issue table | Done |
| Debounced rule filter | Done |
| LRU cache for API responses (`lru-cache`) | Done |
| DB indexes for issue queries | Done |
| PDF export with embedded screenshots | **Pending** |
| CSV export with `llm_confidence` column | Done |

Plan: `docs/plans/2026-03-18-evidence-reporting.md`

### Additional improvements (2026-03-19)

- Consent banner filtering in DOM tests (`CONSENT_BANNER_SELECTOR`)
- ILIKE partial match for rule filter
- Explicit column SELECT instead of `SELECT *` for performance

---

## 9. Expected Outcome — ACHIEVED

| Metric | Before (v4.2) | After (v4.4) |
|---|---|---|
| WCAG criteria covered | ~70-75% of manual audit | **~90%** |
| False positive rate | High (bugs + consent noise) | **Reduced** (fixes + consent filter) |
| Tests with LLM | 0 | **2** (color-use vision, sensory instructions) |
| Tests with interaction | 4 | **8** (+aria-states, hover-focus, status-messages, keyboard improvements) |
| Tests with DOM heuristics | 8 | **13** (+meaningful-sequence, semantic-structure, color-use-dom) |
| Cost per audit | $0 | **~$0.05** (LLM costs only) |
| Unique-in-industry tests | 0 | **7** (CVD simulation, hover state machine, Kendall tau, semantic heuristics, ARIA states, status messages, sensory instructions) |
| Issues per audit (5 pages) | 133 (scan-light only) | **465** (full pipeline) |
| API response time | 2-8ms | **<1ms cached, 2-8ms uncached** |

---

## 10. References

- `docs/research/llm-automated-wcag-human-judgment.md` — Detailed technique specifications for each new test
- `docs/research/web-page-representation-for-llm-agents.md` — LLM input modality research (a11y tree vs HTML vs screenshots)
- ScreenAudit (CHI 2025) — LLM semantic structure detection
- AccessGuru (2025) — GPT-4o + Playwright accessibility pipeline
- GenA11y (FSE 2025) — 94.5% precision on WCAG criteria
- Univ. de Malaga (arXiv 2602.17887) — Automated remediation pipeline
- DaltonLens — CVD simulation matrices
- W3C CSS WG Issue #7387 — reading-flow gap acknowledgment
- Springer 2025 — Automated WCAG tool coverage analysis (~40%)
