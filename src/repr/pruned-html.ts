import type { Page } from "playwright";

const NAV_SELECTORS = [
  "nav",
  '[role="navigation"]',
  '[role="menubar"]',
  '[role="banner"]',
  "header",
  ".nav", ".navbar", ".navigation", ".menu", ".main-nav",
  "#nav", "#navbar", "#navigation", "#menu", "#main-nav",
  "footer",
];

/**
 * Extract navigation-related HTML subtrees from the page.
 */
export async function getPrunedHtml(page: Page): Promise<string> {
  const parts: string[] = [];

  for (const selector of NAV_SELECTORS) {
    try {
      const elements = await page.locator(selector).all();
      for (const el of elements) {
        const html = await el.innerHTML();
        if (html.trim()) {
          parts.push(`<!-- ${selector} -->\n${stripHtmlNoise(html)}`);
        }
      }
    } catch {
      // Element not found, continue
    }
  }

  return parts.join("\n\n");
}

/**
 * Strip noise from HTML: scripts, styles, SVGs, data attributes, inline styles, comments.
 */
export function stripHtmlNoise(html: string): string {
  return html
    // Remove script tags and content
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    // Remove style tags and content
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Remove SVG tags and content
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, "")
    // Remove data-* attributes (except data-testid)
    .replace(/\s+data-(?!testid)[\w-]+(="[^"]*")?/gi, "")
    // Remove inline styles
    .replace(/\s+style="[^"]*"/gi, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}
