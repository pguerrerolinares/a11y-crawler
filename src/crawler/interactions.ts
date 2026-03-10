import type { Page } from "playwright";
import type { NavTarget } from "../types/page.ts";
import type { CrawlConfig } from "../types/config.ts";
import { isBlacklistedAction, isBlacklistedUrl } from "./safety.ts";

/**
 * Click nav targets discovered by LLM, extract newly revealed URLs.
 * Returns discovered URLs with origin "interaction".
 *
 * Stops interactions if a click causes navigation (URL change).
 */
export async function interactWithTargets(
  page: Page,
  targets: NavTarget[],
  config: Pick<CrawlConfig, "maxNavTargets">,
  baseOrigin: string,
): Promise<string[]> {
  const discoveredUrls: string[] = [];

  for (const target of targets.slice(0, config.maxNavTargets)) {
    if (isBlacklistedAction(target.description)) continue;

    try {
      const elementCount = await page.locator(target.selector).count().catch(() => 0);
      if (elementCount === 0 || elementCount > 5) continue;

      const urlBefore = page.url();
      await page.locator(target.selector).click({ timeout: 3000 });
      await page.waitForTimeout(300);
      const urlAfter = page.url();

      if (urlAfter !== urlBefore) {
        // Navigation occurred — record URL, stop interactions
        try {
          const newUrl = new URL(urlAfter);
          if (newUrl.origin === baseOrigin && !isBlacklistedUrl(urlAfter)) {
            discoveredUrls.push(urlAfter);
          }
        } catch {}
        break;
      } else {
        // No navigation — scan for newly revealed links
        const newLinks = await page.$$eval("a[href]", (anchors) =>
          anchors.map((a) => {
            try { return new URL(a.href).href; } catch { return ""; }
          }).filter(Boolean),
        );

        for (const link of newLinks) {
          try {
            const url = new URL(link);
            if (url.origin === baseOrigin && !isBlacklistedUrl(link)) {
              discoveredUrls.push(link);
            }
          } catch {}
        }
      }
    } catch {
      // Interaction failed — continue to next target
    }
  }

  return discoveredUrls;
}
