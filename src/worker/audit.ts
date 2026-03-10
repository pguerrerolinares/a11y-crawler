import type { Browser } from "playwright";
import type { PageResult } from "../types/page.ts";
import type { Issue, ImpactLevel, ViolationCategory } from "../types/issue.ts";
import type { CrawlError } from "../types/report.ts";
import type { NavTarget } from "../types/page.ts";
import { LLMClient } from "../llm/client.ts";
import { UrlQueue } from "../crawler/queue.ts";
import { extractLinks } from "../crawler/links.ts";
import { interactWithTargets } from "../crawler/interactions.ts";
import { discoverSitemapUrls } from "../crawler/sitemap.ts";
import { runAxe } from "../analyzer/axe.ts";
import { runInteractiveTests } from "../analyzer/interactive.ts";
import { buildRepresentation } from "../repr/tier.ts";
import { discoverNavTargets } from "../discovery/nav.ts";
import { detectSharedIssues } from "../reporter/shared.ts";
import {
  emitAuditEvent,
  insertPage,
  insertIssues,
  insertSharedIssues,
  markAuditCompleted,
} from "./db.ts";

export interface AuditConfig {
  baseUrl: string;
  apiKey: string;
  apiBaseUrl: string;
  navModel: string;
  maxPages: number;
  maxDepth: number;
  pageTimeout: number;
  wcagLevel: "A" | "AA" | "AAA";
  skipSitemap: boolean;
  excludePatterns: string[];
  rateLimitRpm: number;
  maxNavTargets: number;
}

const DEFAULT_AUDIT_CONFIG: Omit<AuditConfig, "baseUrl" | "apiKey"> = {
  apiBaseUrl: "https://api.moonshot.ai/v1",
  navModel: "kimi-k2-turbo-preview",
  maxPages: 50,
  maxDepth: 5,
  pageTimeout: 30000,
  wcagLevel: "AA",
  skipSitemap: false,
  excludePatterns: [],
  rateLimitRpm: 10,
  maxNavTargets: 3,
};

