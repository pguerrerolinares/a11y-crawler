import type { Page } from "playwright";
import { isBlacklistedUrl } from "./safety.ts";

/**
 * Extract all same-origin <a href> links from the current page DOM.
 * Runs in the browser context on the fully rendered page.
 */
export async function extractLinks(page: Page, baseOrigin: string): Promise<string[]> {
  const hrefs: string[] = await page.$$eval("a[href]", (anchors) =>
    anchors
      .map((a) => {
        try {
          return new URL((a as HTMLAnchorElement).href).href;
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );

  return filterLinks(hrefs, baseOrigin);
}

/**
 * Filter links to same-origin, non-blacklisted URLs.
 * Exported separately for unit testing without a browser.
 */
export function filterLinks(hrefs: string[], baseOrigin: string): string[] {
  return hrefs.filter((href) => {
    try {
      const url = new URL(href);
      return url.origin === baseOrigin && !isBlacklistedUrl(href);
    } catch {
      return false;
    }
  });
}
