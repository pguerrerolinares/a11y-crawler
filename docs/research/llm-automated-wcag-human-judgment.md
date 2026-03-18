# Automating "Human Judgment" WCAG Criteria with LLMs and Browser Automation

> Context: Replacing manual accessibility auditing with automated techniques for WCAG criteria traditionally considered non-automatable.
> Date: 2026-03-18
> Baseline: Comparison of Auditoria manual de referencia manual audit (example-client.com) vs a11y-crawler-v2 automated scan.

---

## 1. Background

### 1.1 The Problem

Manual accessibility audits (like Auditoria manual de referencia's report for Cliente Anonimo) cost thousands of euros, take weeks, and cover only a handful of pages. Our automated scanner (a11y-crawler-v2) covers 33+ pages with 2,596 issues detected — but misses ~25-30% of criteria that "require human judgment."

The question: **can we close that gap using LLMs, vision models, and advanced browser automation?**

### 1.2 Scope

We identified 8 WCAG criteria from the Auditoria manual de referencia report that our scanner doesn't cover, all traditionally considered to require human evaluation:

| # | WCAG | Criterion | Why "human judgment" |
|---|---|---|---|
| 1 | 1.4.1 | Use of Color | Requires understanding if color is the *only* means of conveying info |
| 2 | 1.3.3 | Sensory Characteristics | Requires understanding if instructions depend on visual context |
| 3 | 1.4.13 | Content on Hover or Focus | Requires interactive testing of 3 behavioral conditions |
| 4 | 1.3.2 | Meaningful Sequence | Requires comparing visual layout vs DOM order |
| 5 | 1.3.1 | Info and Relationships | Requires recognizing visual structures lacking HTML semantics |
| 6 | 4.1.2 | Name, Role, Value (dynamic) | Requires verifying ARIA state changes after interaction |
| 7 | 4.1.3 | Status Messages | Requires verifying live regions after form submission |
| 8 | 1.3.1/1.3.2 | Multicolumn reading order | Requires comparing column visual order vs DOM sequence |

### 1.3 Key Research Sources

| Source | Year | Key Contribution |
|---|---|---|
| ScreenAudit (CHI 2025) | 2025 | LLM-based structure/grouping detection: 83.3% precision |
| AccessGuru | 2025 | GPT-4o + Playwright pipeline: 84% violation reduction, 52% of violations invisible to axe-core |
| GenA11y (FSE 2025, UCI SEAL) | 2025 | n=37 WCAG criteria, 94.5% precision, 87.6% recall |
| Univ. de Malaga (arXiv 2602.17887) | 2026 | Multimodal remediation: 80-86% fix rate with fragment HTML + screenshots |
| Springer: WCAG tool coverage | 2025 | Automated tools detect ~40% of WCAG 2.2 issues |
| DaltonLens | 2024 | Accurate CVD simulation matrices (Machado 2009, Brettel 1997) |
| W3C CSS WG Issue #7387 | 2024 | `reading-flow` CSS property acknowledges automated reading order gap |
| Building Browser Agents (arXiv) | 2025 | Hybrid a11y tree + vision achieves ~85% success on WebGames |

---

## 2. Criterion-by-Criterion Analysis

### 2.1 WCAG 1.4.1 — Use of Color

**What it requires:** Color must not be the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.

**Why it's hard to automate:** Determining if color is the *sole* differentiator requires understanding the semantic purpose of the visual change (e.g., "red border = error" vs "red border = brand decoration").

**Current tool coverage:** Zero. axe-core checks contrast ratios (1.4.3/1.4.11) but has no rule for 1.4.1 sole-color-conveyance.

#### Proposed Approach: 3-Tier Pipeline

**Tier 1 — DOM Heuristics (zero cost, high confidence for known patterns):**

These catch the most common violations without any LLM or screenshot cost.

##### 1a. Links distinguished only by color (W3C Failure F73)

```typescript
const linkViolations = await page.evaluate(() => {
  const results = [];
  const links = document.querySelectorAll('p a, li a, td a, span a');

  for (const link of links) {
    const style = window.getComputedStyle(link);
    const textDecoration = style.getPropertyValue('text-decoration-line') ||
                           style.getPropertyValue('text-decoration');
    const hasUnderline = textDecoration.includes('underline');
    if (hasUnderline) continue;

    const fontWeight = style.getPropertyValue('font-weight');
    const fontStyle  = style.getPropertyValue('font-style');
    const border     = style.getPropertyValue('border-bottom');

    const isBold    = parseInt(fontWeight) >= 700 || fontWeight === 'bold';
    const isItalic  = fontStyle === 'italic';
    const hasBorder = border !== 'none' && border !== '' && border !== '0px';

    if (!isBold && !isItalic && !hasBorder) {
      const parent = link.parentElement;
      const parentColor = parent ? getComputedStyle(parent).color : '';
      results.push({
        href: link.href,
        text: link.textContent?.trim().slice(0, 50),
        linkColor: style.color,
        surroundingTextColor: parentColor,
        selector: link.tagName + (link.id ? `#${link.id}` : '')
      });
    }
  }
  return results;
});
```

##### 1b. Form errors indicated only by color

```typescript
const formViolations = await page.evaluate(() => {
  const results = [];
  const inputs = document.querySelectorAll(
    'input:invalid, input.error, input.is-invalid, input[aria-invalid="true"], ' +
    'select:invalid, textarea:invalid'
  );

  for (const input of inputs) {
    const hasAriaInvalid = input.getAttribute('aria-invalid') === 'true';
    const hasAriaDescribedBy = !!input.getAttribute('aria-describedby');

    const parent = input.parentElement;
    const siblings = parent ? Array.from(parent.children) : [];
    const errorTextNearby = siblings.some(sib => {
      if (sib === input) return false;
      const sibStyle = getComputedStyle(sib);
      const isVisible = sibStyle.display !== 'none' && sibStyle.visibility !== 'hidden';
      const hasText = (sib.textContent?.trim().length ?? 0) > 0;
      const isErrorElement = sib.classList.contains('error') ||
        sib.classList.contains('invalid-feedback') ||
        sib.getAttribute('role') === 'alert';
      return isVisible && hasText && isErrorElement;
    });

    if (!hasAriaInvalid && !hasAriaDescribedBy && !errorTextNearby) {
      results.push({
        inputSelector: input.name || input.id || input.type,
        inputType: input.type,
        borderColor: getComputedStyle(input).borderColor,
        likelyColorOnly: true
      });
    }
  }
  return results;
});
```

##### 1c. Required fields indicated only by color

Check if `[required]` fields have labels with colored asterisks but no textual explanation of what the asterisk means.

##### 1d. Status indicators without text

Find elements with classes like `status`, `badge`, `indicator`, `dot` that have background colors but no accessible text content, `aria-label`, or `title`.

**Tier 2 — CVD Screenshot Diff (low cost, broad detection):**

Use Chrome DevTools Protocol to simulate color vision deficiencies and compare screenshots.

```typescript
import sharp from 'sharp';
import pixelmatch from 'pixelmatch';

