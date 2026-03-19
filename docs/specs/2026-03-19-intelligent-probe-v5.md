# Intelligent Probe v5 — Design Spec

> Date: 2026-03-19
> Status: Implemented and validated (261s for 33 pages, -85% vs v4.5)
> Author: Paul + Claude
> Scope: Optimize audit pipeline (time, cost, quality) without sacrificing detection accuracy

---

## 1. Problem Statement

The v4.5 probe pipeline has performance and cost issues:

- **Time regression**: 931s (v4.3, 30 pages) → 1,734s (v4.5, 33 pages) — +86% from 3 new interactive tests
- **Cost**: ~$0.50/audit, 80%+ from LLM vision (screenshots sent without crop, no detail:low)
- **Quality gaps**: 3 Auditoria manual de referencia findings not detected (status-messages, hover-focus CSS-only, sensory-instructions URL not crawled)
- **No per-test timing**: impossible to diagnose which tests dominate execution time
- **Redundant interactions**: state-change-contrast, hover-focus, and aria-states each hover/focus the same elements independently
- **WCAG criterion mapping**: was 33.4%, fixed to 100% in commit `17c43bf` (this audit session)

### Constraints

- No fixed time target — each optimization must justify its ratio of quality/time
- No cost ceiling — but cost must be justified
- Quality gaps vs Auditoria manual de referencia are critical — must be closed for product credibility
- VPS: 4GB RAM, shared with Coolify + other services (~1.8GB available)

---

## 2. Architecture: Generalized Tier System

The existing 3-tier pattern in `wcag-color-use.ts` (DOM heuristics → CVD screenshot → LLM vision) is generalized to the entire probe phase.

```
Tier 0: MANIFEST (once per page, ~50-100ms)
  │  Single page.evaluate → Element Interaction Manifest
  │  + Accessibility tree snapshot (roles, states, names)
  │  + Element style fingerprinting (group by identical CSS)
  │  + Multi-viewport bounding boxes (1280px + 320px)
  │
Tier 1: DOM/CSSOM ANALYSIS (per style-group representative, ~1-5ms/elem)
  │  - State-change-contrast via CSSOM :hover rules (no Playwright hover)
  │  - Pseudo-heading/list/fieldset heuristics
  │  - Link underline check
  │  - Meaningful sequence (Kendall tau)
  │  - Legal checks (declaration, skip-nav)
  │  - Form field analysis (for status-messages test)
  │
  │  Output: issues[] + ambiguous elements promoted to Tier 2
  │  Amplify: representative results → entire style group
  │
Tier 2: UNIFIED INTERACTION (only elements Tier 1 couldn't resolve)
  │  Single pass per element:
  │    HOVER → read styles (state-change) + detect popup (hover-focus)
  │    FOCUS → read styles (state-change) + check indicator (focus-visibility)
  │    CLICK → verify ARIA state changes (aria-states)
  │    KEYBOARD → verify Enter/Space response (keyboard-operability)
  │
  │  - waitForFunction adaptive (not fixed waitForTimeout)
  │  - Form auto-fill + submit for status-messages
  │  - CSS transition detection (opacity/visibility/display) for hover-focus
  │
  │  Amplify: representative results → entire style group
  │
Tier 3: LLM VISION (only elements Tier 2 couldn't resolve)
  │  - Crop screenshots to element bounding box + 80px padding
  │  - Batch up to 5 crops per LLM call
  │  - Chain-of-thought specialized prompts (not raw WCAG text)
  │  - detail:low for vision tokens
  │  - Multi-viewport crops when relevant (reflow, meaningful-sequence)
  │  - Async execution via background queue + SSE push
  │  - Cache by style fingerprint (intra-audit + cross-audit)
  │  - Confidence-based early termination
```

---

## 3. Tier 0: Element Interaction Manifest

### 3.1 What it collects

A single `page.evaluate` at the start of each representative URL that gathers everything subsequent tiers need:

```typescript
interface ElementManifest {
  selector: string;           // CSS.escape'd unique selector
  tag: string;                // a, button, input, etc.
  role: string | null;        // ARIA role
  accessibleName: string;     // computed accessible name
  boundingBox: DOMRect;       // position and size

  // Style analysis
  hasHoverCss: boolean;       // :hover rules exist in CSSOM for this element
  hasAriaExpanded: boolean;
  hasAriaPressed: boolean;
  hasUnderline: boolean;      // text-decoration includes underline
  isFormControl: boolean;

  // Default state styles
  defaultStyles: {
    borderColor: string;
    outlineColor: string;
    backgroundColor: string;
    boxShadow: string;
    textDecorationLine: string;
    color: string;
  };
  parentBg: string;           // resolved parent background color

  // Style fingerprint for dedup
  styleFingerprint: string;   // hash of parentTag.parentClass + className + computed hover rules + data-* attributes
}
```

### 3.2 Style fingerprinting

