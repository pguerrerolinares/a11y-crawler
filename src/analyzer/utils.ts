/**
 * Build a CSS selector for a DOM element, suitable for issue reporting.
 * Prefers #id > tag.class1.class2.class3 > tag
 * Max 3 classes to keep selectors readable.
 */
export function buildCssSelector(tagName: string, id: string, className: string): string {
  if (id) return `#${id}`;
  const tag = tagName.toLowerCase();
  if (className && typeof className === "string") {
    const classes = className.trim().split(/\s+/).slice(0, 3).join(".");
    if (classes) return `${tag}.${classes}`;
  }
  return tag;
}

/**
 * CSS selector matching known consent/cookie banner containers.
 * Use with el.closest() inside page.evaluate() to skip elements inside banners.
 * Must be kept in sync with consent-blocker.ts CONSENT_PREHIDE_CSS.
 */
import type { Issue, ImpactLevel, ViolationCategory } from "../types/issue";

export const WCAG_CRITERION_SLUGS: Record<string, string> = {
  "1.4.10": "reflow",
  "1.4.12": "text-spacing",
  "1.4.4": "resize-text",
  "1.2.1": "audio-only-and-video-only-prerecorded",
  "2.2.1": "timing-adjustable",
  "2.2.2": "pause-stop-hide",
  "2.4.1": "bypass-blocks",
  "2.5.8": "target-size-minimum",
  "3.3.1": "error-identification",
  "3.3.3": "error-suggestion",
  "1.4.11": "non-text-contrast",
  "1.4.1": "use-of-color",
  "1.4.13": "content-on-hover-or-focus",
  "4.1.2": "name-role-value",
  "2.1.1": "keyboard",
};

export function wcagCriterionToSlug(criterion: string): string {
  return WCAG_CRITERION_SLUGS[criterion] ?? "";
}

/**
 * Shared factory for wcag-custom issues. Used by wcag-tests.ts and wcag-legal-checks.ts.
 */
export function makeWcagIssue(
  url: string,
  rule: string,
  impact: ImpactLevel,
  description: string,
  selector: string,
  wcagCriterion?: string,
  violationCategory: ViolationCategory = "structural",
  opts?: {
    checkSource?: Issue["checkSource"];
    llmConfidence?: "high" | "medium" | "low" | null;
    help?: string;
  },
): Issue {
  return {
    id: crypto.randomUUID(),
    url,
    rule,
    impact,
    description,
    help: opts?.help ?? description,
    helpUrl: wcagCriterion
      ? `https://www.w3.org/WAI/WCAG22/Understanding/${wcagCriterionToSlug(wcagCriterion)}`
      : "",
    wcagTags: wcagCriterion ? [`wcag${wcagCriterion.replaceAll(".", "")}`] : [],
    selector,
    html: "",
    surroundingHtml: "",
    xpath: "",
    viewportWidth: 0,
    pageTitle: "",
    checkSource: opts?.checkSource ?? "wcag-custom",
    suggestedFix: null,
    fixConfidence: null,
    llmConfidence: opts?.llmConfidence ?? null,
    wcagCriterion: wcagCriterion ?? null,
    violationCategory,
  };
}

/**
 * CSS selector matching known consent/cookie banner containers.
 * Derived from CONSENT_PREHIDE_CSS in consent-blocker.ts to stay in sync.
 */
import { CONSENT_PREHIDE_CSS } from "./consent-blocker";

export const CONSENT_BANNER_SELECTOR = CONSENT_PREHIDE_CSS
  .replace(/\{[^}]+\}/g, "")  // remove CSS declarations
  .split(",")
  .map(s => s.trim())
  .filter(s => s.length > 0)
  .join(", ");
