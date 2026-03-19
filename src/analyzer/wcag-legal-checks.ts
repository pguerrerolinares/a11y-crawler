// src/analyzer/wcag-legal-checks.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import { makeWcagIssue } from "./utils";

/**
 * WCAG 2.4.1 — Skip Navigation + Ley 11/2023 — Accessibility Declaration
 * Both are zero-cost DOM checks that run on every page.
 */
export async function testLegalA11y(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // --- Check 1: Skip Navigation (WCAG 2.4.1) ---
  const skipResult = await page.evaluate(() => {
    const skipPatterns = /saltar|skip|ir al contenido|jump to|main content|aller au contenu/i;
    const skipHrefPatterns = /#main|#content|#contenido|#principal/i;

    // Look for a skip link among the first 5 interactive elements in the DOM.
    // Require href to start with '#' to ensure it's an in-page anchor.
    const interactives = document.querySelectorAll("a[href], button, [tabindex]");
    const first5 = Array.from(interactives).slice(0, 5);

    for (const el of first5) {
      const text = (el.textContent || "").trim();
      const href = el.getAttribute("href") || "";
      if (
        href.startsWith("#") &&
        (skipPatterns.test(text) || skipHrefPatterns.test(href))
      ) {
        return { hasSkipLink: true };
      }
    }

    // Fallback: any visually-hidden skip link anywhere in the page
    const allLinks = document.querySelectorAll("a[href]");
    for (const link of allLinks) {
      const text = (link.textContent || "").trim();
      const href = link.getAttribute("href") || "";
      if (
        href.startsWith("#") &&
        (skipPatterns.test(text) || skipHrefPatterns.test(href))
      ) {
        return { hasSkipLink: true };
      }
    }

    return { hasSkipLink: false };
  });

  if (!skipResult.hasSkipLink) {
    issues.push(makeWcagIssue(
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
    // Require specific phrasing to avoid false negatives from generic "accessibility" links
    const declarationTextPattern = /declaraci[oó]n\s*(de\s*)?accesibilidad|accessibility\s+statement|accessibility\s+declaration|accessibilit[eé]\s+d[ée]claration/i;
    const declarationHrefPattern = /declaraci[oó]n.*accesib|accessibility[-_]statement|accesibilidad/i;

    // Search footer first (most common location), then fall back to whole body
    const footer = document.querySelector("footer, [role='contentinfo']");
    const searchAreas = footer ? [footer, document.body] : [document.body];

    for (const area of searchAreas) {
      const links = area.querySelectorAll("a[href]");
      for (const link of links) {
        const text = (link.textContent || "").trim();
        const href = (link.getAttribute("href") || "").toLowerCase();

        if (
          (declarationTextPattern.test(text) && text.length < 80) ||
          declarationHrefPattern.test(href)
        ) {
          return { hasDeclaration: true };
        }
      }
    }

    return { hasDeclaration: false };
  });

  if (!declResult.hasDeclaration) {
    issues.push(makeWcagIssue(
      url,
      "accessibility-declaration-missing",
      "serious",
      "No accessibility declaration found on the page. Spanish Law 11/2023 (Ley de Accesibilidad Digital) requires a published accessibility statement including conformance status, contact procedure for complaints, and link to the competent authority.",
      "body",
    ));
  }

  return issues;
}