Elements with identical CSS classes and hover rules produce the same interactive behavior. The manifest groups them:

```typescript
interface StyleGroup {
  fingerprint: string;
  representative: ElementManifest;  // first element in group
  members: ElementManifest[];       // all elements sharing this fingerprint
}
```

Only the representative of each group proceeds to Tier 1-2. Results are amplified to all members.

### 3.3 Multi-viewport capture (conditional)

Multi-viewport bounding boxes are captured **only when the test plan includes viewport-dependent tests** (meaningful-sequence, reflow). This avoids the expensive viewport resize (~200-500ms) on pages that don't need it.

When enabled:
- Desktop: 1280×720 (captured in main manifest evaluate)
- Mobile: 320×800 (separate viewport resize + bounding box capture)

Implementation: capture desktop manifest first. If test plan requires mobile data, then `page.setViewportSize({width: 320})`, capture mobile bounding boxes, restore desktop viewport.

### 3.4 Accessibility tree snapshot

`page.locator(':root').ariaSnapshot()` provides:
- Computed roles and names (useful for Tier 3 LLM context)
- Existing ARIA states (skip aria-states Tier 2 click if state already correct)
- Form field structure (for status-messages auto-fill)

Note: `ariaSnapshot()` can be slow on large DOM trees. If it exceeds 500ms, capture is aborted and Tier 2/3 proceed without it (graceful degradation — a11y tree data is a supplement, not a requirement).

### 3.5 Performance target

- **Without multi-viewport**: <300ms per page (single `page.evaluate` + ariaSnapshot)
- **With multi-viewport**: <800ms per page (adds viewport resize + re-capture)

These targets must be validated on 3 representative real-world pages before implementation is finalized. If benchmarks exceed targets, multi-viewport becomes optional (user opt-in in config) and ariaSnapshot gets a timeout with graceful fallback.

---

## 4. Tier 1: DOM/CSSOM Analysis

### 4.1 CSSOM hover analysis (optimistic fast-path for state-change-contrast)

**Approach**: attempt to read `:hover` rules from CSSOM before resorting to Playwright hover interaction. This is an **optimistic optimization** — elements it can resolve stay in Tier 1 (free), elements it cannot resolve promote to Tier 2 (interaction).

```typescript
// Inside page.evaluate
function getHoverRules(el: Element): Record<string, string> | null {
  const hoverProps: Record<string, string> = {};

  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules; // Throws SecurityError for cross-origin CSS
    } catch {
      return null; // Cross-origin → cannot analyze, promote to Tier 2
    }

    // Recursively traverse rules (handles @media, @layer, @container, @supports)
    // Uses a flag instead of return null to signal "promote to Tier 2",
    // since inner function return only exits the current recursion level.
    let promoteToTier2 = false;

    function traverse(ruleList: CSSRuleList) {
      for (const rule of ruleList) {
        if (promoteToTier2) break;
        if (rule instanceof CSSGroupingRule) {
          traverse(rule.cssRules); // Recurse into @media, @supports, @layer, etc.
        } else if (rule instanceof CSSStyleRule && rule.selectorText.includes(':hover')) {
          const baseSelector = rule.selectorText.replace(/:hover/g, '');
          try {
            if (el.matches(baseSelector)) {
              for (const prop of rule.style) {
                // CSS variables can't be resolved statically → promote
                if (rule.style.getPropertyValue(prop).includes('var(')) {
                  promoteToTier2 = true;
                  break;
                }
                hoverProps[prop] = rule.style.getPropertyValue(prop);
              }
            }
          } catch {
            // Invalid selector after stripping :hover (compound selectors) → promote
            promoteToTier2 = true;
          }
        }
      }
    }
    traverse(rules);
    if (promoteToTier2) return null;
  }

  return Object.keys(hoverProps).length > 0 ? hoverProps : null;
}
```

**Resolution logic per element**:
- `getHoverRules` returns properties → compare against default styles → compute contrast ratio → PASS/FAIL
- `getHoverRules` returns `null` (cross-origin, CSS variables, compound selectors) → **promote to Tier 2**

**Impact**: optimistic estimate ~30-50% of elements resolved in Tier 1 (sites with same-origin CSS). Remaining elements fall through to Tier 2 without accuracy loss. On sites with 100% CDN CSS, this optimization provides zero benefit but also zero harm.

**Known limitations that trigger Tier 2 fallback**:
- Cross-origin stylesheets (`SecurityError` on `sheet.cssRules`)
- CSS custom properties (`var(--hover-bg)`)
- Compound hover selectors (`.parent:hover .child`)
- `@media (hover: hover)` queries (traversed but match depends on runtime)
- Dynamically injected styles (not in static `document.styleSheets`)

### 4.2 Other Tier 1 tests (unchanged logic, new data source)

These tests already run as `page.evaluate` — they now consume the manifest instead of doing their own DOM queries:

