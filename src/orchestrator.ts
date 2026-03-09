// src/orchestrator.ts
import { PlaywrightCrawler } from "crawlee";
import type { CrawlConfig } from "./types/config.ts";
import type { SiteReport, CrawlError } from "./types/report.ts";
import type { ProgressCallback } from "./types/events.ts";
import type { PageResult } from "./types/page.ts";
import type { ImpactLevel, ViolationCategory } from "./types/issue.ts";
import { LLMClient, COST_PER_TOKEN_USD } from "./llm/client.ts";
import { createRequestHandler } from "./crawler/crawler.ts";
import { discoverSitemapUrls } from "./crawler/sitemap.ts";
import { detectSharedIssues } from "./reporter/shared.ts";
import { DEFAULT_CONFIG } from "./types/config.ts";

function aggregateUsage(clients: LLMClient[]): { totalCalls: number; totalInputTokens: number; totalOutputTokens: number } {
  return clients.reduce(
    (acc, c) => ({
      totalCalls: acc.totalCalls + c.usage.totalCalls,
      totalInputTokens: acc.totalInputTokens + c.usage.totalInputTokens,
      totalOutputTokens: acc.totalOutputTokens + c.usage.totalOutputTokens,
    }),
    { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 },
  );
}

export async function audit(
  userConfig: Partial<CrawlConfig> & { baseUrl: string; apiKey: string },
  onProgress?: ProgressCallback,
): Promise<SiteReport> {
  const config: CrawlConfig = { ...DEFAULT_CONFIG, ...userConfig };
  const startTime = Date.now();
  const pages: PageResult[] = [];
  const errors: CrawlError[] = [];
  const discoveredUrls = new Map<string, "link" | "sitemap" | "interaction">();

  // Three specialized LLM clients
  const clientBase = {
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    rateLimitRpm: config.rateLimitRpm,
  };
  const navClient = new LLMClient({ ...clientBase, model: config.navModel });
  const enrichClient = new LLMClient({ ...clientBase, model: config.enrichModel });
  const enrichVisualClient = new LLMClient({ ...clientBase, model: config.enrichVisualModel });

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
    if (seedUrls.length > config.maxPages / 2) {
      seedUrls.length = Math.ceil(config.maxPages / 2);
    }
  }

  // Phase 2: Crawl + Analyze
  console.log("\n=== Crawl + Analysis ===");
  const handler = createRequestHandler({
    config,
    navClient,
    enrichClient,
    enrichVisualClient,
    discoveredUrls,
  });

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: config.maxPages,
    maxConcurrency: config.concurrency,
    requestHandlerTimeoutSecs: (config.pageTimeout / 1000) * 8, // 240s — nav interactions + LLM calls
    maxRequestRetries: 1, // reduce retry loops on timeout
    headless: true,
    launchContext: {
      launchOptions: {
        args: ["--disable-dev-shm-usage", "--no-sandbox"],
      },
    },

    async requestHandler(context) {
      try {
        const result = await handler(context);
        pages.push(result);
        console.log(
          `  [${pages.length}] ${result.url} - ${result.issues.length} issues (${result.representationTier})`,
        );
        onProgress?.({
          type: "page_analyzed",
          data: { url: result.url, issueCount: result.issues.length, title: result.title },
        });
        onProgress?.({
          type: "progress",
          data: { pagesAnalyzed: pages.length, totalDiscovered: discoveredUrls.size, elapsedSeconds: Math.round((Date.now() - startTime) / 1000) },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          url: context.request.url,
          phase: "navigation",
          message: msg,
          timestamp: new Date().toISOString(),
        });
        onProgress?.({ type: "error", data: { url: context.request.url, message: msg } });
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

  // Token usage summary
  printTokenSummary(navClient, enrichClient, enrichVisualClient, config);

  const allIssues = pages.flatMap((p) => p.issues);
  const totalDuration = Math.round((Date.now() - startTime) / 1000);

  onProgress?.({ type: "completed", data: { totalPages: pages.length, totalIssues: allIssues.length } });

  const countByImpact = (level: ImpactLevel) =>
    allIssues.filter((i) => i.impact === level).length;
  const countByCategory = (cat: ViolationCategory) =>
    allIssues.filter((i) => i.violationCategory === cat).length;

  const issuesByRule: Record<string, number> = {};
  for (const issue of allIssues) {
    issuesByRule[issue.rule] = (issuesByRule[issue.rule] || 0) + 1;
  }

  const usage = aggregateUsage([navClient, enrichClient, enrichVisualClient]);
  const estimatedCost = (usage.totalInputTokens + usage.totalOutputTokens) * COST_PER_TOKEN_USD;

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
        pages.length > 0
          ? Math.round((allIssues.length / pages.length) * 100) / 100
          : 0,
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
      totalCalls: usage.totalCalls,
      totalInputTokens: usage.totalInputTokens,
      totalOutputTokens: usage.totalOutputTokens,
      estimatedCostUsd: Math.round(estimatedCost * 100) / 100,
      callsByPurpose: {
        navigation: navClient.usage.navigationCalls,
        enrichment:
          enrichClient.usage.enrichmentCalls + enrichVisualClient.usage.enrichmentCalls,
      },
    },
    errors,
  };
}

function printTokenSummary(
  navClient: LLMClient,
  enrichClient: LLMClient,
  enrichVisualClient: LLMClient,
  config: CrawlConfig,
): void {
  const fmt = (n: number) => n.toLocaleString();
  const cost = (inp: number, out: number) =>
    `~$${((inp + out) * COST_PER_TOKEN_USD).toFixed(3)}`;

  const navU = navClient.usage;
  const enrU = enrichClient.usage;
  const visU = enrichVisualClient.usage;

  const agg = aggregateUsage([navClient, enrichClient, enrichVisualClient]);

  console.log("\n=== LLM Usage ===");
  console.log(
    `Nav discovery  (${config.navModel}): ${navU.totalCalls} calls | ${fmt(navU.totalInputTokens)} in | ${fmt(navU.totalOutputTokens)} out | ${cost(navU.totalInputTokens, navU.totalOutputTokens)}`,
  );
  console.log(
    `Enrichment     (${config.enrichModel}): ${enrU.totalCalls} calls | ${fmt(enrU.totalInputTokens)} in | ${fmt(enrU.totalOutputTokens)} out | ${cost(enrU.totalInputTokens, enrU.totalOutputTokens)}`,
  );
  console.log(
    `Enrichment vis (${config.enrichVisualModel}): ${visU.totalCalls} calls | ${fmt(visU.totalInputTokens)} in | ${fmt(visU.totalOutputTokens)} out | ${cost(visU.totalInputTokens, visU.totalOutputTokens)}`,
  );
  console.log("─".repeat(75));
  console.log(
    `Total: ${agg.totalCalls} calls | ${fmt(agg.totalInputTokens)} in | ${fmt(agg.totalOutputTokens)} out | ${cost(agg.totalInputTokens, agg.totalOutputTokens)}`,
  );
}
