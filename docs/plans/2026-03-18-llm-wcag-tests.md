# LLM-Augmented WCAG Tests Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3 WCAG tests that use LLM vision and text analysis to detect criteria traditionally requiring human judgment: 1.4.1 (Use of Color via CVD simulation), 1.3.3 (Sensory Characteristics), and 1.3.1 Layer 2 (semantic structure confirmation via screenshots).

**Architecture:** 3-tier approach for 1.4.1 (DOM heuristics → CVD screenshot diff → LLM vision confirmation). Text-only LLM for 1.3.3. Screenshot crop + LLM for 1.3.1 ambiguous cases. All use existing `LLMClient` with `buildMultimodalMessage()`. A new vision model config is added for screenshot analysis since `kimi-k2-turbo-preview` doesn't support images.

**Tech Stack:** TypeScript, Playwright, Chromium CDP (`Emulation.setEmulatedVisionDeficiency`), sharp, pixelmatch, Moonshot vision API (`moonshot-v1-32k-vision-preview`)

**Dependencies to install:** `sharp`, `pixelmatch`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/llm/client.ts` | Modify | Add vision model support (separate model for image calls) |
| `src/types/pipeline.ts` | Modify | Add `"color-use"`, `"sensory-instructions"` TestType |
| `src/analyzer/classify.ts` | Modify | Add new tests to `buildTestPlan()` |
| `src/analyzer/category.ts` | Modify | Add rule→category mappings |
| `src/analyzer/wcag-color-use.ts` | Create | WCAG 1.4.1 — 3-tier color detection |
| `src/analyzer/wcag-sensory-instructions.ts` | Create | WCAG 1.3.3 — LLM text analysis |
| `src/analyzer/wcag-semantic-structure.ts` | Modify | Add Layer 2 LLM confirmation for ambiguous cases |
| `src/worker/probe.ts` | Modify | Wire new tests + pass LLMClient |
| `src/analyzer/__tests__/wcag-color-use.test.ts` | Create | Unit tests for DOM heuristics + pixelmatch |

---

## Task 1: Install Dependencies + Vision Model Config

**Files:**
- Modify: `package.json` (via bun add)
- Modify: `src/llm/client.ts`
- Modify: `src/worker/index.ts`

- [ ] **Step 1: Install sharp and pixelmatch**

```bash
bun add sharp pixelmatch
bun add -d @types/sharp
```

Note: `pixelmatch` ships with types. `sharp` needs `@types/sharp` for TS.

- [ ] **Step 2: Add vision model support to LLMClient**

Add a `visionModel` field to `LLMConfig` and a `chatVision` method to `LLMClient`.

In `src/llm/client.ts`, update config interface:

```typescript
export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  visionModel?: string; // e.g. "moonshot-v1-32k-vision-preview"
  rateLimitRpm: number;
}
```

Add `visionModel` field and `chatVision` method to `LLMClient`:

```typescript
  private visionModel: string | null;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.model = config.model;
    this.visionModel = config.visionModel ?? null;
    this.bucket = new TokenBucket(config.rateLimitRpm);
  }

  /** Chat using vision model (for screenshot analysis). Falls back to text model if no vision model configured. */
  async chatVision(
    messages: OpenAI.ChatCompletionMessageParam[],
  ): Promise<LLMResponse | null> {
    if (!this.visionModel) return null;
    if (this.circuitBreakerFailures >= this.circuitBreakerThreshold) return null;

    await this.bucket.waitForToken();

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.visionModel,
          messages,
          temperature: 0.1,
          max_tokens: 500,
        });

        this.circuitBreakerFailures = 0;
        const result: LLMResponse = {
          content: response.choices[0]?.message?.content || "",
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        };

        this.usage.totalCalls++;
        this.usage.totalInputTokens += result.inputTokens;
        this.usage.totalOutputTokens += result.outputTokens;
        this.usage.enrichmentCalls++;

        return result;
      } catch {
        const waitMs = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    this.circuitBreakerFailures++;
    return null;
  }

  get hasVision(): boolean {
    return this.visionModel !== null;
  }