- `semantic-structure`: pseudo-heading/list/fieldset heuristics
- `meaningful-sequence`: Kendall tau DOM vs visual order
- `legal-a11y`: accessibility declaration, skip-nav detection
- `target-size`: bounding box analysis
- `non-text-contrast`: axe-core (separate, not part of manifest)

### 4.3 Amplification rules (differ by tier)

**Tier 1 amplification (CSS analysis — safe to amplify):**
Tier 1 only reads static CSS properties. Elements with identical style fingerprints will have identical CSS behavior.
- FAIL: create issues for all group members (with their individual selectors)
- PASS: skip all group members for that test
- AMBIGUOUS: only promote the representative to Tier 2

**Tier 2 amplification (interaction results — restricted):**
Interaction results depend on runtime state (e.g., one accordion panel open, another closed). Two elements with identical CSS can have different ARIA states or different DOM context.
- **"no-change" (element doesn't respond to interaction)**: safe to amplify — if representative doesn't respond, members with identical CSS won't either
- **FAIL/PASS (element responded)**: do NOT amplify — each element must be tested individually in Tier 2, because runtime state differs
- Exception: if the group has >5 members and the first 3 all produce the same FAIL/PASS, apply confidence-based early termination (skip remaining, amplify the consistent result)

**Fingerprint includes parent context:**
To reduce false dedup, the style fingerprint includes the parent element's tag+class (e.g., `.sidebar a.link` vs `.main a.link` produce different fingerprints). This catches cases where identical element classes behave differently due to parent-scoped CSS selectors like `.sidebar a:hover`.

---

## 5. Tier 2: Unified Interaction Pass

### 5.1 Single loop, all tests

For each element promoted from Tier 1, one pass collects all interaction data:

```typescript
async function unifiedInteractionPass(
  page: Page,
  element: ElementManifest,
  manifest: ElementManifest[],
): Promise<InteractionResult> {
  const result: InteractionResult = {};
  const handle = await page.$(element.selector);
  if (!handle) return result;

  // 1. HOVER
  await handle.hover();
  await adaptiveWait(page, element.selector, 'hover', 200);
  result.hoverStyles = await captureStyles(page, element.selector);
  result.hoverPopup = await detectPopup(page, element, manifest);
  await page.mouse.move(0, 0);
  await adaptiveWait(page, element.selector, 'reset', 100);

  // 2. HOVER-FOCUS sub-tests (only if popup detected)
  if (result.hoverPopup) {
    result.popupPersistent = await testPersistence(page, element, 800);
    result.popupHoverable = await testHoverability(page, result.hoverPopup);
    result.popupDismissible = await testDismissibility(page, element);
  }

  // 3. FOCUS
  await handle.focus();
  await adaptiveWait(page, element.selector, 'focus', 200);
  result.focusStyles = await captureStyles(page, element.selector);
  result.focusIndicatorVisible = await checkFocusIndicator(page, element);
  result.focusPopup = await detectPopup(page, element, manifest);
  await page.evaluate(sel => {
    (document.querySelector(sel) as HTMLElement)?.blur();
  }, element.selector);

  // 4. CLICK (only if aria-expanded/pressed present AND element is safe to click)
  if (element.hasAriaExpanded || element.hasAriaPressed) {
    // Safety guard: skip elements that might trigger destructive actions
    const isSafe = await handle.evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type');
      const text = (el.textContent || '').toLowerCase();
      // Skip submit buttons, delete actions, external links
      if (tag === 'input' && type === 'submit') return false;
      if (/delete|remove|cancel|logout|sign.?out/i.test(text)) return false;
      if (tag === 'a' && el.getAttribute('target') === '_blank') return false;
      return true;
    });

    if (isSafe) {
      const before = await captureAriaStates(page, element.selector);
      await handle.click();
      await adaptiveWait(page, element.selector, 'click', 300);
      const after = await captureAriaStates(page, element.selector);
      result.ariaStateChanged = !deepEqual(before, after);
      // Reset: only click again if the element toggled (aria-expanded changed)
      if (result.ariaStateChanged && after.ariaExpanded !== before.ariaExpanded) {
        await handle.click().catch(() => {});
        await adaptiveWait(page, element.selector, 'reset', 200);
      }
    }
  }

  // 5. KEYBOARD (only if custom interactive: role=button/tab/menuitem, not native)
  if (element.role && !isNativeInteractive(element.tag)) {
    await handle.focus();
    const urlBefore = page.url();
    const originBefore = new URL(urlBefore).origin;
    await page.keyboard.press('Enter');
    await adaptiveWait(page, element.selector, 'keyboard', 300);
    const urlAfter = page.url();
    const navigated = urlAfter !== urlBefore;
    result.keyboardResponded = navigated || result.ariaStateChanged;
    if (navigated) {
      // Guard: only goBack if we stayed on the same origin
      const originAfter = new URL(urlAfter).origin;
      if (originAfter === originBefore) {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
      } else {
        // External navigation — force navigate back to original URL
        await page.goto(urlBefore, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
      }
    }
  }

  await handle.dispose();
  return result;
}
```

### 5.2 Adaptive waits (replaces waitForTimeout)

```typescript
async function adaptiveWait(
  page: Page,
  selector: string,
  trigger: string,
  maxMs: number,
): Promise<void> {
  try {
    await page.waitForFunction(
      (sel) => {
        // Check if any style transition has completed
        const el = document.querySelector(sel);
        if (!el) return true;
        const anims = el.getAnimations();
        return anims.length === 0 || anims.every(a => a.playState === 'finished');
      },
      { timeout: maxMs },
      selector,
    );
  } catch {
    // Timeout reached — proceed anyway (same as current behavior)
  }
}
```

If the style change happens in 10ms, we proceed in 10ms. The `maxMs` is a ceiling, not a fixed delay.

### 5.3 Popup detection (hover-focus CSS-only fix)

Current test only detects DOM mutations (MutationObserver). The fix adds CSS transition detection:

```typescript
async function detectPopup(
  page: Page,
  trigger: ElementManifest,
  manifest: ElementManifest[],
): Promise<PopupInfo | null> {
  // 1. Check DOM mutations (existing approach)
  // 2. NEW: Check CSS visibility changes in nearby elements
  return await page.evaluate((args) => {
    const triggerEl = document.querySelector(args.selector);
    if (!triggerEl) return null;

    // Check siblings and children for visibility changes
    const candidates = [
      ...Array.from(triggerEl.children),
      triggerEl.nextElementSibling,
      triggerEl.parentElement?.querySelector('[role="tooltip"]'),
      triggerEl.parentElement?.querySelector('[class$="-tooltip"]'),
      triggerEl.parentElement?.querySelector('[class$="-popup"]'),
      triggerEl.parentElement?.querySelector('[class$="-popover"]'),
    ].filter(Boolean);

    for (const el of candidates) {
      if (!el) continue;
      const style = getComputedStyle(el);
      // Element became visible via CSS hover
      if (style.opacity !== '0' &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          el.getBoundingClientRect().height > 0) {
        return {
          selector: /* build selector */,
          type: 'css-transition',
          boundingBox: el.getBoundingClientRect(),
        };
      }
    }
    return null;
  }, { selector: trigger.selector });
}
```

This closes **GAP 2 (hover-focus /equipo/)** — CSS `:hover` transitions on card elements will be detected.

### 5.4 Form auto-fill for status-messages

When the manifest identifies a `<form>` with required fields:

```typescript
async function autoFillAndSubmit(page: Page, formSelector: string): Promise<void> {
  const fields = await page.$$(`${formSelector} input, ${formSelector} select, ${formSelector} textarea`);

  for (const field of fields) {
    const type = await field.getAttribute('type');
    const tagName = await field.evaluate(el => el.tagName.toLowerCase());

    if (tagName === 'select') {
      await field.selectOption({ index: 1 });
    } else if (type === 'email') {
      await field.fill('test@example.com');
    } else if (type === 'tel') {
      await field.fill('+34600000000');
    } else if (type === 'checkbox' || type === 'radio') {
      await field.check().catch(() => {});
    } else if (tagName === 'textarea' || type === 'text' || !type) {
      await field.fill('Test accessibility audit');
    }
  }

  // Submit and observe
  const submitBtn = await page.$(`${formSelector} [type="submit"], ${formSelector} button:not([type="button"])`);
  if (submitBtn) {
    // MutationObserver for live regions BEFORE submit
    await page.evaluate(() => { /* setup observer */ });
    await submitBtn.click();
    await adaptiveWait(page, formSelector, 'submit', 2000); // Consistent with section 5.2
    // Check for role="alert", role="status", aria-live
  }
}
```

This closes **GAP 1 (status-messages /contacto/)**.

### 5.5 Discovery fix for /formulario/

The URL `/formulario/` was not discovered by the crawler. This is a DISCOVER phase issue, not a PROBE issue.

**Fix**: add `additionalUrls` to the audit config, seeded into the URL queue **before SCAN phase** (alongside sitemap URLs) in `pipeline.ts`:

```typescript
// In pipeline.ts, during URL queue seeding (before SCAN)
interface AuditConfig {
  maxDepth: number;
  maxPages: number;
  wcagLevel: string;
  skipSitemap: boolean;
  additionalUrls?: string[];  // NEW: manually specified URLs to include in crawl
}

// Seed additional URLs into queue alongside sitemap/link discoveries
if (config.additionalUrls?.length) {
  for (const url of config.additionalUrls) {
    const resolved = new URL(url, baseUrl).href;
    urlQueue.add(resolved, { source: 'manual', depth: 0 });
  }
}
```

These URLs go through the normal SCAN → CLASSIFY → PROBE flow like any other discovered URL. They are NOT special-cased in the probe — they get fingerprinted, clustered, and tested like everything else.

**Note**: the idea of "manifest discovers URLs with form-related text during Tier 0" is **not viable** — the pipeline is sequential (DISCOVER → SCAN → CLASSIFY → PROBE), so URLs discovered during PROBE cannot be scanned/classified. This is left as a potential future enhancement if we ever implement a feedback loop.

This closes **GAP 3 (sensory-instructions /formulario/)** for cases where the user knows the URL exists. For fully automatic discovery, a future enhancement could add a pre-crawl heuristic that follows links containing form-related keywords ("formulario", "solicitud", "contacto").

---

## 6. Tier 3: Optimized LLM Vision

### 6.1 Crop screenshots

Instead of full viewport (1280×720), crop to element bounding box + 80px padding.

**Important**: Tier 3 runs asynchronously, potentially minutes after Tier 0-2. The bounding box from the Tier 0 manifest may be stale (viewport changed, CSS injected by other tests, dynamic content loaded). Therefore, **Tier 3 must re-query the element's bounding box** at crop time using a fresh `page.evaluate`, not the cached manifest value.

```typescript
async function cropScreenshot(
  page: Page,
  selector: string,
  padding = 80,
): Promise<Buffer> {
  const { default: sharp } = await import('sharp');

  // Re-query bounding box at capture time (not from manifest — may be stale)
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);

  if (!box) return page.screenshot({ type: 'png', fullPage: false }); // fallback to full viewport

  const fullShot = await page.screenshot({ type: 'png', fullPage: false });

  const crop = {
    left: Math.max(0, Math.round(box.x - padding)),
    top: Math.max(0, Math.round(box.y - padding)),
    width: Math.min(Math.round(box.width + padding * 2), 1280),
    height: Math.min(Math.round(box.height + padding * 2), 720),
  };

  return sharp(fullShot).extract(crop).resize(400, null, { withoutEnlargement: true }).png().toBuffer();
}
```

Result: ~400×200px crop vs 800×500px full page. ~85% fewer pixels.

### 6.2 Batch crops per LLM call

Group up to 5 element crops into a single LLM call:

```typescript
async function batchLlmAnalysis(
  crops: Array<{ element: ElementManifest; cropPng: Buffer; context: string }>,
  llmClient: LLMClient,
  promptTemplate: string,
): Promise<Array<{ hasViolation: boolean; confidence: string }>> {
  const images = crops.map(c => c.cropPng.toString('base64'));
  const elementDescriptions = crops.map((c, i) =>
    `[Image ${i+1}] ${c.context}`
  ).join('\n');

  const prompt = promptTemplate.replace('{{elements}}', elementDescriptions);
  const message = buildMultimodalMessage(prompt, images);

  const response = await llmClient.chatVision([message]);
  return parseResponse(response);
}
```

Impact: 10 elements → 2 LLM calls instead of 10. ~80% less latency.

### 6.3 Chain-of-thought specialized prompts

Per ScreenAudit (CHI 2025) finding: WCAG text in prompts underperforms vs tailored heuristic descriptions.

```typescript
const PROMPTS: Record<string, string> = {
  'color-use-link': `You are analyzing links for WCAG 1.4.1 (Use of Color).

For each marked element, reason step by step:
1. What information does this element convey? (navigation target, status, etc.)
2. In the CVD simulation image, is this element still distinguishable from surrounding text?
3. Are there non-color indicators? (underline, icon, border, font weight change)
4. Conclusion: violation yes/no

Elements:
{{elements}}

Respond with JSON array: [{ "element": 1, "hasViolation": bool, "confidence": "high"|"medium"|"low", "reasoning": "one sentence" }]`,

  'color-use-status': `You are analyzing status indicators for WCAG 1.4.1...`,

  'sensory-instructions': `You are analyzing form instructions for WCAG 1.3.3...`,
};
```

### 6.4 detail:low for vision

When calling the vision model, request low detail processing:

```typescript
// In buildMultimodalMessage, add detail parameter
images.map((b64): OpenAI.ChatCompletionContentPart => ({
  type: "image_url",
  image_url: {
    url: `data:image/png;base64,${b64}`,
    detail: "low",  // NEW: reduces token cost significantly
  },
}))
```

Note: verify Moonshot supports this parameter. If not, the crop resize to 400px achieves similar token reduction.

### 6.5 Async execution with SSE

Tier 3 runs as a background queue after the main probe completes Tier 0-2.

**Queue implementation**: PostgreSQL `tier3_jobs` table (consistent with existing audit job queue pattern):

```sql
CREATE TABLE tier3_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  elements JSONB NOT NULL,        -- array of {selector, cropPath, context, promptType} (crops stored on disk, NOT base64 in JSONB)
  priority INT NOT NULL DEFAULT 2, -- 1=high confidence, 2=ambiguous, 3=false-positive check
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT
);
```

**Audit flow:**

```
DISCOVER → SCAN → CLASSIFY → PROBE (Tier 0-2)
  │
  ├→ Insert tier3_jobs rows (prioritized)
  ├→ Mark audit status: "completed-base"
  │
  └→ Tier 3 worker loop (background, same worker process):
       Pick next job: SELECT ... WHERE status='pending' ORDER BY priority
                      FOR UPDATE SKIP LOCKED LIMIT 1
       Execute batch LLM call
       Insert confirmed issues into issues table
       Push SSE event via existing audit_events mechanism

       On completion of all jobs → mark audit status: "completed"
```

**Concurrency**: 1 job at a time (rate-limited by LLM TokenBucket). No parallel Tier 3 jobs — the LLM rate limiter is the bottleneck, not the queue.

**Error handling**:
- LLM call fails after retries (circuit breaker trips) → mark job as `failed`, continue next job
- All jobs completed or failed → transition to `completed` regardless (Tier 3 failures don't block the audit)
- **Timeout**: if Tier 3 jobs haven't completed within 5 minutes of `completed-base`, auto-transition to `completed` with a note in `audit.summary.tier3Timeout = true`

**Status transitions:**
- `running` → `completed-base`: set by `pipeline.ts` after Tier 0-2 finish (replaces current `markAuditCompleted`)
- `completed-base` → `completed`: set by Tier 3 worker after all jobs done/failed/timeout

**SSE integration**: uses existing SSE mechanism via `audit_events` table (already used for progress notifications). New event types:

```typescript
// Inserted into audit_events table, pushed via existing SSE stream
{ type: "tier3:issue", data: { auditId, issue, templateId } }
{ type: "tier3:complete", data: { auditId, tier3Summary } }
```

**Crash recovery**: on worker restart, `tier3_jobs` with `status='running'` are reset to `pending` (PostgreSQL-backed, survives crashes).

**Consumer behavior for `completed-base` status:**

Existing code checks `status === "completed"` in several places. The `completed-base` status must be treated as "completed enough" by most consumers:

| Consumer | Current behavior | `completed-base` behavior |
|----------|-----------------|---------------------------|
| SSE (`sse.ts`) | Closes connection on `completed` | Close on `completed-base` too — reopen briefly for Tier 3 events if user reconnects. SSE connection must NOT stay open waiting for Tier 3. |
| Export (`export.ts`) | Only exports `completed` audits | Allow export on `completed-base` — Tier 0-2 issues are the bulk (~90%). Add header note: "Deep analysis pending" if `completed-base`. |
| LRU cache (`index.ts`) | Caches `completed` responses | Cache `completed-base` responses with shorter TTL (30s vs 5min). Re-cache as `completed` when Tier 3 finishes. |
| Frontend audit list | Shows "completed" badge | Show "Completed" badge for both. Add subtle indicator "(deep analysis...)" for `completed-base` that disappears on `completed`. |
| API `GET /api/audits/:id` | Returns status field | Returns `"completed-base"` or `"completed"` — consumers can check either. |

**Key principle**: `completed-base` is a COMPLETED audit with optional enrichment pending. It is NOT a "running" audit. Users should be able to view, export, and interact with results immediately.

### 6.6 Cache by style fingerprint

```typescript
interface Tier3CacheEntry {
  key: string;          // hash(fragment_html + computed_styles + viewport)
  result: LlmResult;
  createdAt: Date;
  auditId: string;
}
```

Lookup order:
1. **Intra-audit**: same audit, same template CSS → reuse (always valid)
2. **Cross-audit**: previous audit of same URL, same CSS hash → reuse (invalidate if CSS changed)

Storage: PostgreSQL table `tier3_cache` with TTL:
- **Intra-audit cache**: no TTL (valid for duration of audit)
- **Cross-audit cache (text analysis)**: 7 days TTL (CSS/HTML-based, stable)
- **Cross-audit cache (vision results)**: 24h TTL (visual content can change without CSS changes — images, dynamic text, third-party widgets)

### 6.7 Confidence-based early termination

If the first 3 elements of the same style group all return `confidence: "high"` with the same verdict:
- All PASS → skip remaining elements of that group for that rule
- All FAIL → create issues for remaining elements without LLM call

---

## 7. Closing Auditoria manual de referencia Gaps

| Gap | WCAG | Root Cause | Fix | Section |
|-----|------|-----------|-----|---------|
| status-messages /contacto/ | 4.1.3 | Form not filled before submit | Auto-fill + submit in Tier 2 | 5.4 |
| hover-focus /equipo/ | 1.4.13 | CSS-only transitions not detected | CSS visibility/opacity detection in Tier 2 | 5.3 |
| sensory-instructions /formulario/ | 1.3.3 | URL not discovered | `additionalUrls` config + smarter discovery | 5.5 |

---

## 8. Observability and Performance API

### 8.1 Timing data collected per URL

```typescript
interface ProbeTiming {
  auditId: string;
  templateId: string;
  url: string;

  tier0: {
    durationMs: number;
    elementsDiscovered: number;
    styleGroups: number;
    representativeElements: number;
  };

  tier1: {
    durationMs: number;
    issuesFound: number;
    elementsPromotedToTier2: number;
    skippedByFingerprint: number;
  };

  tier2: {
    durationMs: number;
    interactions: { hovers: number; focuses: number; clicks: number; keyboardTests: number };
    issuesFound: number;
    elementsPromotedToTier3: number;
    avgWaitMs: number;
  };

  tier3: {
    durationMs: number;
    llmCalls: number;
    llmInputTokens: number;
    llmOutputTokens: number;
    imagesSent: number;
    avgImageSizeBytes: number;
    issuesConfirmed: number;
    issuesDiscarded: number;
    cacheHits: number;
    earlyTerminations: number;
  };
}
```

### 8.2 Persistence

Stored in existing `audit_spans` table with `name = "probe:tier:0|1|2|3"` and metadata as JSON. No new table required.

### 8.3 API endpoint

```
GET /api/audits/:id/performance

Response:
{
  totalDurationSeconds: number,
  phases: {
    discover: { durationMs, urlsFound },
    scan: { durationMs, pagesScanned },
    classify: { durationMs, templatesCreated },
    probe: {
      durationMs: number,
      tierBreakdown: { tier0Ms, tier1Ms, tier2Ms, tier3Ms },
      savings: {
        fingerprintSkips: number,
        tier3CacheHits: number,
        earlyTerminations: number,
        estimatedTimeSaved: number,
        estimatedCostSaved: number,
      }
    }
  },
  llm: {
    totalCalls: number,
    textCalls: number,
    visionCalls: number,
    totalInputTokens: number,
    totalOutputTokens: number,
    estimatedImageTokens: number,
    estimatedCost: number,
  },
  perTemplate: Array<{
    templateId: string,
    url: string,
    tier0Ms: number,
    tier1Ms: number,
    tier2Ms: number,
    tier3Ms: number,
    issuesFound: number,
  }>
}
```

---

## 9. Research References

| Source | Year | Key Contribution Applied |
|--------|------|--------------------------|
| Univ. de Malaga (arXiv 2602.17887) | 2026 | Fragment HTML + multi-viewport + specialized prompts |
| ScreenAudit (CHI 2025) | 2025 | CoT prompts outperform raw WCAG text |
| GenA11y (UCI SEAL, FSE 2025) | 2025 | 94.5% precision, 87.6% recall baseline |
| AccessGuru | 2025 | 52% of violations invisible to axe-core |
| WebVoyager | 2024 | Set-of-Mark concept (adapted to batched crops) |
| Building Browser Agents | 2025 | A11y tree as primary, vision as selective supplement |
| Mind2Web | 2023 | Two-stage filter-then-reason approach |
| MultiUI | 2024 | Combining modalities > any single modality |

---

## 10. Files Affected

### New files
- `src/worker/manifest.ts` — Tier 0 pre-scan and style fingerprinting
- `src/worker/unified-interaction.ts` — Tier 2 single interaction pass
- `src/worker/tier3-queue.ts` — Async Tier 3 pipeline
- `src/server/routes/performance.ts` — Performance API endpoint
- `src/server/db/tier3-cache.ts` — LLM result cache

### Modified files
- `src/worker/probe.ts` — Orchestrate tiers instead of individual tests
- `src/worker/probe-context.ts` — Multi-viewport support
- `src/llm/client.ts` — Vision call tracking, detail:low, batch support
- `src/server/routes/audits.ts` — New `completed-base` status
- `src/server/routes/issues.ts` — Handle SSE tier3 issues
- `src/server/index.ts` — SSE tier3 events
- `src/server/db/schema.sql` — `tier3_cache` table, `tier3_jobs` table, `audit_spans` metadata
- `src/worker/pipeline.ts` — `additionalUrls` seeding before SCAN, `completed-base` status transition
- `src/types/pipeline.ts` — `additionalUrls` field in AuditConfig/PipelineConfig

### Deprecated files (to be removed after migration)
- Individual test orchestration in `probe.ts` (replaced by tier system)
- Standalone `waitForTimeout` calls across analyzer files

### NOT modified
- `src/analyzer/wcag-*.ts` — Test logic stays as library functions, called by tier orchestrator (note: internal `waitForTimeout` calls remain until individually refactored)
- `src/worker/scan.ts` — Scan phase unaffected

---

## 11. Estimated Impact

| Metric | Before (v4.5) | After (v5) | Improvement |
|--------|---------------|------------|-------------|
| Time (33 pages) | 1,734s | **261s** | **-85%** |
| Issues | 2,487 | **2,815** | **+13%** |
| Rules | 31 | **33** | **+2** |
| Cost per audit | ~$0.50 | ~$0.50 | 0% (Tier 3 crop/batch/cache not yet activated) |
| Cost on re-audit (same site) | ~$0.50 | ~$0.05-0.10 (est.) | -80-90% (cache, conservative) |
| Auditoria manual de referencia coverage | 81.5% | ~92-96% (est.) | +3 gaps closed |
| Issues with WCAG criterion | 100% | 100% | maintained |
| Per-test timing | none | full breakdown | new capability |
| UX perceived time | 29 min wait | instant (Tier 0-2) + Tier 3 trickle | async |

---

## 12. Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| CSSOM hover doesn't capture all CSS patterns | Medium | Some elements fall through to Tier 2 (safe) | Tier 2 is the fallback; accuracy doesn't decrease |
| Style fingerprint produces wrong dedup | Low | False negatives (missed issues) | Conservative fingerprint: include all computed hover properties |
| Async Tier 3 confuses users (partial results) | Medium | UX confusion | Clear status labels: "Base analysis complete. Deep analysis in progress..." |
| Cross-audit cache serves stale results | Low | False negatives | Hash includes fragment HTML + CSS; any change invalidates |
| Moonshot doesn't support detail:low | Medium | No cost reduction from this specific optimization | Crop resize to 400px achieves similar reduction |
| Form auto-fill triggers unwanted actions | Low | Side effects on target site | Use obviously fake data, skip if form action is external, timeout after 5s |
| Existing analyzer files still contain waitForTimeout | Low | Old waits not removed | Analyzer files are called as library functions by tier orchestrator; the orchestrator controls timing, but analyzer-internal waits remain until individually refactored |

---

## 13. Implementation Notes

- **Verify `detail:low` support in Moonshot** before implementing Section 6.4. If unsupported, crop resize to 400px is the fallback (already specified in 6.1).
- **`audit_spans` metadata**: `ProbeTiming` fields are stored in the existing `metadata JSONB` column, not as separate columns. The performance endpoint aggregates from this column.
- **Route registration**: new `performance.ts` route follows the existing pattern in `src/server/index.ts` where routes are matched by URL pattern in the main request handler.
- **Benchmark Tier 0 on real pages** before finalizing performance targets (Section 3.5). Run on example-client.com home, /contacto/, and /equipo/ as representative samples.
- **Increase `max_tokens` for batch vision calls**: current `chatVision` uses `max_tokens: 500`, which is insufficient for batch responses with 5 elements (each needs ~100 tokens for JSON). Set to `max_tokens: 1500` for batch calls, keep 500 for single-element calls.
- **Crop files stored on disk** at `reports/{auditId}/crops/{selector_hash}.png`, following the same pattern as CVD screenshots. Referenced by path in `tier3_jobs.elements` JSONB, NOT embedded as base64.
- **Estimation assumptions** for Section 11: time estimates assume ~30-50% of elements resolved by CSSOM in Tier 1 (sites with same-origin CSS), adaptive waits averaging 60% of max timeout, and 25 style groups from 33 pages. Cost assumes crop reduces vision tokens by ~70% and batch reduces LLM calls by ~60%.

---

## 14. Actual Results (2026-03-19)

Validated against example-client.com audit (33 pages).

### Overall

| Metric | v4.5 | v5 | Delta |
|--------|------|----|-------|
| Duration | 1,734s (29 min) | 261s (4.35 min) | **-85%** |
| Issues | 2,487 | 2,815 | **+13%** |
| Rules | 31 | 33 | **+2** |
| LLM cost | ~$0.50 | ~$0.50 | 0% (Tier 3 optimizations not yet activated) |

### Tier 2 Unified Interaction Pass

| Metric | Before fix | After fix |
|--------|-----------|-----------|
| Total interactions | ~640s (est.) | 52s |
| Interaction count | — | 702 |
| Avg per interaction | ~1s (fixed waits) | ~74ms (adaptive) |

### Tier 1 CSSOM Analysis

| Metric | Result |
|--------|--------|
| Elements analyzed | 351 |
| Resolved in Tier 1 | 0 |
| Promoted to Tier 2 | 351 |
| skippedByFingerprint | 0 |

**Root cause:** All CSS is cross-origin (CDN), CSSOM analysis returns null for every element. Tier 1 adds ~1s overhead with zero benefit on this site. See backlog HIGH-5.

### Performance Endpoint Data

Available at `GET /api/audits/:id/performance`. Provides:
- Phase breakdown: `discover`, `scan`, `classify`, `probe`
- Tier breakdown per template: `tier0Ms`, `tier1Ms`, `tier2Ms`, `tier3Ms`
- LLM summary: `totalCalls`, `visionCalls`, `estimatedCost`
- Savings summary: `fingerprintSkips`, `tier3CacheHits`, `earlyTerminations`
