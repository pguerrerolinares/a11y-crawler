// src/analyzer/wcag-color-use.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import type { LLMClient } from "../llm/client";
import { buildMultimodalMessage, extractJsonFromLlm } from "../llm/client";

// Subset of CDP VisionDeficiency enum used here
type CvdDeficiency = "deuteranopia" | "achromatopsia";

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
  // pixelmatch is ESM — require() returns the module object, default is the function
  const pixelmatch = require("pixelmatch").default ?? require("pixelmatch");
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
  const { CONSENT_BANNER_SELECTOR } = await import("./utils");

  const findings = await page.evaluate((consentSelector: string) => {
    const results: Array<{ type: string; selector: string; detail: string }> = [];

    function isInsideConsentOrHidden(el: Element): boolean {
      if (el.closest(consentSelector)) return true;
      const style = getComputedStyle(el);
      return style.display === "none" || style.visibility === "hidden";
    }

    // 1a. Links distinguished only by color (no underline, no bold, no border)
    document.querySelectorAll("p a, li a, td a, span a").forEach((link) => {
      if (isInsideConsentOrHidden(link)) return;
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
      if (isInsideConsentOrHidden(el)) return;
      const text = el.textContent?.trim() ?? "";
      const ariaLabel = el.getAttribute("aria-label") ?? "";
      const title = el.getAttribute("title") ?? "";
      if (text.length > 0 || ariaLabel.length > 0 || title.length > 0) return;

      const elStyle = getComputedStyle(el);
      const selector = el.id ? `#${el.id}` :
        el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : el.tagName.toLowerCase();
      results.push({
        type: "status-color-only",
        selector,
        detail: `Status indicator with background=${elStyle.backgroundColor} but no accessible text`,
      });
    });

    return results;
  }, CONSENT_BANNER_SELECTOR);

  return findings.map((f) =>
    makeColorIssue(url, `color-use-${f.type}`, "serious", `${f.detail} (WCAG 1.4.1 Use of Color)`, f.selector, null),
  );
}

// ─── Tier 2: CVD Screenshot Diff ───

interface CvdDiffResult {
  deficiency: CvdDeficiency;
  diffPercent: number;
  normalPng: Buffer;
  cvdPng: Buffer;
}

