// src/crawler/crawler.ts
import type { PlaywrightCrawlingContext } from "crawlee";
import type { CrawlConfig } from "../types/config.ts";
import type { PageResult } from "../types/page.ts";
import type { Issue } from "../types/issue.ts";
import type { LLMClient } from "../llm/client.ts";
import type { PageScreenshots } from "../enrichment/prompts.ts";
import { runAxe } from "../analyzer/axe.ts";
import { buildRepresentation } from "../repr/tier.ts";
import { discoverNavTargets } from "../discovery/nav.ts";
import { enrichIssues } from "../enrichment/llm.ts";
import { isBlacklistedAction, isBlacklistedUrl } from "./safety.ts";
import type { Page } from "playwright";

export interface HandlerDeps {
  config: CrawlConfig;
  navClient: LLMClient;
  enrichClient: LLMClient;
  enrichVisualClient: LLMClient;
  discoveredUrls: Map<string, "link" | "sitemap" | "interaction">;
}

/**
 * Capture viewport screenshots at 3 widths.
 * Restores original viewport after capture.
 */
export async function captureScreenshots(page: Page): Promise<PageScreenshots> {
  const original = page.viewportSize() ?? { width: 1280, height: 900 };
  const viewports = [
    { width: 375, key: "mobile" as const },
    { width: 768, key: "tablet" as const },
    { width: 1280, key: "desktop" as const },
  ];

  const screenshots: Partial<PageScreenshots> = {};

  for (const { width, key } of viewports) {
    try {
      await page.setViewportSize({ width, height: original.height });
      const buf = await page.screenshot({ type: "png", fullPage: false });
      screenshots[key] = buf.toString("base64");
    } catch {
      screenshots[key] = "";
    }
  }

  // Restore original viewport
  await page.setViewportSize(original).catch(() => {});

  return screenshots as PageScreenshots;
}

export function createRequestHandler(deps: HandlerDeps) {
  const { config, navClient, enrichClient, enrichVisualClient, discoveredUrls } = deps;

  return async function requestHandler(
    context: PlaywrightCrawlingContext,
  ): Promise<PageResult> {
    const { page, request, enqueueLinks, log } = context;
    const startTime = Date.now();
    const url = request.loadedUrl || request.url;

    log.info(`Processing: ${url}`);

    // STEP 1: Wait for networkidle
    try {
      await page.waitForLoadState("networkidle", { timeout: config.pageTimeout });
    } catch {
      // Timeout is acceptable
    }

    // STEP 2: Run axe-core FIRST (before any interactions)
    let axeIssues: Issue[] = [];
    try {
      axeIssues = await runAxe(page, { wcagLevel: config.wcagLevel });
    } catch (err) {
      log.warning(`axe-core failed on ${url}: ${err}`);
    }

    // STEP 3: Build page representation
    const repr = await buildRepresentation(page);
    log.info(`Representation: ${repr.tier} (~${repr.tokenEstimate} tokens)`);

    // STEP 4: LLM navigation discovery
    const title = await page.title();
    const navTargets = await discoverNavTargets(url, title, repr, navClient);
    log.info(`Nav targets: ${navTargets.length}`);

    // STEP 5: Standard link extraction
    await enqueueLinks({
      strategy: "same-origin",
      transformRequestFunction: (req) => {
        if (isBlacklistedUrl(req.url)) return false;
        const norm = normalizeUrl(req.url);
        if (!discoveredUrls.has(norm)) {
          discoveredUrls.set(norm, "link");
        }
        return req;
      },
    });

    // STEP 6: Interact with nav targets
    for (const target of navTargets) {
      if (isBlacklistedAction(target.description)) continue;

      try {
        const urlBefore = page.url();
        await page.locator(target.selector).click({ timeout: 3000 });
        await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
        const urlAfter = page.url();

        if (urlAfter !== urlBefore) {
          const normalized = normalizeUrl(urlAfter);
          if (
            new URL(urlAfter).origin === new URL(url).origin &&
            !isBlacklistedUrl(urlAfter) &&
            !discoveredUrls.has(normalized)
          ) {
            discoveredUrls.set(normalized, "interaction");
            await context.addRequests([{ url: urlAfter }]);
          }
          await page.goBack({ waitUntil: "networkidle" }).catch(() => {});
        } else {
          await enqueueLinks({
            strategy: "same-origin",
            transformRequestFunction: (req) => {
              if (isBlacklistedUrl(req.url)) return false;
              const norm = normalizeUrl(req.url);
              if (!discoveredUrls.has(norm)) {
                discoveredUrls.set(norm, "interaction");
              }
              return req;
            },
          });
        }
      } catch {
        log.debug(`Interaction failed: ${target.description}`);
      }
    }

    // STEP 7: LLM-enrich critical/serious issues (per-violation, Málaga approach)
    const issuesToEnrich = axeIssues.filter((i) =>
      config.enrichImpactThreshold.includes(i.impact),
    );
    let enrichedIssues = axeIssues;
    if (issuesToEnrich.length > 0) {
      const hasVisual = issuesToEnrich.some((i) => i.violationCategory === "visual");
      const screenshots = hasVisual
        ? await captureScreenshots(page)
        : { mobile: "", tablet: "", desktop: "" };
      const enriched = await enrichIssues(issuesToEnrich, screenshots, enrichClient, enrichVisualClient);
      const enrichedMap = new Map(enriched.map((i) => [i.id, i]));
      enrichedIssues = axeIssues.map((i) => enrichedMap.get(i.id) || i);
    }

    // STEP 9: Build PageResult
    const groupedByRule: Record<string, Issue[]> = {};
    for (const issue of enrichedIssues) {
      if (!groupedByRule[issue.rule]) groupedByRule[issue.rule] = [];
      groupedByRule[issue.rule].push(issue);
    }

    const pageDiscoveredUrls = [...discoveredUrls.entries()]
      .filter(([u]) => u !== normalizeUrl(url))
      .map(([u]) => u);

    return {
      url,
      title,
      issues: enrichedIssues,
      groupedByRule,
      discoveredUrls: pageDiscoveredUrls,
      discoveryMethods: {},
      representationTier: repr.tier,
      timestamp: new Date().toISOString(),
      processingMs: Date.now() - startTime,
    };
  };
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.href;
  } catch {
    return url;
  }
}
