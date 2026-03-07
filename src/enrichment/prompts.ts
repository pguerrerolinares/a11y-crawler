// src/enrichment/prompts.ts
import type { Issue, ViolationCategory } from "../types/issue.ts";
import type OpenAI from "openai";
import { buildMultimodalMessage, extractJsonFromLlm } from "../llm/client.ts";

export interface PageScreenshots {
  mobile: string;   // base64 PNG at 375px
  tablet: string;   // base64 PNG at 768px
  desktop: string;  // base64 PNG at 1280px
}

export interface EnrichResult {
  fix: string;
  confidence: "high" | "medium" | "low";
  wcag: string;
  contrastRatio?: string | null;
}

// ─── System Prompts ────────────────────────────────────────────────────────────

const SYSTEM_PROMPTS: Record<ViolationCategory, string> = {
  structural: `Act as a web developer expert in accessibility (WCAG 2.2 Level A and AA), specializing in document structure: landmarks, headings, lists, and page regions.

Rules:
- Fix ONLY the violation described. Do NOT alter unrelated attributes, text, or layout
- Preserve all existing class names, IDs, data-* attributes, and event handlers
- Add semantic HTML5 elements (main, nav, header, footer, aside) or ARIA role equivalents
- Heading hierarchy must be strictly sequential (h1→h2→h3); never skip levels
- Every page region must be reachable via landmark navigation
- If the fix is ambiguous, return "MANUAL_REVIEW: <reason>" in the fix field

Output (JSON only, no prose):
{"fix":"<corrected HTML>","confidence":"high|medium|low","wcag":"<criterion e.g. 1.3.1>"}`,

  interactive: `Act as a web developer expert in accessibility (WCAG 2.2 Level A and AA), specializing in interactive elements: forms, buttons, links, keyboard navigation, and ARIA attributes.

Rules:
- Fix ONLY the violation described. Do NOT alter unrelated attributes, text, or layout
- Preserve all existing class names, IDs, data-* attributes, and event handlers
- Add aria-label or aria-labelledby when a visible label is absent; prefer visible <label for="..."> over hidden ARIA
- All interactive elements must be focusable and operable via keyboard (Tab, Enter, Space)
- Use ARIA roles/states/properties only when native HTML semantics are insufficient
- For aria-* fixes: validate the attribute is legal on the element's role
- If the fix requires knowledge of surrounding structure not visible in the fragment, return "MANUAL_REVIEW: <reason>"

Output (JSON only, no prose):
{"fix":"<corrected HTML>","confidence":"high|medium|low","wcag":"<criterion e.g. 4.1.2>"}`,

  visual: `Act as a web developer expert in accessibility (WCAG 2.2 Level A and AA), specializing in visual presentation: color contrast, text spacing, reflow, and target size.

Rules:
- Fix ONLY the violation described. Do NOT alter layout, dimensions, or non-text colors
- For color-contrast: adjust ONLY the foreground text color or background of the failing element. Minimum ratios: 4.5:1 normal text, 3:1 large text (≥18pt or ≥14pt bold) and UI components. Provide exact hex value
- For target-size: minimum 24×24 CSS pixels (WCAG 2.2 AA); prefer 44×44px for touch
- For meta-viewport: remove user-scalable=no and maximum-scale<5 entirely
- screenshots provided: examine them to verify element visual context before choosing replacement color. Reference the viewport where the issue is most evident
- Compute contrast ratio from inline style values when possible
- For color-contrast violations: return exactly {"fix":"MANUAL_REVIEW: Color contrast is a design/brand decision. Minimum required ratios: 4.5:1 for normal text, 3:1 for large text (>=18pt or >=14pt bold) and UI components.","confidence":"low","wcag":"1.4.3","contrast_ratio":null}

Output (JSON only, no prose):
{"fix":"<corrected HTML>","confidence":"high|medium|low","wcag":"<criterion e.g. 1.4.3>","contrast_ratio":"<computed or null>"}`,

  media: `Act as a web developer expert in accessibility (WCAG 2.2 Level A and AA), specializing in non-text content: images, video, audio, SVG, and embedded objects.

Rules:
- Fix ONLY the violation described. Do NOT alter src, href, dimensions, or layout
- For missing alt: write concise alt conveying the image's PURPOSE in context. decorative images: alt="" (empty string, not omitted)
- For redundant alt (same as adjacent link/heading text): use alt=""
- For SVG used as img: add role="img" and aria-label, or a <title> child element
- For video/audio: add <track kind="captions" src="CAPTION_FILE_REQUIRED">
- Never invent image content; if purpose cannot be inferred from the fragment, return "MANUAL_REVIEW: image purpose unclear from fragment"

Output (JSON only, no prose):
{"fix":"<corrected HTML>","confidence":"high|medium|low","wcag":"<criterion e.g. 1.1.1>"}`,

  semantic: `Act as a web developer expert in accessibility (WCAG 2.2 Level A and AA), specializing in semantics: language attributes, link purpose, and page titles.

Rules:
- Fix ONLY the violation described. Do NOT alter content or visual presentation
- For html-has-lang / html-lang-valid: add or correct the lang attribute using a valid BCP 47 tag (es, en, ca, es-ES, en-US…). Infer language from page title or URL if provided
- For document-title: must be unique, descriptive, pattern "Page Name | Site Name"
- For link-name / link-purpose: add aria-label describing destination and action. Never use "click here"
- For valid-lang: the lang value on any element must be a valid BCP 47 subtag

Output (JSON only, no prose):
{"fix":"<corrected HTML>","confidence":"high|medium|low","wcag":"<criterion e.g. 3.1.1>"}`,
};