async function tier2CvdScreenshotDiff(page: Page): Promise<CvdDiffResult[]> {
  const { default: sharp } = await import("sharp");
  const results: CvdDiffResult[] = [];

  // Take normal screenshot once — reused across all deficiency checks
  const normalShot = await page.screenshot({ type: "png", fullPage: false });
  const { data: normalRaw, info } = await sharp(normalShot)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const deficiencies: CvdDeficiency[] = ["deuteranopia", "achromatopsia"];

  for (const deficiency of deficiencies) {
    const client = await page.context().newCDPSession(page);
    try {
      await client.send("Emulation.setEmulatedVisionDeficiency", { type: deficiency });
      const cvdShot = await page.screenshot({ type: "png", fullPage: false });
      await client.send("Emulation.setEmulatedVisionDeficiency", { type: "none" });

      const { data: cvdRaw } = await sharp(cvdShot)
        .ensureAlpha().resize(width, height).raw().toBuffer({ resolveWithObject: true });

      const diffPercent = computePixelDiffPercent(normalRaw, cvdRaw, width, height);
      results.push({ deficiency, diffPercent, normalPng: normalShot, cvdPng: cvdShot });
    } catch (err) {
      // CDP not available (e.g. Firefox) — skip
      console.warn(`CVD simulation (${deficiency}) failed:`, err instanceof Error ? err.message : err);
    } finally {
      await client.send("Emulation.setEmulatedVisionDeficiency", { type: "none" }).catch(() => {});
      await client.detach().catch(() => {});
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

function isLlmColorAnalysis(v: unknown): v is LlmColorAnalysis {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.hasViolation === "boolean" &&
    (obj.confidence === "high" || obj.confidence === "medium" || obj.confidence === "low") &&
    typeof obj.explanation === "string" &&
    Array.isArray(obj.elements)
  );
}

async function tier3LlmVisionConfirmation(
  normalPng: Buffer,
  cvdPng: Buffer,
  llmClient: LLMClient,
  deficiency: CvdDeficiency,
): Promise<LlmColorAnalysis | null> {
  const { default: sharp } = await import("sharp");

  // Resize to reduce token cost (max 800px wide)
  const resized1 = await sharp(normalPng).resize(800, null, { withoutEnlargement: true }).png().toBuffer();
  const resized2 = await sharp(cvdPng).resize(800, null, { withoutEnlargement: true }).png().toBuffer();

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

  const parsed = extractJsonFromLlm(response.content);
  return isLlmColorAnalysis(parsed) ? parsed : null;
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
export interface ColorUseResult {
  issues: Issue[];
  screenshots: Array<{
    deficiency: string;
    normalPath: string;
    cvdPath: string;
  }>;
}

/**
 * WCAG 1.4.1 — Use of Color: 3-tier detection.
 *
 * Tier 1: DOM heuristics (links without underline, status indicators without text) — free
 * Tier 2: CVD screenshot diff via CDP — free (but takes screenshots)
 * Tier 3: LLM vision confirmation — only if diff > 0.5% — ~$0.003/page
 *
 * @param llmClient - Optional. If null, only Tier 1 + Tier 2 run.
 * @param screenshotDir - If provided, screenshots are written directly to disk (eliminates ~50MB peak buffer memory).
 * @param templatePrefix - Prefix for screenshot filenames (e.g. cluster id slice).
 */
export async function testColorUse(
  page: Page,
  url: string,
  llmClient: LLMClient | null = null,
  screenshotDir?: string,
  templatePrefix?: string,
): Promise<ColorUseResult> {
  const issues: Issue[] = [];
  const screenshots: ColorUseResult["screenshots"] = [];

  // Tier 1: DOM heuristics (always run)
  issues.push(...await tier1DomHeuristics(page, url));

  // Tier 2: CVD screenshot diff
  let bestResult: CvdDiffResult | null = null;
  try {
    const cvdResults = await tier2CvdScreenshotDiff(page);
    for (const r of cvdResults) {
      if (!bestResult || r.diffPercent > bestResult.diffPercent) {
        bestResult = r;
      }
    }

    // Write screenshots to disk (eliminates buffer memory overhead)
    if (screenshotDir && templatePrefix) {
      const { join } = await import("node:path");
      for (const r of cvdResults) {
        const normalPath = join(screenshotDir, `${templatePrefix}-${r.deficiency}-normal.png`);
        const cvdPath = join(screenshotDir, `${templatePrefix}-${r.deficiency}-cvd.png`);
        await Bun.write(normalPath, r.normalPng);
        await Bun.write(cvdPath, r.cvdPng);
        screenshots.push({ deficiency: r.deficiency, normalPath, cvdPath });
      }
    }

    // Report high CVD diff as informational even without LLM
    if (bestResult && bestResult.diffPercent > 5) {
      issues.push(makeColorIssue(url, "color-use-cvd", "moderate",
        `Page has ${bestResult.diffPercent.toFixed(1)}% pixel difference under ${bestResult.deficiency} simulation — significant color-dependent information may exist (WCAG 1.4.1)`,
        "html", null));
    }
  } catch {
    // CVD simulation not available — skip Tier 2 and 3
    return { issues, screenshots };
  }

  // Tier 3: LLM vision confirmation (only if diff exceeds threshold)
  if (bestResult && bestResult.diffPercent > 0.5 && llmClient?.hasVision) {
    try {
      const analysis = await tier3LlmVisionConfirmation(
        bestResult.normalPng, bestResult.cvdPng, llmClient, bestResult.deficiency,
      );
      if (analysis?.hasViolation) {
        issues.push(makeColorIssue(url, "color-use-llm", analysis.confidence === "high" ? "serious" : "moderate",
          `LLM analysis (${analysis.confidence} confidence): ${analysis.explanation}. Affected: ${analysis.elements.join(", ")} (WCAG 1.4.1)`,
          "html", analysis.confidence));
      }
    } catch (err) {
      console.warn("LLM vision analysis failed:", err instanceof Error ? err.message : err);
    }
  }

  return { issues, screenshots };
}
