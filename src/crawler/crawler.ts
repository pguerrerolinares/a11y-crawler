import type { PlaywrightCrawlingContext } from "crawlee";
import type { CrawlConfig } from "../types/config.ts";
import type { PageResult } from "../types/page.ts";
import type { Issue } from "../types/issue.ts";
import type { LLMClient } from "../llm/client.ts";
import { runAxe } from "../analyzer/axe.ts";
import { buildRepresentation } from "../repr/tier.ts";
import { discoverNavTargets } from "../discovery/nav.ts";
import { enrichIssues } from "../enrichment/llm.ts";
import { isBlacklistedAction, isBlacklistedUrl } from "./safety.ts";

export interface HandlerDeps {
  config: CrawlConfig;
  llmClient: LLMClient;
  discoveredUrls: Map<string, "link" | "sitemap" | "interaction">;
}

export function createRequestHandler(deps: HandlerDeps) {
  const { config, llmClient, discoveredUrls } = deps;

  return async function requestHandler(
    context: PlaywrightCrawlingContext,
  ): Promise<PageResult> {
    const { page, request, enqueueLinks, log } = context;
    const startTime = Date.now();
    const url = request.loadedUrl || request.url;

    log.info(`Processing: ${url}`);

    // STEP 1: Navigate (already done by Crawlee, but ensure networkidle)
    try {
      await page.waitForLoadState("networkidle", { timeout: config.pageTimeout });
    } catch {
      // Timeout waiting for networkidle is acceptable
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
    const navTargets = await discoverNavTargets(url, title, repr, llmClient);
    log.info(`Nav targets: ${navTargets.length}`);

    // STEP 5: Standard link extraction
    await enqueueLinks({
      strategy: "same-origin",
      transformRequestFunction: (req) => {
        if (isBlacklistedUrl(req.url)) return false;
        if (!discoveredUrls.has(normalizeUrl(req.url))) {
          discoveredUrls.set(normalizeUrl(req.url), "link");
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
        await page.waitForTimeout(1500);
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

    // STEP 7: LLM-enrich critical/serious issues
    const issuesToEnrich = axeIssues.filter((i) =>
      config.enrichImpactThreshold.includes(i.impact),
    );
    let enrichedIssues = axeIssues;
    if (issuesToEnrich.length > 0) {
      const enriched = await enrichIssues(issuesToEnrich, llmClient);
      const enrichedMap = new Map(enriched.map((i) => [i.id, i]));
      enrichedIssues = axeIssues.map((i) => enrichedMap.get(i.id) || i);
    }

    // STEP 8: Build PageResult
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
      discoveryMethods: Object.fromEntries(discoveredUrls),
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