```

- [ ] **Step 3: Configure vision model in worker**

In `src/worker/index.ts`, update `LLMClient` instantiation to include vision model:

```typescript
const llmClient = process.env.LLM_API_KEY
  ? new LLMClient({
      apiKey: process.env.LLM_API_KEY,
      baseUrl: process.env.LLM_API_BASE_URL ?? "https://api.moonshot.ai/v1",
      model: process.env.LLM_MODEL ?? "kimi-k2-turbo-preview",
      visionModel: process.env.LLM_VISION_MODEL ?? "moonshot-v1-32k-vision-preview",
      rateLimitRpm: 10,
    })
  : null;
```

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lockb src/llm/client.ts src/worker/index.ts
git commit -m "feat: add sharp/pixelmatch deps + vision model support in LLMClient"
```

---

## Task 2: WCAG 1.4.1 — Use of Color (3-Tier Detection)

**Files:**
- Create: `src/analyzer/wcag-color-use.ts`
- Create: `src/analyzer/__tests__/wcag-color-use.test.ts`

- [ ] **Step 1: Write unit tests for Tier 1 DOM heuristics**

```typescript
// src/analyzer/__tests__/wcag-color-use.test.ts
import { test, expect } from "bun:test";
import { computePixelDiffPercent } from "../wcag-color-use";

test("computePixelDiffPercent returns 0 for identical buffers", () => {
  // 2x2 red image
  const buf = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
  expect(computePixelDiffPercent(buf, buf, 2, 2)).toBe(0);
});

test("computePixelDiffPercent returns >0 for different buffers", () => {
  const buf1 = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
  const buf2 = Buffer.from([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]);
  const diff = computePixelDiffPercent(buf1, buf2, 2, 2);
  expect(diff).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Implement the full 3-tier test**

```typescript
// src/analyzer/wcag-color-use.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import type { LLMClient } from "../llm/client";
import { buildMultimodalMessage, extractJsonFromLlm } from "../llm/client";

function makeColorIssue(
  url: string, rule: string, impact: "critical" | "serious" | "moderate" | "minor",
  description: string, selector: string, confidence: "high" | "medium" | "low" | null,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule, impact, description,
    help: "Color must not be the only visual means of conveying information.",
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/use-of-color",
    wcagTags: ["wcag141"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 1280, pageTitle: "",
    checkSource: confidence ? "llm-vision" : "wcag-custom",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: confidence, wcagCriterion: "1.4.1",
    violationCategory: "visual",
  };
}

/**
 * Pixel diff percentage between two raw RGBA buffers.
 * Exported for testing.
 */
export function computePixelDiffPercent(
  buf1: Uint8Array | Buffer,
  buf2: Uint8Array | Buffer,
  width: number,
  height: number,
): number {
  // Lazy import to avoid breaking tests that don't have pixelmatch
  const pixelmatch = require("pixelmatch");
  const totalPixels = width * height;
  const diff = new Uint8Array(totalPixels * 4);
  const diffPixels = pixelmatch(
    new Uint8Array(buf1), new Uint8Array(buf2),
    diff, width, height,
    { threshold: 0.1, includeAA: false },
  );
  return (diffPixels / totalPixels) * 100;
}

// ─── Tier 1: DOM Heuristics (zero cost) ───

async function tier1DomHeuristics(page: Page, url: string): Promise<Issue[]> {
  const findings = await page.evaluate(() => {
    const results: Array<{ type: string; selector: string; detail: string }> = [];

    // 1a. Links distinguished only by color (no underline, no bold, no border)
    document.querySelectorAll("p a, li a, td a, span a").forEach((link) => {
      const style = getComputedStyle(link);
      const textDec = style.textDecorationLine || style.textDecoration;
      if (textDec.includes("underline")) return;

      const weight = parseInt(style.fontWeight);
      const isBold = weight >= 700 || style.fontWeight === "bold";
      const isItalic = style.fontStyle === "italic";
      const hasBorder = style.borderBottomStyle !== "none" && style.borderBottomWidth !== "0px";

      if (!isBold && !isItalic && !hasBorder) {
        const parent = link.parentElement;
        const parentColor = parent ? getComputedStyle(parent).color : "";
        const selector = link.id ? `#${link.id}` :
          link.className && typeof link.className === "string"
            ? `a.${link.className.trim().split(/\s+/).slice(0, 3).join(".")}`
            : "a";
        results.push({
          type: "link-color-only",
          selector,
          detail: `Link "${(link.textContent ?? "").trim().slice(0, 40)}" color=${style.color} vs surrounding=${parentColor}`,
        });
      }
    });

    // 1b. Status indicators without text (badges, dots, indicators)
    document.querySelectorAll(
      "[class*='status'], [class*='badge'], [class*='indicator'], [class*='dot']",
    ).forEach((el) => {
      const text = el.textContent?.trim() ?? "";
      const ariaLabel = el.getAttribute("aria-label") ?? "";
      const title = el.getAttribute("title") ?? "";
      if (text.length > 0 || ariaLabel.length > 0 || title.length > 0) return;

      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;

      const selector = el.id ? `#${el.id}` :
        el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : el.tagName.toLowerCase();
      results.push({
        type: "status-color-only",
        selector,
        detail: `Status indicator with background=${style.backgroundColor} but no accessible text`,
      });
    });

    return results;
  });

  return findings.map((f) =>
    makeColorIssue(url, `color-use-${f.type}`, "serious", `${f.detail} (WCAG 1.4.1 Use of Color)`, f.selector, null),
  );
}