// ─── Public API ────────────────────────────────────────────────────────────────

export function getSystemPrompt(category: ViolationCategory): string {
  return SYSTEM_PROMPTS[category];
}

/**
 * Strip noise from HTML fragment before sending to LLM.
 */
export function cleanFragment(html: string, keepSvg = false): string {
  let result = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  if (!keepSvg) {
    result = result.replace(/<svg[\s\S]*?<\/svg>/gi, "");
  }
  return result
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the user message for enrichment.
 * Visual violations get screenshots as multimodal content.
 */
export function buildEnrichUserMessage(
  issue: Issue,
  screenshots?: PageScreenshots,
): OpenAI.ChatCompletionMessageParam {
  const fragment = cleanFragment(issue.surroundingHtml || issue.html, issue.violationCategory === "media");

  const text = `Page: ${issue.url}

Violation:
  Rule: ${issue.rule}
  Impact: ${issue.impact}
  WCAG: ${issue.wcagTags.join(", ")}
  Description: ${issue.description}
  Help: ${issue.help}
  Reference: ${issue.helpUrl}

Selector: ${issue.selector}

<<<FRAGMENT>>>
${fragment}
<<<END>>>`;

  if (issue.violationCategory === "visual" && screenshots) {
    return buildMultimodalMessage(
      text + "\n\nScreenshots (examine before fixing):",
      [screenshots.mobile, screenshots.tablet, screenshots.desktop],
    );
  }

  return { role: "user", content: text };
}

/**
 * Parse LLM enrichment response JSON into EnrichResult.
 */
export function parseEnrichResponse(content: string): EnrichResult | null {
  const parsed = extractJsonFromLlm(content) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!parsed.fix || typeof parsed.fix !== "string") return null;
  const validConfidence = new Set(["high", "medium", "low"]);
  const confidence = validConfidence.has(parsed.confidence as string)
    ? (parsed.confidence as "high" | "medium" | "low")
    : "low";
  return {
    fix: String(parsed.fix),
    confidence,
    wcag: String(parsed.wcag || ""),
    contrastRatio: (parsed.contrast_ratio as string) ?? null,
  };
}