async function captureWithCVD(
  page: Page,
  deficiency: 'protanopia' | 'deuteranopia' | 'tritanopia' | 'achromatopsia'
): Promise<Buffer> {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setEmulatedVisionDeficiency', { type: deficiency });
  const screenshot = await page.screenshot({ fullPage: true });
  await client.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  return screenshot;
}

async function compareScreenshots(
  normalPng: Buffer,
  colorblindPng: Buffer,
  threshold = 0.1
): Promise<{ diffPixels: number; totalPixels: number; diffPercent: number; diffImage: Buffer }> {
  const { data: img1, info } = await sharp(normalPng)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: img2 } = await sharp(colorblindPng)
    .ensureAlpha().resize(info.width, info.height).raw().toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const totalPixels = width * height;
  const diffData = Buffer.alloc(totalPixels * 4);

  const diffPixels = pixelmatch(
    new Uint8Array(img1), new Uint8Array(img2),
    new Uint8Array(diffData), width, height,
    { threshold, includeAA: false, diffColor: [255, 0, 0] }
  );

  const diffImage = await sharp(diffData, {
    raw: { width, height, channels: 4 }
  }).png().toBuffer();

  return { diffPixels, totalPixels, diffPercent: (diffPixels / totalPixels) * 100, diffImage };
}
```

**Threshold interpretation:**

| Diff % | Interpretation | Action |
|---|---|---|
| < 0.5% | Rendering noise / anti-aliasing | Pass |
| 0.5% – 5% | Possible color-dependent info | Promote to Tier 3 (LLM) |
| > 5% | High confidence color dependency | Flag + include diff image |

**Chrome algorithm note:** Chrome uses Machado 2009 matrices internally. DaltonLens rates this lower in perceptual accuracy vs Brettel 1997, but for detecting *information loss* (not perceptual simulation), it is sufficient.

**Browser compatibility:**

| Deficiency | Chromium | Firefox |
|---|---|---|
| protanopia | Yes | Yes |
| deuteranopia | Yes | Yes |
| tritanopia | Yes | Yes |
| achromatopsia | Yes | Yes |

**Tier 3 — LLM Vision Confirmation (moderate cost, semantic interpretation):**

Only invoked for pages that fail Tier 2 threshold (>0.5% pixel diff).

```typescript
// Send normal + achromatopsia screenshots to vision LLM
const prompt = `You are a WCAG accessibility expert specializing in SC 1.4.1.

Image 1 is a normal screenshot. Image 2 simulates achromatopsia (complete color blindness).

Analyze both images. A violation exists when information conveyed in Image 1
is LOST or AMBIGUOUS in Image 2 because it relied solely on color:
- Links indistinguishable from regular text
- Form error/success states no longer visible
- Chart/graph legends losing meaning
- Status indicators (badges, dots) losing meaning
- Required field indicators disappearing

Do NOT flag pure aesthetic color changes with no semantic loss.

Respond with JSON: { "hasViolation": bool, "confidence": "high"|"medium"|"low",
"explanation": "one sentence", "elements": ["list of affected UI elements"] }`;
```

**Cost estimate:** ~$0.003/page with GPT-4o at `detail: low` (2 images + 500 token prompt). At 33 pages = $0.10 per audit. Negligible.

**Expected overall viability: 95%**

---

### 2.2 WCAG 1.3.3 — Sensory Characteristics (Instructions)

**What it requires:** Instructions for understanding and operating content must not rely solely on sensory characteristics (shape, color, size, visual location, orientation, sound).

**Why it's hard to automate:** Requires understanding natural language instructions like "click the red button" or "see the field on the right."

**Current tool coverage:** Zero.

#### Proposed Approach: Text Analysis (LLM)

Extract visible text from form areas and instruction blocks. Send to LLM for analysis.

```typescript
const instructionText = await page.evaluate(() => {
  const containers = document.querySelectorAll(
    'form, [role="form"], fieldset, .instructions, .help-text, ' +
    '[class*="instruction"], [class*="helper"], legend'
  );
  return Array.from(containers).map(c => ({
    text: c.textContent?.trim().slice(0, 500),
    tag: c.tagName,
    selector: c.id ? `#${c.id}` : c.className
  }));
});

