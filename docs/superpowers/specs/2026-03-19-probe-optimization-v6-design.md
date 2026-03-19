# Probe Optimization v6 — Design Spec

**Date**: 2026-03-19
**Status**: Approved
**Goal**: Reduce RAM usage and audit time without sacrificing accessibility detection quality.

## Context

v5 (Intelligent Probe) reduced audit time from 29 min to 4.35 min (85% faster) for 33 pages. However, the "Resto" phase (scan + classify + axe + viewport + interactive tests) still consumes ~207s (79.4%) of the 261s total.

### Current Performance Breakdown (example-client.com, 33 pages)

| Phase | Duration | % total |
|-------|----------|---------|
| Tier 0 (manifest) | 743ms | 0.3% |
| Tier 1 (CSSOM) | 1.1s | 0.4% |
| Tier 2 (interaction) | 52s | 19.9% |
| Tier 3 (LLM vision) | 0ms | 0% |
| Resto (scan+classify+axe+viewport+interactive) | ~207s | 79.4% |

### Constraints

- **VPS**: 4GB RAM, ~1.8GB available. RAM reduction is priority #1.
- **Quality**: Must maintain or improve current accessibility detection coverage.
- **SPA support**: Must work on React, Angular, Vue sites (rules out JSDOM hybrid).
- **No pipeline**: 2-page pipeline deferred due to ProbeContextManager recycling complexity.

## Phase 1: RAM Reduction

No architecture changes. Immediate wins based on Playwright community best practices.

### 1.1 — Reduce `pagesPerContext` in scan from 25 to 5

