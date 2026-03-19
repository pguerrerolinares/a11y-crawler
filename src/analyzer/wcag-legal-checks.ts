// src/analyzer/wcag-legal-checks.ts
import type { Page } from "playwright";
import type { Issue, ImpactLevel } from "../types/issue";

function makeIssue(
  url: string,
  rule: string,
  impact: ImpactLevel,
  description: string,
  selector: string,
  wcagCriterion: string,
): Issue {
  return {
    id: crypto.randomUUID(),
    url,
    rule,
    impact,
    description,
    help: description,
    helpUrl: `https://www.w3.org/WAI/WCAG22/Understanding/${wcagCriterion === "2.4.1" ? "bypass-blocks" : ""}`,
    wcagTags: wcagCriterion ? [`wcag${wcagCriterion.replace(".", "")}`] : [],
    selector,
    html: "",
    surroundingHtml: "",
    xpath: "",
    viewportWidth: 0,
    pageTitle: "",
    checkSource: "wcag-custom",
    suggestedFix: null,
    fixConfidence: null,
    llmConfidence: null,
    wcagCriterion,
    violationCategory: "structural",
  };
}

/**
 * WCAG 2.4.1 — Skip Navigation + Ley 11/2023 — Accessibility Declaration
 * Both are zero-cost DOM checks that run on every page.
 */
export async function testLegalA11y(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // --- Check 1: Skip Navigation (WCAG 2.4.1) ---
  const skipResult = await page.evaluate(() => {
    // Look for a skip link among the first 5 interactive elements in the DOM
    const interactives = document.querySelectorAll("a[href], button, [tabindex]");
    const first5 = Array.from(interactives).slice(0, 5);

    const skipPatterns = /saltar|skip|ir al contenido|jump to|main content|aller au contenu/i;
    const skipHrefPatterns = /#main|#content|#contenido|#principal/i;

    for (const el of first5) {
      const text = (el.textContent || "").trim();
      const href = el.getAttribute("href") || "";
      if (skipPatterns.test(text) || skipHrefPatterns.test(href)) {
        return { hasSkipLink: true };
      }
    }

    // Also check for any visually-hidden skip link anywhere in the page
    const allLinks = document.querySelectorAll("a[href]");
    for (const link of allLinks) {
      const text = (link.textContent || "").trim();
      const href = link.getAttribute("href") || "";
      if (
        (skipPatterns.test(text) || skipHrefPatterns.test(href)) &&
        (href.startsWith("#"))
      ) {
        return { hasSkipLink: true };
      }
    }

    return { hasSkipLink: false };
  });

  if (!skipResult.hasSkipLink) {
    issues.push(makeIssue(
      url,
      "skip-nav-missing",
      "moderate",
      "No skip navigation link found. Users who navigate by keyboard or screen reader must tab through all repeated content (header, navigation) on every page. Add a 'Skip to main content' link as the first focusable element.",
      "body",
      "2.4.1",
    ));
  }

  // --- Check 2: Accessibility Declaration (Ley 11/2023) ---
  const declResult = await page.evaluate(() => {
    const declarationPatterns = /accesibilidad|accessibility|accessibilit[eé]/i;
    const hrefPatterns = /accesibilidad|accessibility|declaraci[oó]n.*accesib/i;

    // Search in footer first (most common location)
    const footer = document.querySelector("footer, [role='contentinfo']");
    const searchAreas = footer
      ? [footer, document.body]
      : [document.body];

    for (const area of searchAreas) {
      const links = area.querySelectorAll("a[href]");
      for (const link of links) {
        const text = (link.textContent || "").trim().toLowerCase();
        const href = (link.getAttribute("href") || "").toLowerCase();

        if (
          (declarationPatterns.test(text) && text.length < 80) ||
          hrefPatterns.test(href)
        ) {
          return { hasDeclaration: true, matchedText: text, matchedHref: href };
        }
      }
    }

    return { hasDeclaration: false };
  });

  if (!declResult.hasDeclaration) {
    issues.push(makeIssue(
      url,
      "accessibility-declaration-missing",
      "serious",
      "No accessibility declaration found on the page. Spanish Law 11/2023 (Ley de Accesibilidad Digital) requires a published accessibility statement including conformance status, contact procedure for complaints, and link to the competent authority.",
      "body",
      "",
    ));
  }

  return issues;
}