// LLM prompt
const prompt = `Analyze these form instructions for WCAG 1.3.3 violations.
Flag any instruction that relies SOLELY on:
- Visual position: "above", "below", "to the right", "the field on the left"
- Color: "fields in red", "the green button"
- Shape/size: "the round icon", "the large button"
- Sound: "after the beep"

Instructions that USE these terms but also provide a non-sensory alternative are OK.
Example violation: "Fill in the fields marked in red"
Example OK: "Required fields are marked with an asterisk (*)"

Instructions to analyze:
${JSON.stringify(instructionText)}`;
```

**Expected viability: 80%** (unchanged — text analysis is straightforward for LLMs but edge cases exist with idiomatic expressions).

---

### 2.3 WCAG 1.4.13 — Content on Hover or Focus

**What it requires:** Additional content that appears on hover/focus must be:
1. **Dismissible** — closable without moving pointer/focus (e.g., Escape key)
2. **Hoverable** — pointer can move to the popup without it disappearing
3. **Persistent** — stays visible until user removes hover/focus or dismisses it

**Why it's hard to automate:** Requires simulating user interactions and observing timing-dependent UI behavior.

**Current tool coverage:** Zero. axe-core has no rule tagged `wcag1413`. No existing tool tests any of the 3 conditions. This is a confirmed research gap (Springer 2025).

**Exceptions (not in scope):**
- Native browser `title` attribute tooltips (user-agent controlled)
- Skip links revealed on focus
- Modal dialogs (focus moves into them)
- Error messages (dismissibility exempt)
- Content that doesn't overlap other content (dismissibility exempt)

#### Proposed Approach: Playwright Interaction State Machine

**Step 1 — Discover trigger candidates:**

```typescript
const triggers = await page.evaluate(() => {
  const candidates = [];

  // Explicit tooltip triggers
  document.querySelectorAll(
    '[aria-describedby], [data-tooltip], [data-tippy-content], ' +
    '[data-popover], [role="button"][aria-haspopup]'
  ).forEach(el => {
    candidates.push({
      selector: el.id ? `#${el.id}` : `${el.tagName}[${el.className}]`,
      type: 'explicit-aria',
      isNativeTitle: false
    });
  });

  // Elements with title (exempt — record but skip testing)
  document.querySelectorAll('[title]:not([data-tooltip]):not([aria-describedby])').forEach(el => {
    candidates.push({
      selector: el.id ? `#${el.id}` : el.tagName,
      type: 'native-title',
      isNativeTitle: true
    });
  });

  return candidates;
});
```

**Step 2 — Inject MutationObserver for detecting triggered content:**

```typescript
await page.addInitScript(() => {
  (window as any).__hoverContentLog = [];

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      // New elements appearing
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        const role = el.getAttribute('role');
        const isTooltipLike = role === 'tooltip' || role === 'dialog' ||
          el.classList.contains('tooltip') || el.classList.contains('popover') ||
          el.classList.contains('dropdown');
        if (isTooltipLike) {
          (window as any).__hoverContentLog.push({
            id: el.id, role, className: el.className,
            text: el.textContent?.trim().slice(0, 100),
            timestamp: Date.now()
          });
        }
      }
      // Attributes changing (display, visibility, aria-hidden)
      if (mutation.type === 'attributes') {
        const el = mutation.target as Element;
        const style = getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          const role = el.getAttribute('role');
          if (role === 'tooltip' || el.classList.contains('tooltip')) {
            (window as any).__hoverContentLog.push({
              id: el.id, role, attr: mutation.attributeName,
              timestamp: Date.now()
            });
          }
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['style', 'class', 'aria-hidden', 'hidden']
  });
});
```

**Step 3 — Test the 3 conditions:**

```typescript
async function testHoverFocusContent(page: Page, triggerSelector: string) {
  const results = { persistent: false, hoverable: false, dismissible: false };

  // --- PERSISTENT ---
  await page.hover(triggerSelector);
  await page.waitForTimeout(300); // allow transition

  const popupSelector = await page.evaluate(() => {
    const log = (window as any).__hoverContentLog;
    return log.length > 0 ? `#${log[log.length - 1].id}` : null;
  });

  if (!popupSelector) return null; // no content triggered

  // Wait 3 seconds — popup must not auto-close
  await page.waitForTimeout(3000);
  const stillVisible = await page.locator(popupSelector).isVisible();
  results.persistent = stillVisible;

  // --- HOVERABLE ---
  // Move pointer from trigger to popup
  await page.hover(triggerSelector); // re-trigger if needed
  await page.waitForTimeout(300);
  try {
    await page.hover(popupSelector);
    await page.waitForTimeout(200);
    results.hoverable = await page.locator(popupSelector).isVisible();
  } catch {
    results.hoverable = false; // popup disappeared during move
  }

  // --- DISMISSIBLE ---
  await page.hover(triggerSelector); // re-trigger
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const dismissedVisible = await page.locator(popupSelector).isVisible();
  results.dismissible = !dismissedVisible;

  // Exception check: if popup doesn't overlap other content, dismissibility not required
  if (!results.dismissible) {
    const overlaps = await page.evaluate((sel) => {
      const popup = document.querySelector(sel);
      if (!popup) return false;
      const popupRect = popup.getBoundingClientRect();
      // Check if popup overlaps any meaningful content
      const elements = document.elementsFromPoint(
        popupRect.x + popupRect.width / 2,
        popupRect.y + popupRect.height / 2
      );
      return elements.some(el => el !== popup && !popup.contains(el) &&
        el.textContent?.trim().length > 0);
    }, popupSelector);

    if (!overlaps) results.dismissible = true; // exempt
  }

  return results;
}
```

**Edge cases:**

| Scenario | Handling |
|---|---|
| CSS-only tooltips (`:hover`, no JS) | MutationObserver won't fire. Fallback: compare screenshots before/after hover for visual diff |
| `pointer-events: none` on popup | Hoverable test fails — correct, this IS a violation |
| Shadow DOM tooltips | Requires `shadowRoot` traversal in candidate discovery |
| Tooltip inside iframe | Skip (cross-origin limitation) |
| Auto-closing timer < 3s | Persistent test catches this correctly |

**Expected viability: 82%** (18% residual from CSS-only tooltips, Shadow DOM, complex component libraries)

---

### 2.4 WCAG 1.3.2 — Meaningful Sequence (CSS Reordering)

**What it requires:** When the sequence in which content is presented affects its meaning, the correct reading sequence must be programmatically determinable.

**Why it's hard to automate:** CSS `order`, `flex-direction: row-reverse`, and `grid-template-areas` can reorder content visually without changing DOM order. Automated tools don't compare visual vs DOM order.

**Current tool coverage:** Zero. Adrian Roselli (2024): "automated accessibility checkers only check tab order, not reading order of flex/grid layouts." W3C CSS WG Issue #7387 and TPAC 2024 formally acknowledge this gap.

#### Proposed Approach: Kendall Tau Correlation

Compare DOM index order vs visual position order for children of flex/grid containers. Kendall's tau coefficient measures rank correlation: tau=1.0 means perfect agreement, tau<0.8 indicates significant reordering.

```typescript
const reorderViolations = await page.evaluate(() => {
  const results = [];

  document.querySelectorAll('*').forEach(el => {
    const display = getComputedStyle(el).display;
    if (display !== 'flex' && display !== 'grid' &&
        display !== 'inline-flex' && display !== 'inline-grid') return;

    const children = Array.from(el.children)
      .filter(c => getComputedStyle(c).display !== 'none');
    if (children.length < 2) return;

    // Get DOM order indices and visual positions
    const withPos = children.map((c, domIdx) => ({
      domIdx,
      top: c.getBoundingClientRect().top,
      left: c.getBoundingClientRect().left,
      text: c.textContent?.trim().slice(0, 50)
    }));

    // Sort by visual position (top first, then left — standard reading order)
    const LINE_TOLERANCE = parseFloat(getComputedStyle(el).lineHeight) * 0.6 || 20;
    const visualOrder = [...withPos].sort((a, b) =>
      Math.abs(a.top - b.top) < LINE_TOLERANCE
        ? a.left - b.left
        : a.top - b.top
    );

    // Compute Kendall's tau
    const visualRank = new Map(visualOrder.map((item, i) => [item.domIdx, i]));
    let inversions = 0;
    for (let i = 0; i < withPos.length; i++)
      for (let j = i + 1; j < withPos.length; j++)
        if ((visualRank.get(i) ?? 0) > (visualRank.get(j) ?? 0)) inversions++;

    const maxInversions = (withPos.length * (withPos.length - 1)) / 2;
    const tau = 1 - (2 * inversions / (maxInversions || 1));

    if (tau < 0.8) {
      results.push({
        container: el.tagName + (el.id ? `#${el.id}` : `.${el.className?.split(' ')[0]}`),
        display,
        childCount: children.length,
        tau: parseFloat(tau.toFixed(2)),
        inversions,
        domOrder: withPos.map(p => p.text),
        visualOrder: visualOrder.map(p => p.text)
      });
    }
  });

  return results;
});
```

**Additional CSS property detection (fast pre-filter):**

```typescript
// Detect explicit CSS reordering properties
const cssReorderSignals = await page.evaluate(() => {
  const signals = [];
  document.querySelectorAll('*').forEach(el => {
    const style = getComputedStyle(el);
    // CSS order property (non-zero = reordered)
    if (parseInt(style.order) !== 0) {
      signals.push({ el: el.tagName, property: 'order', value: style.order });
    }
    // flex-direction reverse
    if (style.flexDirection?.includes('reverse')) {
      signals.push({ el: el.tagName, property: 'flex-direction', value: style.flexDirection });
    }
    // direction: rtl on non-RTL content (rare but possible)
    if (style.direction === 'rtl' && !document.documentElement.dir) {
      signals.push({ el: el.tagName, property: 'direction', value: 'rtl' });
    }
  });
  return signals;
});
```

**Where LLM adds value:** When reordering is detected (tau < 0.8), the LLM determines if the reordering is *semantically problematic*:

```
Prompt: "The following container has children in this DOM order: [Step 1, Step 3, Step 2].
Visually they appear as: [Step 1, Step 2, Step 3].
Is this reordering semantically meaningful? I.e., would a screen reader user
reading in DOM order get confused?"
```

A responsive layout that puts a sidebar above main content on mobile = acceptable.
Numbered steps rendered out of order = violation.

**Expected viability: 92%** (8% residual from `position: absolute/fixed` elements and animated transitions)

---

### 2.5 WCAG 1.3.1 — Info and Relationships (Semantic Structure)

**What it requires:** Information, structure, and relationships conveyed through presentation must be programmatically determinable or available in text.

**Why it's hard to automate:** Requires recognizing that something *looks like* a list/heading/table but doesn't use the correct HTML semantic element.

**Current tool coverage:** axe-core catches `heading-order`, `region`, `landmark-one-main`, `empty-heading`. But it cannot detect "this `<div>` looks like a heading" or "these sibling `<div>`s look like a list."

#### Proposed Approach: 2-Layer Heuristic + LLM

**Layer 1 — Computed Style Heuristics (zero cost, deterministic):**

##### Pseudo-heading detection

```typescript
document.querySelectorAll('div, p, span').forEach(el => {
  const cs = getComputedStyle(el);
  const fontSize = parseFloat(cs.fontSize);
  const fontWeight = parseFloat(cs.fontWeight);

  const isHeadingStyle = fontSize >= 18 ||
    (fontSize >= 14 && fontWeight >= 700);
  const textLength = el.innerText?.trim().length ?? 0;
  const notInsideHeading = !el.closest('h1,h2,h3,h4,h5,h6,[role="heading"]');
  const isShortText = textLength > 0 && textLength < 120;

  if (isHeadingStyle && isShortText && notInsideHeading) {
    // Flag: "This looks like a heading but uses <div>/<p>/<span>"
    flagPseudoHeading(el, { fontSize, fontWeight, text: el.innerText.trim() });
  }
});
```

##### Pseudo-list detection

```typescript
document.querySelectorAll('div, section').forEach(container => {
  const children = Array.from(container.children)
    .filter(c => !['UL','OL','LI','TABLE','THEAD','TBODY'].includes(c.tagName));
  if (children.length < 3) return;

  const rects = children.map(c => c.getBoundingClientRect());
  const heights = rects.map(r => r.height);
  const lefts = rects.map(r => r.left);

  const heightDelta = Math.max(...heights) - Math.min(...heights);
  const leftDelta = Math.max(...lefts) - Math.min(...lefts);

  // Uniform height + same left alignment = looks like a list
  if (heightDelta < 8 && leftDelta < 4) {
    // Check if children have similar structure (same tag composition)
    const tagPatterns = children.map(c =>
      Array.from(c.children).map(gc => gc.tagName).join(',')
    );
    const uniquePatterns = new Set(tagPatterns);

    if (uniquePatterns.size <= 2) { // repeating structure
      flagPseudoList(container, { childCount: children.length, pattern: tagPatterns[0] });
    }
  }
});
```

##### Pseudo-table detection

```typescript
// Grid layouts that look like data tables but don't use <table>
document.querySelectorAll('[style*="grid"], [class*="grid"]').forEach(container => {
  const style = getComputedStyle(container);
  if (!style.display?.includes('grid')) return;

  const columns = style.gridTemplateColumns?.split(' ').length ?? 0;
  const children = Array.from(container.children);

  if (columns >= 2 && children.length >= columns * 2) {
    // Multiple rows and columns → might be tabular data
    // Check if first row looks like headers (bold, different background)
    const firstRowChildren = children.slice(0, columns);
    const hasHeaderStyle = firstRowChildren.some(c => {
      const cs = getComputedStyle(c);
      return parseFloat(cs.fontWeight) >= 700 ||
             cs.backgroundColor !== getComputedStyle(children[columns]).backgroundColor;
    });

    if (hasHeaderStyle) {
      flagPseudoTable(container, { columns, rows: Math.floor(children.length / columns) });
    }
  }
});
```

##### Missing fieldset detection

```typescript
// Form fields that are visually grouped but lack <fieldset>
document.querySelectorAll('form, [role="form"]').forEach(form => {
  const inputs = form.querySelectorAll('input, select, textarea');
  if (inputs.length < 4) return; // too few to need grouping

  // Check for visual grouping (shared parent with border/background)
  const groups = new Map();
  inputs.forEach(input => {
    const parent = input.parentElement;
    if (!parent) return;
    const key = parent.className || parent.id || parent.tagName;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(input);
  });

  for (const [key, groupInputs] of groups) {
    if (groupInputs.length >= 2) {
      const parent = groupInputs[0].parentElement;
      const isFieldset = parent?.tagName === 'FIELDSET';
      const hasRoleGroup = parent?.getAttribute('role') === 'group';
      const hasAriaLabelledby = parent?.hasAttribute('aria-labelledby');

      if (!isFieldset && !hasRoleGroup && !hasAriaLabelledby) {
        // Flag: related form fields without <fieldset> or role="group"
        flagMissingFieldset(parent, groupInputs.length);
      }
    }
  }
});
```

**Layer 2 — LLM Visual Confirmation (for ambiguous cases only):**

Crop the flagged region from the screenshot and send to LLM:

```
Prompt: "This screenshot region contains elements that LOOK like [a list / a heading /
a data table / grouped form fields]. The HTML uses generic <div> elements without
semantic markup. Is this a genuine semantic structure that should use
[<ul>/<ol> / <h2>-<h6> / <table> / <fieldset>]?
Answer with JSON: { "isSemanticStructure": bool, "suggestedElement": "...", "confidence": "..." }"
```

**Critical finding from ScreenAudit (CHI 2025):** WCAG guideline text in prompts *underperforms* vs independently-authored heuristic descriptions. Use tailored prompts with chain-of-thought reasoning, not raw criterion text.

**Expected viability: 95%** (5% residual from card-grid UIs where visual repetition is intentional layout, not a semantic list)

---

### 2.6 WCAG 4.1.2 — Name, Role, Value (Dynamic ARIA States)

**What it requires:** For all UI components, states, properties, and values must be programmatically determinable, and notification of changes must be available to assistive technologies.

**Why it's considered "human judgment":** Auditoria manual de referencia flagged that menus and interactive controls don't expose `aria-expanded`, `aria-selected`, `aria-current` correctly. This requires interacting with the widget and verifying attribute changes.

**Current tool coverage:** axe-core checks static ARIA (missing attributes, invalid values) but cannot verify *dynamic state changes* after interaction.

#### Proposed Approach: Interaction + ARIA State Assertion (no LLM needed)

```typescript
async function testAriaStateChanges(page: Page) {
  const violations = [];

  // Find all expandable triggers
  const triggers = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll(
      'button, [role="button"], [role="tab"], [role="menuitem"], ' +
      '[aria-haspopup], [aria-expanded]'
    ).forEach(el => {
      results.push({
        selector: el.id ? `#${el.id}` : `[aria-label="${el.getAttribute('aria-label')}"]`,
        tag: el.tagName,
        role: el.getAttribute('role'),
        ariaExpanded: el.getAttribute('aria-expanded'),
        ariaHaspopup: el.getAttribute('aria-haspopup'),
        text: el.textContent?.trim().slice(0, 30)
      });
    });
    return results;
  });

  for (const trigger of triggers) {
    if (!trigger.selector) continue;

    // Record initial state
    const initialExpanded = await page.getAttribute(trigger.selector, 'aria-expanded');

    // Click the trigger
    try {
      await page.click(trigger.selector);
      await page.waitForTimeout(500);
    } catch { continue; }

    // Check if something visual changed
    const afterExpanded = await page.getAttribute(trigger.selector, 'aria-expanded');

    // If visual content appeared but aria-expanded didn't change → violation
    const contentAppeared = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const controlsId = el.getAttribute('aria-controls');
      if (controlsId) {
        const controlled = document.getElementById(controlsId);
        return controlled ? getComputedStyle(controlled).display !== 'none' : false;
      }
      // Check next sibling or commonly controlled elements
      const next = el.nextElementSibling;
      return next ? getComputedStyle(next).display !== 'none' : false;
    }, trigger.selector);

    if (contentAppeared && initialExpanded === afterExpanded) {
      violations.push({
        element: trigger.selector,
        issue: 'aria-expanded not updated after interaction',
        expected: `aria-expanded to change from "${initialExpanded}" to "${initialExpanded === 'true' ? 'false' : 'true'}"`,
        text: trigger.text
      });
    }

    // Reset state
    try {
      await page.click(trigger.selector);
      await page.waitForTimeout(300);
    } catch { /* ignore */ }
  }

  return violations;
}
```

**Playwright `toMatchAriaSnapshot()` approach (cleaner for known patterns):**

```typescript
// Tab panel pattern
const tab = page.getByRole('tab', { name: 'Services' });
await expect(tab).toMatchAriaSnapshot(`- tab "Services" [selected=false]`);
await tab.click();
await expect(tab).toMatchAriaSnapshot(`- tab "Services" [selected=true]`);