// ─── Tier 2: CVD Screenshot Diff ───

interface CvdDiffResult {
  deficiency: string;
  diffPercent: number;
}

async function tier2CvdScreenshotDiff(page: Page): Promise<CvdDiffResult[]> {
  const sharp = require("sharp");
  const results: CvdDiffResult[] = [];

  // Take normal screenshot
  const normalShot = await page.screenshot({ type: "png", fullPage: false });
  const { data: normalRaw, info } = await sharp(normalShot)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // Test with deuteranopia (most common CVD, ~6% of males)
  const deficiencies = ["deuteranopia", "achromatopsia"] as const;

  for (const deficiency of deficiencies) {
    try {
      const client = await page.context().newCDPSession(page);
      await client.send("Emulation.setEmulatedVisionDeficiency", { type: deficiency });
      const cvdShot = await page.screenshot({ type: "png", fullPage: false });
      await client.send("Emulation.setEmulatedVisionDeficiency", { type: "none" });
      await client.detach();

      const { data: cvdRaw } = await sharp(cvdShot)
        .ensureAlpha().resize(width, height).raw().toBuffer({ resolveWithObject: true });

      const diffPercent = computePixelDiffPercent(normalRaw, cvdRaw, width, height);
      results.push({ deficiency, diffPercent });
    } catch (err) {
      // CDP not available (e.g. Firefox) — skip
      console.warn(`CVD simulation (${deficiency}) failed:`, err instanceof Error ? err.message : err);
    }
  }

  return results;
}

// ─── Tier 3: LLM Vision Confirmation ───

interface LlmColorAnalysis {
  hasViolation: boolean;
  confidence: "high" | "medium" | "low";
  explanation: string;
  elements: string[];
}

async function tier3LlmVisionConfirmation(
  page: Page,
  llmClient: LLMClient,
  deficiency: string,
): Promise<LlmColorAnalysis | null> {
  const sharp = require("sharp");

  // Take both screenshots
  const normalShot = await page.screenshot({ type: "png", fullPage: false });

  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setEmulatedVisionDeficiency", { type: deficiency });
  const cvdShot = await page.screenshot({ type: "png", fullPage: false });
  await client.send("Emulation.setEmulatedVisionDeficiency", { type: "none" });
  await client.detach();

  // Resize to reduce token cost (max 800px wide)
  const resized1 = await sharp(normalShot).resize(800, null, { withoutEnlargement: true }).png().toBuffer();
  const resized2 = await sharp(cvdShot).resize(800, null, { withoutEnlargement: true }).png().toBuffer();

  const b64Normal = resized1.toString("base64");
  const b64Cvd = resized2.toString("base64");

  const prompt = `You are a WCAG accessibility expert analyzing SC 1.4.1 (Use of Color).

Image 1: normal screenshot. Image 2: simulated ${deficiency} color blindness.

A violation exists when information in Image 1 is LOST or AMBIGUOUS in Image 2 because it relied solely on color:
- Links indistinguishable from regular text
- Form error/success states no longer visible
- Chart/graph legends losing meaning
- Status indicators (badges, dots) losing meaning
- Required field indicators disappearing

Do NOT flag: pure aesthetic color changes with no semantic information loss.

Respond with JSON only:
{"hasViolation": true/false, "confidence": "high"|"medium"|"low", "explanation": "one sentence", "elements": ["list of affected elements"]}`;

  const message = buildMultimodalMessage(prompt, [b64Normal, b64Cvd]);
  const response = await llmClient.chatVision([message]);
  if (!response) return null;

  const parsed = extractJsonFromLlm(response.content) as LlmColorAnalysis | null;
  return parsed;
}

