// src/analyzer/wcag-semantic-structure.ts
import type { Page } from "playwright";
import type { Issue, ImpactLevel } from "../types/issue";

function makeSemanticIssue(
  url: string, rule: string, impact: ImpactLevel,
  description: string, selector: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule, impact, description,
    help: description,
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships",
    wcagTags: ["wcag131"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 0, pageTitle: "",
    checkSource: "wcag-custom",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "1.3.1",
    violationCategory: "semantic",
  };
}

/** Exported for testing: does this computed style look like a heading? */
export function isPseudoHeadingStyle(fontSize: number, fontWeight: number, textLength: number): boolean {
  if (textLength === 0 || textLength > 120) return false;
  return fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
}

/** Exported for testing: do these rects look like a list? */
export function isPseudoListLayout(rects: Array<{ height: number; left: number }>): boolean {
  if (rects.length < 3) return false;
  const heights = rects.map((r) => r.height);
  const lefts = rects.map((r) => r.left);
  const heightDelta = Math.max(...heights) - Math.min(...heights);
  const leftDelta = Math.max(...lefts) - Math.min(...lefts);
  return heightDelta < 8 && leftDelta < 4;
}

/**
 * WCAG 1.3.1 — Info and Relationships: detect visual structures that lack
 * proper HTML semantic markup (pseudo-headings, pseudo-lists, missing fieldsets).
 */
export async function testSemanticStructure(page: Page, url: string): Promise<Issue[]> {
  const findings = await page.evaluate(() => {
    const results: Array<{ type: string; selector: string; detail: string }> = [];

    // --- Pseudo-heading detection ---
    document.querySelectorAll("div, p, span").forEach((el) => {
      const cs = getComputedStyle(el);
      const fontSize = parseFloat(cs.fontSize);
      const fontWeight = parseFloat(cs.fontWeight) || (cs.fontWeight === "bold" ? 700 : 400);
      const text = el.textContent?.trim() ?? "";
      const textLength = text.length;

      if (textLength === 0 || textLength > 120) return;
      const isHeadingStyle = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
      if (!isHeadingStyle) return;

      // Not already inside a heading
      if (el.closest("h1,h2,h3,h4,h5,h6,[role='heading']")) return;
      // Not a link or button (they have their own semantics)
      if (el.closest("a,button")) return;

      const selector =
        el.id ? `#${el.id}` :
        el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : el.tagName.toLowerCase();

      results.push({
        type: "pseudo-heading",
        selector,
        detail: `"${text.slice(0, 60)}" (${fontSize}px, weight ${fontWeight})`,
      });
    });

    // --- Pseudo-list detection ---
    document.querySelectorAll("div, section, main, article").forEach((container) => {
      const children = Array.from(container.children)
        .filter((c) => {
          const tag = c.tagName;
          return !["UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "SCRIPT", "STYLE"].includes(tag)
            && getComputedStyle(c).display !== "none";
        });
      if (children.length < 3) return;
      // Already a list
      if (container.tagName === "UL" || container.tagName === "OL") return;

      const rects = children.map((c) => c.getBoundingClientRect());
      const heights = rects.map((r) => r.height);
      const lefts = rects.map((r) => r.left);
      const heightDelta = Math.max(...heights) - Math.min(...heights);
      const leftDelta = Math.max(...lefts) - Math.min(...lefts);

      if (heightDelta >= 8 || leftDelta >= 4) return;

      // Check repeating tag structure
      const tagPatterns = children.map((c) =>
        Array.from(c.children).map((gc) => gc.tagName).join(","),
      );
      const uniquePatterns = new Set(tagPatterns);
      if (uniquePatterns.size > 2) return; // too varied

      const selector =
        container.id ? `#${container.id}` :
        container.className && typeof container.className === "string"
          ? `${container.tagName.toLowerCase()}.${container.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : container.tagName.toLowerCase();

      results.push({
        type: "pseudo-list",
        selector,
        detail: `${children.length} uniform siblings that look like a list but use <${container.tagName.toLowerCase()}>`,
      });
    });

    // --- Missing fieldset detection ---
    document.querySelectorAll("form, [role='form']").forEach((form) => {
      const inputs = form.querySelectorAll("input, select, textarea");
      if (inputs.length < 4) return;

      // Group by parent container
      const groups = new Map<string, Element[]>();
      inputs.forEach((input) => {
        const parent = input.parentElement;
        if (!parent) return;
        const key = parent.className || parent.id || parent.tagName;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(input);
      });

      for (const [, groupInputs] of groups) {
        if (groupInputs.length < 2) continue;
        const parent = groupInputs[0].parentElement;
        if (!parent) continue;
        if (parent.tagName === "FIELDSET") continue;
        if (parent.getAttribute("role") === "group") continue;
        if (parent.hasAttribute("aria-labelledby")) continue;

        const selector =
          parent.id ? `#${parent.id}` :
          parent.className && typeof parent.className === "string"
            ? `${parent.tagName.toLowerCase()}.${parent.className.trim().split(/\s+/).slice(0, 3).join(".")}`
            : parent.tagName.toLowerCase();

        results.push({
          type: "missing-fieldset",
          selector,
          detail: `${groupInputs.length} related form fields without <fieldset> or role="group"`,
        });
      }
    });

    return results;
  });

  return findings.map((f) => {
    switch (f.type) {
      case "pseudo-heading":
        return makeSemanticIssue(url, "semantic-pseudo-heading", "moderate",
          `Element "${f.selector}" looks like a heading but uses non-heading markup: ${f.detail}`, f.selector);
      case "pseudo-list":
        return makeSemanticIssue(url, "semantic-pseudo-list", "moderate",
          `Container "${f.selector}" contains ${f.detail}`, f.selector);
      case "missing-fieldset":
        return makeSemanticIssue(url, "semantic-missing-fieldset", "moderate",
          `${f.detail} in "${f.selector}"`, f.selector);
      default:
        return makeSemanticIssue(url, "semantic-structure", "moderate", f.detail, f.selector);
    }
  });
}