// Menu pattern
const menuBtn = page.getByRole('button', { name: 'Navigation' });
await expect(menuBtn).toMatchAriaSnapshot(`- button "Navigation" [expanded=false]`);
await menuBtn.click();
await expect(menuBtn).toMatchAriaSnapshot(`- button "Navigation" [expanded=true]`);
```

**Expected viability: 95%** (no LLM needed — pure interaction testing)

---

### 2.7 WCAG 4.1.3 — Status Messages

**What it requires:** Status messages (success, error, progress) must be programmatically determinable via role or properties so assistive technologies announce them without receiving focus.

**Implementation requirement:** Use `role="status"`, `role="alert"`, or `aria-live="polite"` / `aria-live="assertive"` on containers where dynamic messages appear.

**Current tool coverage:** Our scanner has a basic `error-identification` test. Needs extension to cover post-submit status messages broadly.

#### Proposed Approach: MutationObserver Post-Submit (no LLM needed)

```typescript
async function testStatusMessages(page: Page) {
  const forms = await page.$$('form');
  const violations = [];

  for (const form of forms) {
    // Skip payment/auth forms
    const formAction = await form.getAttribute('action') ?? '';
    if (/login|auth|payment|checkout/i.test(formAction)) continue;

    // Inject observer
    await page.evaluate(() => {
      (window as any).__statusMessages = [];
      const obs = new MutationObserver(mutations => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const el = node as Element;
            const text = el.textContent?.trim();
            if (!text || text.length < 3) continue;

            (window as any).__statusMessages.push({
              text: text.slice(0, 100),
              role: el.getAttribute('role'),
              ariaLive: el.getAttribute('aria-live'),
              tag: el.tagName,
              className: el.className
            });
          }
          // Attribute changes (hidden → visible)
          if (m.type === 'attributes' && m.target.nodeType === Node.ELEMENT_NODE) {
            const el = m.target as Element;
            const style = getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              const text = el.textContent?.trim();
              if (text && text.length > 3) {
                (window as any).__statusMessages.push({
                  text: text.slice(0, 100),
                  role: el.getAttribute('role'),
                  ariaLive: el.getAttribute('aria-live'),
                  tag: el.tagName,
                  isAttributeChange: true
                });
              }
            }
          }
        }
      });
      obs.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden']
      });
    });

    // Submit form (empty, to trigger validation)
    try {
      await form.evaluate(f => {
        const btn = f.querySelector('button[type="submit"], input[type="submit"], button:last-of-type');
        if (btn) (btn as HTMLElement).click();
      });
      await page.waitForTimeout(1000);
    } catch { continue; }

    // Check messages
    const messages = await page.evaluate(() => (window as any).__statusMessages);

    for (const msg of messages) {
      const hasLiveRegion = msg.role === 'alert' || msg.role === 'status' ||
                           msg.ariaLive === 'polite' || msg.ariaLive === 'assertive';
      if (!hasLiveRegion) {
        violations.push({
          message: msg.text,
          element: msg.tag,
          className: msg.className,
          issue: 'Status message appeared without role="alert", role="status", or aria-live'
        });
      }
    }
  }

  return violations;
}
```

**Expected viability: 90%** (no LLM needed)

---

### 2.8 WCAG 1.3.1/1.3.2 — Multicolumn Reading Order

Same approach as 2.4 (Kendall tau). The specific Auditoria manual de referencia finding was:
- Main content + aside columns where the aside appears after all content in DOM but visually beside it
- Grid layouts where image/text pairs are reordered on mobile

Covered by the Kendall tau algorithm above. Also test at multiple viewports:

```typescript
// Test at desktop (1280px) and mobile (320px) viewports
for (const width of [1280, 320]) {
  await page.setViewportSize({ width, height: 800 });
  const violations = await checkMeaningfulSequence(page);
  // Report with viewport context
}
```

**Expected viability: 92%** (same as 2.4)

---

## 3. Implementation Architecture

### 3.1 Where Each Test Fits in the Pipeline

```
                                ┌──────────────────────┐
                                │   Page loaded in      │
                                │   Playwright browser   │
                                └──────────┬───────────┘
                                           │
                    ┌──────────────────────┤──────────────────────┐
                    │                      │                      │
              ┌─────▼─────┐         ┌─────▼─────┐         ┌─────▼─────┐
              │  Tier 1    │         │  Tier 2    │         │  Tier 3    │
              │  DOM-only  │         │ Interaction│         │ Screenshot │
              │  (free)    │         │  (free)    │         │ + LLM      │
              └─────┬─────┘         └─────┬─────┘         └─────┬─────┘
                    │                      │                      │
         ┌──────────┤              ┌──────┤              ┌──────┤
         │          │              │      │              │      │
    1.3.1      1.3.2         1.4.13  4.1.2         1.4.1  1.3.1
   pseudo-   Kendall        hover   ARIA           CVD   ambiguous
   heading    tau            state   states        diff    crops
   pseudo-   CSS props      machine                LLM
    list                    4.1.3                  confirm
   pseudo-                  status
    table                   messages
   missing                  1.3.3
   fieldset                 text
                            analysis