// ─── Main Test Function ───

/**
 * WCAG 1.4.1 — Use of Color: 3-tier detection.
 *
 * Tier 1: DOM heuristics (links without underline, status indicators without text) — free
 * Tier 2: CVD screenshot diff via CDP — free (but takes screenshots)
 * Tier 3: LLM vision confirmation — only if diff > 0.5% — ~$0.003/page
 *
 * @param llmClient - Optional. If null, only Tier 1 + Tier 2 run.
 */
export async function testColorUse(
  page: Page,
  url: string,
  llmClient: LLMClient | null = null,
): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Tier 1: DOM heuristics (always run)
  issues.push(...await tier1DomHeuristics(page, url));

  // Tier 2: CVD screenshot diff
  let maxDiffPercent = 0;
  let worstDeficiency = "deuteranopia";
  try {
    const cvdResults = await tier2CvdScreenshotDiff(page);
    for (const r of cvdResults) {
      if (r.diffPercent > maxDiffPercent) {
        maxDiffPercent = r.diffPercent;
        worstDeficiency = r.deficiency;
      }
    }

    // Report high CVD diff as informational even without LLM
    if (maxDiffPercent > 5) {
      issues.push(makeColorIssue(url, "color-use-cvd", "moderate",
        `Page has ${maxDiffPercent.toFixed(1)}% pixel difference under ${worstDeficiency} simulation — significant color-dependent information may exist (WCAG 1.4.1)`,
        "html", null));
    }
  } catch {
    // CVD simulation not available — skip Tier 2 and 3
    return issues;
  }

  // Tier 3: LLM vision confirmation (only if diff exceeds threshold)
  if (maxDiffPercent > 0.5 && llmClient?.hasVision) {
    try {
      const analysis = await tier3LlmVisionConfirmation(page, llmClient, worstDeficiency);
      if (analysis?.hasViolation) {
        issues.push(makeColorIssue(url, "color-use-llm", analysis.confidence === "high" ? "serious" : "moderate",
          `LLM analysis (${analysis.confidence} confidence): ${analysis.explanation}. Affected: ${analysis.elements.join(", ")} (WCAG 1.4.1)`,
          "html", analysis.confidence));
      }
    } catch (err) {
      console.warn("LLM vision analysis failed:", err instanceof Error ? err.message : err);
    }
  }

  return issues;
}
```

- [ ] **Step 3: Run tests**

Run: `bun test src/analyzer/__tests__/wcag-color-use.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/analyzer/wcag-color-use.ts src/analyzer/__tests__/wcag-color-use.test.ts
git commit -m "feat: WCAG 1.4.1 use of color — 3-tier detection (DOM heuristics + CVD diff + LLM vision)"
```

---

## Task 3: WCAG 1.3.3 — Sensory Characteristics (LLM Text Analysis)

**Files:**
- Create: `src/analyzer/wcag-sensory-instructions.ts`

- [ ] **Step 1: Implement the test**

```typescript
// src/analyzer/wcag-sensory-instructions.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import type { LLMClient } from "../llm/client";
import { extractJsonFromLlm } from "../llm/client";