export async function runAudit(
  getBrowser: () => Promise<Browser>,
  auditId: string,
  userConfig: Partial<AuditConfig> & { baseUrl: string },
): Promise<void> {
  const config: AuditConfig = {
    ...DEFAULT_AUDIT_CONFIG,
    apiKey: process.env.LLM_API_KEY || "",
    ...userConfig,
  };

  const startTime = Date.now();

  // Resolve redirects to get the final origin (e.g. finnk.com → www.finnk.com)
  let resolvedBaseUrl = config.baseUrl;
  try {
    const res = await fetch(config.baseUrl, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10000) });
    resolvedBaseUrl = res.url;
    if (resolvedBaseUrl !== config.baseUrl) {
      console.log(`Base URL resolved: ${config.baseUrl} → ${resolvedBaseUrl}`);
    }
  } catch {}
  const baseOrigin = new URL(resolvedBaseUrl).origin;

  const queue = new UrlQueue(config.maxPages, config.maxDepth);
  const pages: PageResult[] = [];
  const errors: CrawlError[] = [];

  // Single LLM client — navigation only
  const navClient = new LLMClient({
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    model: config.navModel,
    rateLimitRpm: config.rateLimitRpm,
  });

  // Nav cache
  let lastNavRepr: string | null = null;
  let cachedNavTargets: NavTarget[] = [];

  // Phase 1: Seed URLs (use resolved URL to avoid duplicates)
  queue.seed([resolvedBaseUrl], "link", 0);

  if (!config.skipSitemap) {
    console.log("=== Sitemap Discovery ===");
    const sitemapUrls = await discoverSitemapUrls(resolvedBaseUrl);
    const sameOriginSitemapUrls = sitemapUrls.filter(u => {
      try { return new URL(u).origin === baseOrigin; } catch { return false; }
    });
    console.log(`Found ${sitemapUrls.length} URLs from sitemap (${sameOriginSitemapUrls.length} same-origin)`);
    queue.seed(sameOriginSitemapUrls.slice(0, Math.ceil(config.maxPages / 2)), "sitemap", 1);
  }

  // Phase 2: Process pages
  console.log("\n=== Crawl + Analysis ===");
  let url: string | null;

  while ((url = queue.next()) !== null) {
    let browser: Browser;
    try {
      browser = await getBrowser();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ url, phase: "browser", message, timestamp: new Date().toISOString() });
      console.error(`  Failed to get browser for ${url}: ${message}`);
      continue;
    }

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const page = await context.newPage();
    const pageStart = Date.now();

    try {
      console.log(`Processing: ${url}`);

      // Step 1: Navigate
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: config.pageTimeout });
      } catch {
        // Timeout acceptable
      }

      // Step 1b: Dismiss cookie consent banners
      await dismissCookieBanner(page);


      // Step 2: Axe-core
      let axeIssues: Issue[] = [];
      try {
        axeIssues = await runAxe(page, { wcagLevel: config.wcagLevel });
      } catch (err) {
        console.warn(`axe-core failed on ${url}:`, err);
      }

      // Step 3: Interactive tests
      let interactiveIssues: Issue[] = [];
      try {
        interactiveIssues = await runInteractiveTests(page, url);
      } catch (err) {
        console.warn(`Interactive tests failed on ${url}:`, err);
      }

      // Step 4: Page representation
      const repr = await buildRepresentation(page);
      console.log(`  Representation: ${repr.tier} (~${repr.tokenEstimate} tokens)`);

      // Step 5: Nav discovery (with cache)
      let navTargets: NavTarget[];
      if (repr.content === lastNavRepr && cachedNavTargets.length > 0) {
        navTargets = cachedNavTargets;
        console.log(`  Nav targets: ${navTargets.length} (cached)`);
      } else {
        const title = await page.title();
        navTargets = await discoverNavTargets(url, title, repr, navClient);
        lastNavRepr = repr.content;
        cachedNavTargets = navTargets;
        console.log(`  Nav targets: ${navTargets.length}`);
      }

      // Step 6: Link extraction + interactions
      const currentDepth = queue.getDepth(url);
      const staticLinks = await extractLinks(page, baseOrigin);
      queue.seed(staticLinks, "link", currentDepth + 1);

      const interactionUrls = await interactWithTargets(page, navTargets, config, baseOrigin);
      queue.seed(interactionUrls, "interaction", currentDepth + 1);

      // Build page result
      const allIssues = [...axeIssues, ...interactiveIssues];
      const title = await page.title();
      const processingMs = Date.now() - pageStart;

      const groupedByRule: Record<string, Issue[]> = {};
      for (const issue of allIssues) {
        if (!groupedByRule[issue.rule]) groupedByRule[issue.rule] = [];
        groupedByRule[issue.rule].push(issue);
      }

      const pageResult: PageResult = {
        url,
        title,
        issues: allIssues,
        groupedByRule,
        discoveredUrls: [...staticLinks, ...interactionUrls],
        discoveryMethods: {},
        representationTier: repr.tier,
        timestamp: new Date().toISOString(),
        processingMs,
      };

      pages.push(pageResult);

      // Save to DB
      const issuesByImpact = {
        critical: allIssues.filter((i) => i.impact === "critical").length,
        serious: allIssues.filter((i) => i.impact === "serious").length,
        moderate: allIssues.filter((i) => i.impact === "moderate").length,
        minor: allIssues.filter((i) => i.impact === "minor").length,
      };

      const pageId = await insertPage(auditId, {
        url,
        title,
        issueCount: allIssues.length,
        issuesByImpact,
        durationMs: processingMs,
      });

      await insertIssues(
        auditId,
        pageId,
        allIssues.map((i) => ({
          rule: i.rule,
          impact: i.impact,
          description: i.description,
          help: i.help,
          helpUrl: i.helpUrl,
          wcagTags: i.wcagTags,
          selector: i.selector,
          html: i.html,
          xpath: i.xpath,
          checkSource: i.checkSource,
          category: i.violationCategory,
          suggestedFix: i.suggestedFix,
          fixConfidence: i.fixConfidence,
        })),
      );

      // Emit progress
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
      console.log(`  [${pages.length}] ${url} — ${allIssues.length} issues (${repr.tier})`);

      await emitAuditEvent(auditId, "page_analyzed", {
        url,
        title,
        issueCount: allIssues.length,
        pagesAnalyzed: pages.length,
        totalDiscovered: queue.stats.totalDiscovered,
        elapsedSeconds,
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ url, phase: "navigation", message, timestamp: new Date().toISOString() });
      console.error(`  ERROR on ${url}: ${message}`);
      await emitAuditEvent(auditId, "error", { url, message });

    } finally {
      await context.close();
    }
  }

  // Phase 3: Post-processing
  console.log("\n=== Post-processing ===");
  const sharedIssues = detectSharedIssues(pages);
  console.log(`Detected ${sharedIssues.length} shared issues`);

  await insertSharedIssues(
    auditId,
    sharedIssues.map((si) => ({
      rule: si.rule,
      impact: "serious", // shared issues are at least serious
      normalizedHtml: si.html,
      pageCount: si.pageCount,
      pageUrls: si.affectedPages,
      suggestedFix: si.suggestedFix,
      category: "structural",
    })),
  );

  // Update audit as completed
  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  const allIssues = pages.flatMap((p) => p.issues);

  const countByImpact = (level: ImpactLevel) => allIssues.filter((i) => i.impact === level).length;
  const countByCategory = (cat: ViolationCategory) => allIssues.filter((i) => i.violationCategory === cat).length;

  const issuesByRule: Record<string, number> = {};
  for (const issue of allIssues) {
    issuesByRule[issue.rule] = (issuesByRule[issue.rule] || 0) + 1;
  }

  await markAuditCompleted(
    auditId,
    {
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
      averageIssuesPerPage: pages.length > 0 ? Math.round((allIssues.length / pages.length) * 100) / 100 : 0,
    },
    {
      totalUrlsDiscovered: queue.stats.totalDiscovered,
      urlsFromSitemap: queue.stats.byOrigin.sitemap,
      urlsFromLinks: queue.stats.byOrigin.link,
      urlsFromInteraction: queue.stats.byOrigin.interaction,
      urlsAnalyzed: pages.length,
      urlsSkipped: queue.stats.totalDiscovered - pages.length,
    },
    {
      totalCalls: navClient.usage.totalCalls,
      totalInputTokens: navClient.usage.totalInputTokens,
      totalOutputTokens: navClient.usage.totalOutputTokens,
      callsByPurpose: { navigation: navClient.usage.navigationCalls, enrichment: 0 },
    },
    totalDuration,
  );

  // Emit completed event
  await emitAuditEvent(auditId, "completed", {
    totalPages: pages.length,
    totalIssues: allIssues.length,
    durationSeconds: totalDuration,
  });

  // Print LLM summary
  const u = navClient.usage;
  console.log("\n=== LLM Usage ===");
  console.log(`Nav discovery (${config.navModel}): ${u.totalCalls} calls | ${u.totalInputTokens} in | ${u.totalOutputTokens} out`);
  console.log(`Audit ${auditId} completed: ${pages.length} pages, ${allIssues.length} issues in ${totalDuration}s`);
}

/**
 * Dismiss common cookie consent banners (CookieBot, OneTrust, etc.).
 * Best-effort — failures are silently ignored.
 */
async function dismissCookieBanner(page: import("playwright").Page): Promise<void> {
  const selectors = [
    // CookieBot
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    // OneTrust
    "#onetrust-accept-btn-handler",
    // Cookie Notice / generic
    '[data-cookieconsent="accept"]',
    'button[aria-label*="cookie" i][aria-label*="accept" i]',
    'button[aria-label*="Accept" i]',
    '.cookie-accept',
    '.cc-accept',
    '.cc-btn.cc-dismiss',
    // GDPR generic
    'button:has-text("Accept all")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Aceptar")',
    'button:has-text("Accept")',
  ];

  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ timeout: 1000 });
        await page.waitForTimeout(300);
        return;
      }
    } catch {}
  }
}