```

### 3.2 Cost Estimates Per Audit (33 pages)

| Tier | Tests | LLM Cost | Time Added |
|---|---|---|---|
| Tier 1 (DOM) | 1.3.1 heuristics, 1.3.2 CSS props | $0.00 | ~1s/page |
| Tier 2 (Interaction) | 1.4.13, 4.1.2, 4.1.3, 1.3.2 Kendall tau | $0.00 | ~5-10s/page |
| Tier 3 (Screenshot+LLM) | 1.4.1 CVD, 1.3.1 ambiguous, 1.3.3 | ~$0.10-0.30/audit | ~2-3s/page |

**Total additional cost per audit: ~$0.10-0.30 (LLM) + ~3-5 min extra time**

### 3.3 Dependencies

| Package | Purpose | Install |
|---|---|---|
| `sharp` | PNG → raw pixels for comparison | `bun add sharp` |
| `pixelmatch` | Pixel-level screenshot diff | `bun add pixelmatch` |
| Playwright CDP | `Emulation.setEmulatedVisionDeficiency` | Already available |
| LLM (Moonshot/OpenAI) | Vision + text analysis | Already integrated |

---

## 4. Updated Viability Summary

| # | WCAG | Criterion | Before | After | Delta | Primary Technique |
|---|---|---|---|---|---|---|
| 1 | 1.4.1 | Use of Color | 85% | **95%** | +10pp | DOM heuristics + CVD diff + LLM |
| 2 | 1.3.3 | Sensory Characteristics | 80% | **80%** | — | LLM text analysis |
| 3 | 1.4.13 | Content on Hover/Focus | 60% | **82%** | +22pp | Playwright state machine |
| 4 | 1.3.2 | Meaningful Sequence | 75% | **92%** | +17pp | Kendall tau |
| 5 | 1.3.1 | Info and Relationships | 85% | **95%** | +10pp | computedStyle heuristics + LLM |
| 6 | 4.1.2 | Name, Role, Value (dynamic) | 95% | **95%** | — | Interaction + ARIA assertion |
| 7 | 4.1.3 | Status Messages | 90% | **90%** | — | MutationObserver post-submit |
| 8 | 1.3.1/2 | Multicolumn Order | 75% | **92%** | +17pp | Kendall tau + multi-viewport |

**Weighted average viability: ~90% (up from ~78%)**

---

## 5. Competitive Landscape

| Feature | axe-core | pa11y | WAVE | Auditoria manual de referencia (manual) | **a11y-crawler-v2 (proposed)** |
|---|---|---|---|---|---|
| 1.4.1 Use of Color | No | No | No | Yes (manual) | **Yes (CVD + LLM)** |
| 1.4.13 Hover/Focus | No | No | No | Yes (manual) | **Yes (state machine)** |
| 1.3.2 CSS Reorder | No | No | No | Yes (manual) | **Yes (Kendall tau)** |
| 1.3.1 Pseudo-elements | Partial | No | Partial | Yes (manual) | **Yes (heuristics + LLM)** |
| 4.1.2 Dynamic ARIA | No | No | No | Yes (manual) | **Yes (interaction)** |
| 4.1.3 Status Messages | No | No | No | Yes (manual) | **Yes (MutationObserver)** |
| Pages per audit | 1 | 1 | 1 | 5-10 | **33+ (crawl)** |
| Cost | Free | Free | Free | Thousands of euros | **~$0.30/audit** |

**Key differentiator:** No existing automated tool implements ANY of the 6 new tests proposed here. This would make a11y-crawler-v2 the first automated scanner to cover criteria traditionally reserved for manual auditing.

---

## 6. References

### Papers

- ScreenAudit: Detecting Screen Reader Accessibility Errors in Mobile Apps Using LLMs. CHI 2025. https://dl.acm.org/doi/10.1145/3706598.3713797
- AccessGuru: Leveraging LLMs to Detect and Correct Web Accessibility Violations. 2025. https://arxiv.org/html/2507.19549v1
- GenA11y: Enhancing Web Accessibility with Generative AI. UCI SEAL, FSE 2025. https://seal.ics.uci.edu/publications/2025_FSE_GenA11y.pdf
- Turning manual WCAG criteria into automatic: an LLM-based approach. Springer 2024. https://link.springer.com/article/10.1007/s10209-024-01108-z
- Coverage of WCAG guidelines by automated checking tools. Springer 2025. https://link.springer.com/article/10.1007/s10209-025-01263-x
- Automated LLM-Based Accessibility Remediation. Univ. de Malaga, 2026. https://arxiv.org/abs/2602.17887

### Standards

- W3C Understanding SC 1.4.1: https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html
- W3C Understanding SC 1.4.13: https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html
- W3C SCR39 (hover/focus technique): https://www.w3.org/WAI/WCAG22/Techniques/client-side-script/SCR39
- W3C F73 (color-only links failure): https://www.w3.org/WAI/WCAG21/Techniques/failures/F73
- W3C CSS WG reading-flow: https://github.com/nicjohnson145/w3c-csswg-drafts/issues/7387

### Tools & Libraries

- DaltonLens CVD simulation: https://daltonlens.org/opensource-cvd-simulation/
- DaltonLens SVG filters: https://daltonlens.org/cvd-simulation-svg-filters/
- pixelmatch: https://github.com/mapbox/pixelmatch
- Playwright CDP API: https://playwright.dev/docs/api/class-cdpsession
- Playwright Aria Snapshots: https://playwright.dev/docs/aria-snapshots