function makeSensoryIssue(
  url: string, description: string, selector: string,
  confidence: "high" | "medium" | "low",
): Issue {
  return {
    id: crypto.randomUUID(), url, rule: "sensory-instruction",
    impact: "moderate", description,
    help: "Instructions must not rely solely on sensory characteristics (shape, color, size, visual location, orientation, sound).",
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/sensory-characteristics",
    wcagTags: ["wcag133"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 0, pageTitle: "",
    checkSource: "llm",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: confidence, wcagCriterion: "1.3.3",
    violationCategory: "structural",
  };
}

/**
 * WCAG 1.3.3 — Sensory Characteristics: detect instructions that rely solely
 * on visual/sensory properties (position, color, shape, size, sound).
 *
 * Extracts text from form areas and instruction blocks, sends to LLM for analysis.
 * Only runs if LLMClient is available.
 */
export async function testSensoryInstructions(
  page: Page,
  url: string,
  llmClient: LLMClient | null = null,
): Promise<Issue[]> {
  if (!llmClient) return [];

  // Extract instruction text from the page
  const instructionBlocks = await page.evaluate(() => {
    const results: Array<{ text: string; selector: string }> = [];

    const containers = document.querySelectorAll(
      "form, [role='form'], fieldset, legend, .instructions, .help-text, " +
      "[class*='instruction'], [class*='helper'], [class*='hint'], " +
      "[class*='description'], label, .form-text, .field-description",
    );

    for (const c of containers) {
      const text = c.textContent?.trim();
      if (!text || text.length < 10 || text.length > 500) continue;

      const selector = c.id ? `#${c.id}` :
        c.className && typeof c.className === "string"
          ? `${c.tagName.toLowerCase()}.${c.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : c.tagName.toLowerCase();

      results.push({ text, selector });
    }

    // Also check for standalone instruction paragraphs near forms
    document.querySelectorAll("form p, form span, fieldset p").forEach((el) => {
      const text = el.textContent?.trim();
      if (!text || text.length < 10 || text.length > 300) return;
      // Skip labels and buttons
      if (el.closest("label, button")) return;

      const selector = el.id ? `#${el.id}` :
        el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : el.tagName.toLowerCase();

      results.push({ text, selector });
    });

    return results;
  });

  if (instructionBlocks.length === 0) return [];

  // Deduplicate and limit
  const seen = new Set<string>();
  const unique = instructionBlocks.filter((b) => {
    if (seen.has(b.text)) return false;
    seen.add(b.text);
    return true;
  }).slice(0, 10);

  // Batch all texts into a single LLM call
  const textList = unique.map((b, i) => `[${i}] "${b.text}"`).join("\n");

  const prompt = `You are a WCAG accessibility expert analyzing SC 1.3.3 (Sensory Characteristics).

Analyze each instruction below. Flag any that rely SOLELY on:
- Visual position: "above", "below", "to the right", "the field on the left", "the top section"
- Color: "fields in red", "the green button", "marked in red"
- Shape/size: "the round icon", "the large button", "the square checkbox"
- Sound: "after the beep", "when you hear the tone"

Instructions that USE these terms but ALSO provide a non-sensory alternative are OK.
Example violation: "Fill in the fields marked in red"
Example OK: "Required fields are marked with an asterisk (*) in red"

Instructions:
${textList}

Respond with JSON only:
{"violations": [{"index": 0, "confidence": "high"|"medium"|"low", "reason": "one sentence"}]}

If no violations found, respond: {"violations": []}`;

  const response = await llmClient.chat(
    [{ role: "user", content: prompt }],
    "enrichment",
  );

  if (!response) return [];

  const parsed = extractJsonFromLlm(response.content) as { violations: Array<{ index: number; confidence: "high" | "medium" | "low"; reason: string }> } | null;
  if (!parsed?.violations) return [];

  return parsed.violations
    .filter((v) => v.index >= 0 && v.index < unique.length)
    .map((v) => {
      const block = unique[v.index];
      return makeSensoryIssue(
        url,
        `Instruction "${block.text.slice(0, 60)}..." relies on sensory characteristics: ${v.reason} (WCAG 1.3.3)`,
        block.selector,
        v.confidence,
      );
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/analyzer/wcag-sensory-instructions.ts
git commit -m "feat: WCAG 1.3.3 sensory characteristics — LLM text analysis of form instructions"
```

---

## Task 4: Add TestTypes + Wire Into Probe

**Files:**
- Modify: `src/types/pipeline.ts`
- Modify: `src/analyzer/classify.ts`
- Modify: `src/analyzer/category.ts`
- Modify: `src/worker/probe.ts`

- [ ] **Step 1: Add TestType values**

In `src/types/pipeline.ts`, add to the TestType union:

```typescript
  // v4.4 — LLM-augmented WCAG tests
  | "color-use"
  | "sensory-instructions";
```

- [ ] **Step 2: Update buildTestPlan**

In `src/analyzer/classify.ts`, add to `buildTestPlan()`:

```typescript
  // v4.4 — LLM-augmented tests (always run; degrade gracefully if no LLM)
  plan.push("color-use");
  if (cluster.capabilities.hasForms) plan.push("sensory-instructions");
```

- [ ] **Step 3: Add category mappings**

In `src/analyzer/category.ts`, add:

```typescript
  "color-use-link-color-only": "visual",
  "color-use-status-color-only": "visual",
  "color-use-cvd": "visual",
  "color-use-llm": "visual",
  "sensory-instruction": "structural",
```

- [ ] **Step 4: Wire into probe.ts**

Add imports at top of `probe.ts`:

```typescript
import { testColorUse } from "../analyzer/wcag-color-use";
import { testSensoryInstructions } from "../analyzer/wcag-sensory-instructions";
```

Add `color-use` AFTER text-spacing (needs clean DOM for screenshots, before any CSS injection — but text-spacing already cleans up after itself, so place it as a new step 6):

```typescript
          // 6. CVD color analysis (screenshots — run after viewport tests restore)
          if (cluster.testPlan.includes("color-use")) {
            const r = await withTimeout(testColorUse(page, url, llmClient), 45_000);
            if (r) allIssues.push(...r);
          }

          // 7. Sensory instructions (LLM text analysis — can run anytime)
          if (cluster.testPlan.includes("sensory-instructions")) {
            const r = await withTimeout(testSensoryInstructions(page, url, llmClient), 30_000);
            if (r) allIssues.push(...r);
          }
```

Note: `color-use` gets a 45s timeout (CVD screenshots + potential LLM call). `sensory-instructions` gets 30s.

Add new rules to `TEMPLATE_LEVEL_RULES`:

```typescript
  "color-use-link-color-only", "color-use-status-color-only",
  "color-use-cvd", "color-use-llm",
  "sensory-instruction",
```

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/types/pipeline.ts src/analyzer/classify.ts src/analyzer/category.ts src/worker/probe.ts
git commit -m "feat: wire color-use and sensory-instructions into probe phase"
```

---

## Task 5: Integration Smoke Test

- [ ] **Step 1: Verify env vars**

Ensure `.env` has:
```
LLM_API_KEY=sk-...
LLM_API_BASE_URL=https://api.moonshot.ai/v1
LLM_MODEL=kimi-k2-turbo-preview
LLM_VISION_MODEL=moonshot-v1-32k-vision-preview
```

- [ ] **Step 2: Restart dev and run audit**

```bash
bash dev.sh
```

Navigate to `http://localhost:5173`, audit a site with 5 pages.

- [ ] **Step 3: Verify new rules**

```bash
bun -e "
import postgres from 'postgres';
const sql = postgres('postgresql://postgres:dev@localhost:5433/a11y');
const audit = await sql\`SELECT id FROM audits ORDER BY created_at DESC LIMIT 1\`;
const rules = await sql\`
  SELECT rule, check_source, llm_confidence, count(*)::int as cnt
  FROM issues WHERE audit_id = \${audit[0].id}
    AND rule LIKE 'color-use%' OR rule = 'sensory-instruction'
  GROUP BY rule, check_source, llm_confidence ORDER BY cnt DESC
\`;
rules.forEach(r => console.log(r.rule, r.check_source, r.llm_confidence, r.cnt));
await sql.end();
"
```

Expected: `color-use-*` rules with `check_source: "wcag-custom"` or `"llm-vision"`, possibly `sensory-instruction` with `check_source: "llm"`.

- [ ] **Step 4: Commit plan**

```bash
git add docs/plans/2026-03-18-llm-wcag-tests.md
git commit -m "docs: implementation plan for LLM-augmented WCAG tests"
```

---

## Summary

| Task | WCAG | Technique | LLM Cost | Commit |
|---|---|---|---|---|
| 1 | — | sharp + pixelmatch + vision model config | — | `feat: deps + vision model` |
| 2 | 1.4.1 | Tier 1: DOM heuristics (links, status) + Tier 2: CVD CDP diff + Tier 3: LLM vision | ~$0.003/page (Tier 3 only) | `feat: WCAG 1.4.1 color use` |
| 3 | 1.3.3 | LLM text analysis of form instructions | ~$0.001/page | `feat: WCAG 1.3.3 sensory` |
| 4 | — | TestTypes + probe wiring | — | `feat: wire into probe` |
| 5 | — | Smoke test | — | `docs: plan` |

**Total additional cost per audit: ~$0.02-0.05 (only for pages with CVD diff > 0.5% or forms with instructions)**

**New coverage after this phase:**

| Criterion | Before | After |
|---|---|---|
| 1.4.1 Use of Color | Not covered | **Covered (3-tier)** |
| 1.3.3 Sensory Characteristics | Not covered | **Covered (LLM text)** |
| Total WCAG coverage vs manual audit | ~80% | **~90%** |
