// src/analyzer/wcag-color-use.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import type { LLMClient } from "../llm/client";
import { buildMultimodalMessage, extractJsonFromLlm } from "../llm/client";
import { makeWcagIssue } from "./utils";

// Subset of CDP VisionDeficiency enum used here
type CvdDeficiency = "deuteranopia" | "achromatopsia";

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

/**
 * Pixel diff percentage between two raw RGBA buffers.
 * Exported for testing.
 */
export async function computePixelDiffPercent(
  buf1: Uint8Array | Buffer,
  buf2: Uint8Array | Buffer,
  width: number,
  height: number,
): Promise<{ percent: number; boundingBox: DiffBoundingBox | null }> {
  const mod = await import("pixelmatch");
  const pixelmatch = mod.default ?? mod;
  const totalPixels = width * height;
  const diff = new Uint8Array(totalPixels * 4);
  const diffPixels = pixelmatch(
    new Uint8Array(buf1), new Uint8Array(buf2),
    diff, width, height,
    { threshold: 0.1, includeAA: false },
  );
  const percent = (diffPixels / totalPixels) * 100;

  // Compute bounding box of diff region (non-zero alpha in diff buffer)
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (diff[i * 4 + 3] > 0) { // alpha channel > 0 means diff pixel
      const x = i % width;
      const y = Math.floor(i / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const boundingBox = maxX >= minX ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  return { percent, boundingBox };
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

interface DiffBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CvdDiffResult {
  deficiency: CvdDeficiency;
  diffPercent: number;
  normalPng: Buffer;
  cvdPng: Buffer;
  diffBox: DiffBoundingBox | null;
}

async function tier2CvdScreenshotDiff(page: Page): Promise<CvdDiffResult[]> {
  const { default: sharp } = await import("sharp");
  const results: CvdDiffResult[] = [];

  // Take normal screenshot once — reused across all deficiency checks
  const normalShot = await page.screenshot({ type: "png", fullPage: false });
  // Resize to half resolution for faster pixelmatch comparison (75% fewer pixels)
  const DIFF_WIDTH = 640;
  const DIFF_HEIGHT = 360;
  const { data: normalRaw } = await sharp(normalShot)
    .resize(DIFF_WIDTH, DIFF_HEIGHT)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const deficiencies: CvdDeficiency[] = ["deuteranopia"];

  const client = await page.context().newCDPSession(page);
  try {
    for (const deficiency of deficiencies) {
      try {
        await client.send("Emulation.setEmulatedVisionDeficiency", { type: deficiency });
        const cvdShot = await page.screenshot({ type: "png", fullPage: false });
        await client.send("Emulation.setEmulatedVisionDeficiency", { type: "none" });

        const { data: cvdRaw } = await sharp(cvdShot)
          .ensureAlpha().resize(DIFF_WIDTH, DIFF_HEIGHT).raw().toBuffer({ resolveWithObject: true });

        const { percent: diffPercent, boundingBox: diffBoxSmall } = await computePixelDiffPercent(normalRaw, cvdRaw, DIFF_WIDTH, DIFF_HEIGHT);
        // Scale bounding box back to full resolution (1280x720) with padding
        let diffBox: DiffBoundingBox | null = null;
        if (diffBoxSmall) {
          const scaleX = 1280 / DIFF_WIDTH;
          const scaleY = 720 / DIFF_HEIGHT;
          const PAD = 50;
          diffBox = {
            x: Math.max(0, Math.floor(diffBoxSmall.x * scaleX) - PAD),
            y: Math.max(0, Math.floor(diffBoxSmall.y * scaleY) - PAD),
            width: Math.min(1280, Math.ceil(diffBoxSmall.width * scaleX) + PAD * 2),
            height: Math.min(720, Math.ceil(diffBoxSmall.height * scaleY) + PAD * 2),
          };
        }
        results.push({ deficiency, diffPercent, normalPng: normalShot, cvdPng: cvdShot, diffBox });
      } catch (err) {
        // CDP not available (e.g. Firefox) — skip
        console.warn(`CVD simulation (${deficiency}) failed:`, err instanceof Error ? err.message : err);
        await client.send("Emulation.setEmulatedVisionDeficiency", { type: "none" }).catch(() => {});
      }
    }
  } finally {
    await client.send("Emulation.setEmulatedVisionDeficiency", { type: "none" }).catch(() => {});
    await client.detach().catch(() => {});
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
  diffBox: DiffBoundingBox | null = null,
  tier1Context: string[] = [],
): Promise<LlmColorAnalysis | null> {
  const { default: sharp } = await import("sharp");

  // Crop to diff region if available, then resize to max 400px wide
  let img1 = sharp(normalPng);
  let img2 = sharp(cvdPng);
  if (diffBox) {
    const extract = { left: diffBox.x, top: diffBox.y, width: diffBox.width, height: diffBox.height };
    img1 = img1.extract(extract);
    img2 = img2.extract(extract);
  }
  const resized1 = await img1.resize(400, null, { withoutEnlargement: true }).png().toBuffer();
  const resized2 = await img2.resize(400, null, { withoutEnlargement: true }).png().toBuffer();

  const b64Normal = resized1.toString("base64");
  const b64Cvd = resized2.toString("base64");

  // Build context from Tier 1 DOM heuristics
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

// ─── CSS Fingerprint Cache ───

async function computeCssFingerprint(page: Page): Promise<string> {
  const raw = await page.evaluate(() => {
    const parts: string[] = [];
    // Collect stylesheet hrefs
    document.querySelectorAll('link[rel="stylesheet"]').forEach(l => {
      parts.push((l as HTMLLinkElement).href);
    });
    // Collect inline style hashes (just length + first 100 chars as proxy)
    document.querySelectorAll('style').forEach(s => {
      const text = s.textContent || '';
      parts.push(`inline:${text.length}:${text.slice(0, 100)}`);
    });
    return parts.sort().join('|');
  });
  // Simple hash using Bun's built-in
  const hash = new Bun.CryptoHasher("md5").update(raw).digest("hex");
  return hash;
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
    // Reuse CVD results from previous template with same styles
    issues.push(...cached.issues.map(i => ({ ...i, url, id: crypto.randomUUID() })));
    return { issues, screenshots };
  }

  // Tier 2: CVD screenshot diff
  let bestResult: CvdDiffResult | null = null;
  const cvdIssuesFromTier2And3: Issue[] = [];
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
        if (r.diffPercent <= 5) continue; // Only save evidence for significant diffs (>5%)
        const normalPath = join(screenshotDir, `${templatePrefix}-${r.deficiency}-normal.png`);
        const cvdPath = join(screenshotDir, `${templatePrefix}-${r.deficiency}-cvd.png`);
        await Bun.write(normalPath, r.normalPng);
        await Bun.write(cvdPath, r.cvdPng);
        screenshots.push({ deficiency: r.deficiency, normalPath, cvdPath });
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
  } catch {
    // CVD simulation not available — skip Tier 2 and 3
    return { issues, screenshots };
  }

  // Tier 3: LLM vision confirmation (only if diff exceeds threshold)
  if (bestResult && bestResult.diffPercent > 0.5 && llmClient?.hasVision) {
    try {
      // Build Tier 1 context for LLM (element descriptions from DOM heuristics)
      const tier1Context = issues
        .filter(i => i.rule.startsWith("color-use-"))
        .map(i => i.description.slice(0, 120));

      const analysis = await tier3LlmVisionConfirmation(
        bestResult.normalPng, bestResult.cvdPng, llmClient, bestResult.deficiency,
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

  // Cache Tier 2+3 results for this CSS fingerprint
  if (cvdCache) {
    cvdCache.set(fingerprint, { diffPercent: bestResult?.diffPercent ?? 0, issues: cvdIssuesFromTier2And3 });
  }

  return { issues, screenshots };
}