**Problem**: Playwright issue [#6319](https://github.com/microsoft/playwright/issues/6319) confirms `BrowserContext` accumulates request/response/route metadata that is **never freed by `page.close()`** — only by `context.close()`. With 25 pages per context, each slot accumulates metadata from ~25 navigations before recycling.

**Change**: `src/types/pipeline.ts` — change `DEFAULT_PIPELINE_CONFIG.pagesPerContext` from 25 to 5. This value is consumed by `SlotPool` in `scan.ts:33`. Note: `probePagesPerContext` is already 5 — no change needed for probe.

**Impact**: ~50-150MB less heap accumulation during scan (3 concurrent slots × less accumulated metadata per context). ~1.2s extra time (6 extra context recycles × ~200ms each).

### 1.2 — Chrome launch flags for VPS

**Problem**: `chromium.launch({ headless: true })` at `src/worker/index.ts:14` passes no optimization flags. On VPS with limited `/dev/shm` (64MB default in Docker), Chromium can crash silently on large DOM pages.

**Change (local dev)** — `src/worker/index.ts:14`:
```typescript
chromium.launch({
  headless: true,
  args: [
    '--disable-dev-shm-usage',  // use /tmp instead of /dev/shm
    '--disable-gpu',             // no GPU in headless
    '--no-zygote',               // reduce subprocess memory on Linux
  ]
})
```

**Change (production Browserless)**: The `chromium.connect(BROWSERLESS_URL)` call at line 22 does NOT accept `args`. Chrome flags for Browserless must be configured in the Docker container environment via `DEFAULT_LAUNCH_ARGS` or `CHROME_FLAGS` in the Coolify/Docker Compose config. Document this in the deployment guide.

**Impact**: Prevents silent crashes, reduces Chromium subprocess overhead.

### 1.3 — Nullify response objects in scan

**Problem**: `scan.ts:49` — `response` object retains Playwright internal metadata. While response bodies are lazy-loaded (not buffered), the object itself holds references that contribute to context-level memory accumulation.

**Change**: Set `response = null` after status code check in `scan.ts`. Minor hygiene improvement — most memory savings come from context recycling (1.1).

**Impact**: Negligible in isolation, but good practice for long-running sessions.

### 1.4 — axe-core `setLegacyMode(true)`

**Problem**: Each `AxeBuilder.analyze()` internally creates a **temporary blank page** for `finishRun()` (cross-frame aggregation). The crawler only tests same-origin pages, not cross-origin iframes.

**Change**: Add `.setLegacyMode(true)` to all `AxeBuilder` calls in `scan.ts` and `probe.ts`. Requires `@axe-core/playwright >= 4.4` — verify installed version before implementing.

**Impact**: Eliminates 1 phantom page per `analyze()` call = ~33 during scan + 25 during probe.

**Trade-off**: Cross-origin iframes (typically ads/analytics) are not tested. Acceptable for WCAG auditing.

### 1.5 — Screenshots CVD direct to disk

**Problem**: `testColorUse` generates PNG buffers in memory (~200-500KB each, 4 screenshots per template with CVD = ~2MB per template). With 25 templates, that's ~50MB of buffers.

**Change**: This spans two files: (a) modify `testColorUse` in `src/analyzer/wcag-color-use.ts` to accept an output directory parameter and use `page.screenshot({ path })` directly, and (b) update `probe.ts:170-175` to pass the directory instead of calling `Bun.write()` on returned buffers. The `ColorUseResult` interface changes accordingly (screenshots become file paths instead of `Buffer` objects).

### 1.6 — GC hint between context recycles

**Change**: Use incremental GC in `slot-pool.ts` after `context.close()` to avoid blocking concurrent slots:
```typescript
if (typeof Bun !== 'undefined') Bun.gc(false); // incremental, non-blocking
```
Reserve full synchronous GC (`Bun.gc(true)`) for phase boundaries in `pipeline.ts` (scan→classify, classify→probe) where no concurrent work is running.

### Phase 1 Summary

| Change | RAM impact | Time impact |
|--------|-----------|-------------|
| pagesPerContext 25→5 | -50-150MB | +1.2s |
| Chrome flags (local + Browserless) | Prevents crashes | Neutral |
| Nullify response | Negligible | Neutral |
| setLegacyMode | -50-100MB | -1-2s |
| Screenshots to disk | -50MB peak | Neutral |
| GC hints (incremental + phase boundary) | Variable | Neutral |
| **Total** | **~-150-300MB** | **~0s** |

## Phase 2: Eliminate Redundant Work

### 2.1 — Move axe-full to scan, eliminate axe-light

**Problem**: axe-core runs twice per representative page:
1. `scan.ts:132`: axe-light (5 rules) on all 33 pages
2. `probe.ts:87`: axe-full (all WCAG AA rules) on 25 templates, **sequentially**

The 25 representatives are a subset of the 33 scanned pages — we navigate to each twice.

**Change**:
- In `scan.ts`: replace `AXE_LIGHT_RULES` with axe-full (`withTags(wcagTags)`)
- Store full axe results in `ScanResult` (field: `axeIssues: Issue[]`)
- In `probe.ts`: if representative URL has cached axe results from scan, reuse them
- Keep `runAxeFull()` as fallback for URLs not in scan cache (edge case)
- Change `checkSource` from `"scan-light"` to `"axe"`
- Add dedup logic in probe to avoid double-inserting axe issues

**Time impact**:
- Scan increases ~20-30s (axe-full takes 2-4s/page vs ~1.5s for light; with concurrency=3, the increase is amortized but significant due to CPU contention between 3 concurrent axe evaluations)
- Probe decreases ~62s (25 × ~2.5s of axe-full eliminated)
- **Net: ~32-42s saved**

**RAM consideration**: Storing full axe results for 33 pages in `ScanResult` increases memory during scan. Each axe-full result is ~50-200KB JSON. Mitigation: persist to DB immediately during scan (already done for light issues), then in probe look up from DB instead of holding in memory. This avoids contradicting Phase 1 RAM goals.

**Cache key invariant**: `cluster.representative` uses the post-redirect `finalUrl` from scan (set at `scan.ts:88`). Cache lookups must use the same normalized URL. Add explicit URL normalization if redirects produce different paths (e.g., trailing slash).

**Quality impact**: Identical — same rules, same results, different execution location. Consider reducing scan concurrency to 2 when running axe-full if CPU contention causes timeouts on large DOM pages.

### 2.2 — Short-circuit Tier 1 on cross-origin CSS (HIGH-5)

**Problem**: On example-client.com, Tier 1 CSSOM resolved 0/351 elements because CSS is cross-origin. All promoted to Tier 2 — 1.1s wasted. Most modern sites using CDN-served CSS have this issue.

**Change** in `src/worker/tier1.ts`:
```typescript
const hasAccessibleCSS = await page.evaluate(() => {
  return Array.from(document.styleSheets).some(s => {
    try { s.cssRules; return true; } catch { return false; }
  });
});
if (!hasAccessibleCSS) {
  timer.endTier("tier1", { skipped: true, reason: "cross-origin-css" });
  return { issues: [], promotedElements: allElements };
}
```

**Time impact**: ~1s saved on cross-origin CSS sites (saves full CSSOM traversal). More importantly: eliminates useless overhead and simplifies logs.

### 2.3 — Remove duplicate keyboard-operability from legacy

**Prerequisites** (must be implemented first):
1. Add `[onclick]` to manifest selector (`manifest.ts`) — the legacy test discovers `<div onclick="...">` without ARIA role, but the manifest doesn't. Without this fix, removing the legacy test loses detection of onclick-without-role elements.
2. Add focusability pre-check in `evaluateKeyboard()` (`tier2.ts`) — the legacy test detects non-focusable custom elements (no tabindex) as CRITICAL. Tier 2 silently fails `focus()` and moves on.

**Change**: After prerequisites are merged, remove `testKeyboardOperability` from `runInteractiveTests()` in `src/analyzer/interactive.ts`. Keep `testTabOrder`, `testFocusVisibility`, `testSkipNavigation`.

**Time impact**: ~15-25s saved (depends on how many templates include "interactive" in testPlan).

### Phase 2 Summary

| Change | Time saved | Risk |
|--------|-----------|------|
| axe-full in scan | ~32-42s | Low |
| Short-circuit Tier 1 | ~1s | Minimal |
| Remove keyboard duplicate | ~15-25s (deferred to Phase 3 — requires prereq fixes) | Low |
| **Total (Phase 2 only)** | **~33-43s** | — |

## Phase 3: Restructure Probe into 4 Phases

### Motivation

Current `probe.ts` is a ~120-line monolithic sequential block mixing read-only analysis, element interaction, viewport mutation, and visual capture. The tier system covers only hover/focus/click, while legacy tests are interleaved without clear organization.

The restructure separates by **DOM mutation profile**:

### Architecture: 4 Phases

```
┌──────────────┬──────────────────────────────────────────────────┐
│ Phase 1      │ STATIC (does not mutate DOM)                     │
│ "Read-only"  │ • Tier 0: Manifest (+ [onclick] selector)        │
│              │ • Tier 1: CSSOM (+ short-circuit cross-origin)    │
│              │ • axe-core (from scan cache)                      │
│              │ • testErrorIdentification (clean form state)      │
│              │ • 7× evaluate tests (Promise.all)                 │
│              │ • testSensoryInstructions (LLM text)              │
├──────────────┼──────────────────────────────────────────────────┤
│ Phase 2      │ INTERACTION (mutates DOM per-element/global)      │
│ "Touch"      │ • Tier 2 (+ focusability pre-check)              │
│              │ • testTabOrder                                    │
│              │ • testFocusVisibility                             │
│              │ • testSkipNavigation                              │
├──────────────┼──────────────────────────────────────────────────┤
│ Phase 3      │ VIEWPORT (mutates viewport/CSS)                   │
│ "Layout"     │ • testReflow (setViewportSize 320px)             │
│              │ • testResizeText (zoom 200%)                      │
│              │ • testTextSpacing (CSS injection)                 │
│              │ • Sequential — not batchable (Playwright API)     │
├──────────────┼──────────────────────────────────────────────────┤
│ Phase 4      │ CAPTURE + ASYNC                                   │
│ "Visual"     │ • Defensive viewport reset (1280×720)            │
│              │ • testColorUse (CVD screenshots)                  │
│              │ • testStatusMessages (MutationObserver)           │
│              │ • Tier 3 job queue (async)                        │
└──────────────┴──────────────────────────────────────────────────┘
```

### Key Design Decisions

**testErrorIdentification in Phase 1, not Phase 2**: It uses `checkValidity()` / `reportValidity()` (form state mutation, not keyboard). The `:invalid` pseudo-class persists after validation, so it must run before interactive tests that read focus/hover styles. The existing comment in `probe.ts:92` says "must run before interactive tests."

**testSkipNavigation in Phase 2**: Although it's mostly read-only (checks if skip link exists), it logically groups with keyboard navigation tests. The skip link target verification is a DOM query, not a mutation — safe to run alongside focus tests.

**Viewport tests remain sequential**: `testReflow` and `testResizeText` both use `page.setViewportSize()` (Playwright API, not DOM). CSS-based batching is not possible. `testTextSpacing` is pure `page.evaluate` but depends on restored viewport state.

**Defensive viewport reset before Phase 4**: Phase 3 modifies viewport. Color-use screenshots need the original 1280×720 viewport. Explicit `page.setViewportSize({ width: 1280, height: 720 })` at Phase 4 start ensures clean state regardless of Phase 3 exit path.

### Bug Fixes Included

#### Fix 1: Add `[onclick]` to manifest selector

**File**: `src/worker/manifest.ts`
**Problem**: `collectManifest()` discovers interactive elements by role/tag but misses `<div onclick="...">` without ARIA role. These elements are invisible to Tier 2 but were caught by the legacy `testKeyboardOperability`.

**Change**: Add `[onclick]:not(a):not(button):not(input):not(select):not(textarea)` to the manifest selector.

#### Fix 2: Focusability pre-check in Tier 2

**File**: `src/worker/tier2.ts`
**Problem**: `evaluateKeyboard()` calls `element.focus()` which silently fails on non-focusable elements. The legacy test detected this and reported `custom-element-not-focusable` as CRITICAL.

**Change**: Before keyboard evaluation, check if element is focusable (has tabindex, is natively focusable, or has contenteditable). If not focusable but has interactive role/onclick, emit `custom-element-not-focusable` issue.

#### Fix 3: Implement hover-focus sub-tests in Tier 2

**File**: `src/worker/tier2.ts`
**Problem**: The v5 spec says Tier 2 evaluates popup persistence, hoverability, and dismissibility. But in the actual code, `detectPopup()` is called but the fields `popupPersistent`, `popupHoverable`, `popupDismissible` are never set. This explains the open gap from the Auditoria manual de referencia comparison (hover-focus in `/equipo/`).

**Change**: After `detectPopup()` detects a popup, implement the 3 WCAG 1.4.13 sub-tests:
1. **Persistence**: Move mouse away, wait 300ms, check if popup still visible
2. **Hoverability**: Move mouse to popup element, check if it remains
3. **Dismissibility**: Press Escape, check if popup closes

**Important**: The main Tier 2 hover loop uses `dispatchEvent('mouseover')` (commit `7c93d0c`) which does NOT move the real mouse pointer. These sub-tests genuinely need pointer movement to test persistence/hoverability, so they must use `page.mouse.move(x, y)` to position the pointer over/away from the popup. This is intentionally different from the dispatchEvent approach used for style capture — the sub-tests are testing real mouse interaction behavior, not just CSS state changes.

#### Fix 4: disableAnimations cleanup between phases

**Problem**: `disableAnimations()` injects CSS `* { animation: none !important; transition: none !important; }` for Tier 2. If not cleaned up, it affects Phase 3 viewport tests and Phase 4 screenshots.

**Change**: Call `enableAnimations()` at the boundary between Phase 2 and Phase 3.

### Feature Flag Rollback

The restructured probe runs behind a feature flag:

```typescript
// src/worker/probe.ts
const USE_PHASED_PROBE = process.env.PROBE_V2 !== "false"; // default: enabled

if (USE_PHASED_PROBE) {
  await runProbePhaseV2(page, cluster, ...);
} else {
  await runProbePhaseLegacy(page, cluster, ...); // current code, unchanged
}
```

This allows instant rollback in production if issues are discovered.

### Phase 3 Summary

| Change | Time saved | Risk |
|--------|-----------|------|
| Remove testKeyboardOperability (after fixes) | ~15-25s | Low (after prereqs) |
| Short-circuit Tier 1 cross-origin | ~30s | Minimal |
| disableAnimations cleanup | 0s (correctness) | Low |
| hover-focus sub-tests | 0s (quality fix) | Medium |
| Code maintainability | Indirect | Low |
| **Total** | **~45-55s** | — |

Note: The keyboard-operability savings are counted here (in the restructure) rather than in Phase 2, because the prerequisite fixes are part of this restructure.

## Projected Results

### Time

| | Current | +Phase 1 (RAM) | +Phase 2 (Redundancy) | +Phase 3 (Restructure) |
|---|---|---|---|---|
| **Duration** | 261s | 261s | ~218-228s | **~173-193s** |
| **Improvement** | — | 0% | -13-17% | **-26-34%** |

Note: Phase 2 saves ~33-43s. Phase 3 saves ~45-55s (includes keyboard-operability removal). Estimates are conservative — actual savings depend on site complexity and template count.

### RAM

| | Current | +Phase 1 |
|---|---|---|
| **Peak RAM** | ~1.2GB | **~900MB-1.05GB** |
| **Improvement** | — | **-13-25%** |

### Quality

| | Current | After v6 |
|---|---|---|
| axe-core coverage | Same | Same (moved, not changed) |
| keyboard-operability | Duplicate detection | Single source, no gaps |
| hover-focus (WCAG 1.4.13) | **Gap**: persistence/hoverability/dismissibility not tested | **Fixed** |
| onclick without role | Detected by legacy only | Detected by manifest + Tier 2 |
| Non-focusable custom elements | Detected by legacy only | Detected by Tier 2 pre-check |

## Implementation Order

1. **Add `[onclick]` to manifest** — 1 line, closes detection gap
2. **Add focusability pre-check in Tier 2** — ~10 lines
3. **Short-circuit Tier 1 on cross-origin CSS** — ~5 lines
4. **Implement hover-focus sub-tests in Tier 2** — closes Auditoria manual de referencia comparison gap
5. **Phase 1 RAM optimizations** (1.1-1.6) — independent, can parallelize
6. **Phase 2: axe-full in scan** — requires scan.ts + probe.ts changes + dedup logic
7. **Restructure probe.ts into 4 phases** — refactor with feature flag
8. **Remove testKeyboardOperability** — safe after steps 1-2
9. *(Deferred)* Pipeline de 2 páginas — requires per-template profiling to justify

## Deferred: 2-Page Pipeline

Not included in v6. Reasons:
- ProbeContextManager recycles a single BrowserContext every 5 pages. Two concurrent pages would require redesigning the context lifecycle.
- Cookie/localStorage contamination between templates sharing a context.
- Real savings estimated at 15-25s (not 48-72s as initially proposed).
- Complexity: ~1 week of work for modest gains.

**Revisit when**: per-template profiling data justifies the investment.

## Research Sources

- Playwright [#6319](https://github.com/microsoft/playwright/issues/6319) — context memory accumulation (confirmed by maintainers)
- Playwright [#17602](https://github.com/microsoft/playwright/issues/17602) — `page.close()` does not free context memory
- [Browserless production best practices](https://docs.browserless.io/enterprise/docker/best-practices) — `--disable-dev-shm-usage` critical for VPS
- [@axe-core/playwright README](https://github.com/dequelabs/axe-core-npm/blob/develop/packages/playwright/README.md) — `setLegacyMode` documentation
- [axe-core-npm #1086](https://github.com/dequelabs/axe-core-npm/issues/1086) — ~3 MiB per analyze() call
- Pa11y-CI [#147](https://github.com/pa11y/pa11y-ci/issues/147) — concurrency=1 default rationale
- [Playwright MCP 2025 benchmarks](https://markaicode.com/playwright-mcp-memory-leak-fixes-2025/) — 37% reduction with proper lifecycle
- JSDOM [#653](https://github.com/jsdom/jsdom/issues/653), [#135](https://github.com/jsdom/jsdom/issues/135) — getBoundingClientRect/offsetWidth always zero (rules out JSDOM hybrid)
- axe-core [#595](https://github.com/dequelabs/axe-core/issues/595) — color-contrast broken in JSDOM
