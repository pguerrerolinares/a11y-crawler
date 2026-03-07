import { PlaywrightCrawler } from "crawlee";
import type { CrawlConfig } from "./types/config.ts";
import type { SiteReport, CrawlError } from "./types/report.ts";
import type { PageResult } from "./types/page.ts";
import type { ImpactLevel, ViolationCategory } from "./types/issue.ts";
import { LLMClient } from "./llm/client.ts";
import { createRequestHandler } from "./crawler/crawler.ts";
import { discoverSitemapUrls } from "./crawler/sitemap.ts";
import { detectSharedIssues } from "./reporter/shared.ts";
import { DEFAULT_CONFIG } from "./types/config.ts";

export async function audit(
  userConfig: Partial<CrawlConfig> & { baseUrl: string; apiKey: string },
): Promise<SiteReport> {
  const config: CrawlConfig = { ...DEFAULT_CONFIG, ...userConfig };
  const startTime = Date.now();
  const pages: PageResult[] = [];
  const errors: CrawlError[] = [];
  const discoveredUrls = new Map<string, "link" | "sitemap" | "interaction">();

  const llmClient = new LLMClient({
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    model: config.model,
    rateLimitRpm: config.rateLimitRpm,
  });

  // Phase 1: Sitemap discovery
  const seedUrls: string[] = [config.baseUrl];
  if (!config.skipSitemap) {
    console.log("=== Sitemap Discovery ===");
    const sitemapUrls = await discoverSitemapUrls(config.baseUrl);
    console.log(`Found ${sitemapUrls.length} URLs from sitemap`);
    const baseOrigin = new URL(config.baseUrl).origin;
    for (const url of sitemapUrls) {
      try {
        if (new URL(url).origin === baseOrigin) {
          discoveredUrls.set(url, "sitemap");
          seedUrls.push(url);
        }
      } catch {}
    }
    // Limit sitemap seeds
    if (seedUrls.length > config.maxPages / 2) {
      seedUrls.length = Math.ceil(config.maxPages / 2);
    }
  }

  // Phase 2: Crawl + Analyze
  console.log("\n=== Crawl + Analysis ===");
  const handler = createRequestHandler({ config, llmClient, discoveredUrls });

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: config.maxPages,
    maxConcurrency: config.concurrency,
    requestHandlerTimeoutSecs: config.pageTimeout / 1000 * 3,
    headless: true,

    async requestHandler(context) {
      try {
        const result = await handler(context);
        pages.push(result);
        console.log(
          `  [${pages.length}] ${result.url} - ${result.issues.length} issues (${result.representationTier})`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          url: context.request.url,
          phase: "navigation",
          message: msg,
          timestamp: new Date().toISOString(),
        });
      }
    },

    failedRequestHandler({ request }, error) {
      errors.push({
        url: request.url,
        phase: "navigation",
        message: error.message,
        timestamp: new Date().toISOString(),
      });
    },
  });

  await crawler.run(seedUrls);

  // Phase 3: Post-processing
  console.log("\n=== Post-processing ===");
  const sharedIssues = detectSharedIssues(pages);
  console.log(`Detected ${sharedIssues.length} shared issues`);

  const allIssues = pages.flatMap((p) => p.issues);
  const totalDuration = Math.round((Date.now() - startTime) / 1000);

  const countByImpact = (level: ImpactLevel) =>
    allIssues.filter((i) => i.impact === level).length;
  const countByCategory = (cat: ViolationCategory) =>
    allIssues.filter((i) => i.violationCategory === cat).length;

  const issuesByRule: Record<string, number> = {};
  for (const issue of allIssues) {
    issuesByRule[issue.rule] = (issuesByRule[issue.rule] || 0) + 1;
  }

  const estimatedCost =
    (llmClient.usage.totalInputTokens + llmClient.usage.totalOutputTokens) *
    0.000001; // rough estimate

  return {
    meta: {
      version: "2.0.0",
      generatedAt: new Date().toISOString(),
      baseUrl: config.baseUrl,
      wcagLevel: config.wcagLevel,
      totalDurationSeconds: totalDuration,
      toolVersions: {
        crawler: "2.0.0",
        axeCore: "4.10.x",
        playwright: "1.50.x",
      },
    },
    pages,
    summary: {
      totalPages: pages.length,
      totalIssues: allIssues.length,
      issuesByImpact: {
        critical: countByImpact("critical"),
        serious: countByImpact("serious"),
        moderate: countByImpact("moderate"),
        minor: countByImpact("minor"),
      },
      issuesByRule,
      issuesByCategory: {
        structural: countByCategory("structural"),
        interactive: countByCategory("interactive"),
        visual: countByCategory("visual"),
        media: countByCategory("media"),
        semantic: countByCategory("semantic"),
      },
      pagesWithZeroIssues: pages.filter((p) => p.issues.length === 0).length,
      averageIssuesPerPage:
        pages.length > 0 ? Math.round((allIssues.length / pages.length) * 100) / 100 : 0,
    },
    sharedIssues,
    discovery: {
      totalUrlsDiscovered: discoveredUrls.size,
      urlsFromSitemap: [...discoveredUrls.values()].filter((s) => s === "sitemap").length,
      urlsFromLinks: [...discoveredUrls.values()].filter((s) => s === "link").length,
      urlsFromInteraction: [...discoveredUrls.values()].filter((s) => s === "interaction").length,
      urlsAnalyzed: pages.length,
      urlsSkipped: discoveredUrls.size - pages.length,
    },
    llmUsage: {
      totalCalls: llmClient.usage.totalCalls,
      totalInputTokens: llmClient.usage.totalInputTokens,
      totalOutputTokens: llmClient.usage.totalOutputTokens,
      estimatedCostUsd: Math.round(estimatedCost * 100) / 100,
      callsByPurpose: {
        navigation: llmClient.usage.navigationCalls,
        enrichment: llmClient.usage.enrichmentCalls,
      },
    },
    errors,
  };
}
