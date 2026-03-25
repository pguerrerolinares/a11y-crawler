// src/analyzer/wcag-color-use.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import type { LLMClient } from "../llm/client";
import { buildMultimodalMessage, extractJsonFromLlm } from "../llm/client";
import { writeFile } from "node:fs/promises";
import { makeWcagIssue } from "./utils";
import { computePixelDiffPercent, cvdScreenshotDiff, computeCssFingerprint } from "./screenshot-cvd";
import type { CvdDiffResult, DiffBoundingBox } from "./screenshot-cvd";

function makeColorIssue(
  url: string, rule: string, impact: "critical" | "serious" | "moderate" | "minor",
  description: string, selector: string, confidence: "high" | "medium" | "low" | null,
): Issue {
  return makeWcagIssue(url, rule, impact, description, selector, "1.4.1", "visual", {
    checkSource: confidence ? "llm-vision" : "wcag-custom",
    llmConfidence: confidence,
    help: "Color must not be the only visual means of conveying information.",
  });
}

// Re-export for tests
export { computePixelDiffPercent } from "./screenshot-cvd";

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
  normalImg: Buffer,
  cvdImg: Buffer,
  llmClient: LLMClient,
  deficiency: string,
  diffBox: DiffBoundingBox | null = null,
  tier1Context: string[] = [],
): Promise<LlmColorAnalysis | null> {
  const { default: sharp } = await import("sharp");

  let img1 = sharp(normalImg);
  let img2 = sharp(cvdImg);
  if (diffBox) {
    const extract = { left: diffBox.x, top: diffBox.y, width: diffBox.width, height: diffBox.height };
    img1 = img1.extract(extract);
    img2 = img2.extract(extract);
  }
  const resized1 = await img1.resize(400, null, { withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const resized2 = await img2.resize(400, null, { withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();

  const b64Normal = resized1.toString("base64");
  const b64Cvd = resized2.toString("base64");

  const contextSection = tier1Context.length > 0
    ? `\nDOM analysis already identified these potential color-only elements in this region:\n${tier1Context.map(c => `- ${c}`).join("\n")}\n\nFocus your analysis on verifying whether these elements lose meaning under CVD simulation.\n`
    : "";

  const cropNote = diffBox ? " (cropped to region with highest color difference)" : "";

  const prompt = `You are a WCAG accessibility expert analyzing SC 1.4.1 (Use of Color).

Image 1: normal screenshot${cropNote}. Image 2: simulated ${deficiency} color blindness.
${contextSection}
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

export interface ColorUseResult {
  issues: Issue[];
  screenshots: Array<{
    deficiency: string;
    normalPath: string;
    cvdPath: string;
  }>;
}

export async function testColorUse(
  page: Page,
  url: string,
  llmClient: LLMClient | null = null,
  screenshotDir?: string,
  templatePrefix?: string,
  cvdCache?: Map<string, { diffPercent: number; issues: Issue[] }>,
): Promise<ColorUseResult> {
  const issues: Issue[] = [];
  const screenshots: ColorUseResult["screenshots"] = [];

  // Tier 1: DOM heuristics (always run)
  issues.push(...await tier1DomHeuristics(page, url));

  // Check CSS fingerprint cache — skip Tier 2+3 if same styles already processed
  const fingerprint = await computeCssFingerprint(page);
  if (cvdCache?.has(fingerprint)) {
    const cached = cvdCache.get(fingerprint)!;
    issues.push(...cached.issues.map(i => ({ ...i, url, id: crypto.randomUUID() })));
    return { issues, screenshots };
  }

  // Tier 2: CVD screenshot diff
  let bestResult: CvdDiffResult | null = null;
  const cvdIssuesFromTier2And3: Issue[] = [];
  try {
    const cvdResults = await cvdScreenshotDiff(page);
    for (const r of cvdResults) {
      if (!bestResult || r.diffPercent > bestResult.diffPercent) {
        bestResult = r;
      }
    }

    // Report high CVD diff as informational even without LLM
    if (bestResult && bestResult.diffPercent > 5) {
      const cvdIssue = makeColorIssue(url, "color-use-cvd", "moderate",
        `Page has ${bestResult.diffPercent.toFixed(1)}% pixel difference under ${bestResult.deficiency} simulation — significant color-dependent information may exist (WCAG 1.4.1)`,
        "html", null);
      issues.push(cvdIssue);
      cvdIssuesFromTier2And3.push(cvdIssue);
    }

    // Run disk write and LLM vision in parallel (optimization: don't wait for disk before LLM)
    const diskWritePromise = (async () => {
      if (screenshotDir && templatePrefix) {
        const { join } = await import("node:path");
        for (const r of cvdResults) {
          if (r.diffPercent <= 5) continue;
          const normalPath = join(screenshotDir, `${templatePrefix}-${r.deficiency}-normal.jpg`);
          const cvdPath = join(screenshotDir, `${templatePrefix}-${r.deficiency}-cvd.jpg`);
          await writeFile(normalPath, r.normalImg);
          await writeFile(cvdPath, r.cvdImg);
          screenshots.push({ deficiency: r.deficiency, normalPath, cvdPath });
        }
      }
    })();

    const llmPromise = (async () => {
      if (bestResult && bestResult.diffPercent > 0.5 && llmClient?.hasVision) {
        try {
          const tier1Context = issues
            .filter(i => i.rule.startsWith("color-use-"))
            .map(i => i.description.slice(0, 120));

          const analysis = await tier3LlmVisionConfirmation(
            bestResult.normalImg, bestResult.cvdImg, llmClient, bestResult.deficiency,
            bestResult.diffBox, tier1Context,
          );
          if (analysis?.hasViolation) {
            const llmIssue = makeColorIssue(url, "color-use-llm", analysis.confidence === "high" ? "serious" : "moderate",
              `LLM analysis (${analysis.confidence} confidence): ${analysis.explanation}. Affected: ${analysis.elements.join(", ")} (WCAG 1.4.1)`,
              "html", analysis.confidence);
            issues.push(llmIssue);
            cvdIssuesFromTier2And3.push(llmIssue);
          }
        } catch (err) {
          console.warn("LLM vision analysis failed:", err instanceof Error ? err.message : err);
        }
      }
    })();

    await Promise.all([diskWritePromise, llmPromise]);
  } catch {
    return { issues, screenshots };
  }

  // Cache Tier 2+3 results for this CSS fingerprint
  if (cvdCache) {
    cvdCache.set(fingerprint, { diffPercent: bestResult?.diffPercent ?? 0, issues: cvdIssuesFromTier2And3 });
  }

  return { issues, screenshots };
}
