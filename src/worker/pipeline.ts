// src/worker/pipeline.ts
import type { Browser } from "playwright";
import type { PipelineConfig, CrawlError } from "../types/pipeline";
import type { LLMClient } from "../llm/client";
import { AuditTracer } from "./tracer";
import { persistSpans, markAuditCompleted, markAuditFailed, emitAuditEvent } from "./db";
import { runScanPhase } from "./scan";
import { runProbePhase } from "./probe";
import { clusterPages, buildTestPlan, selectRepresentative, prioritizeTemplates } from "../analyzer/classify";
import { UrlQueue } from "../crawler/queue";
import { discoverSitemapUrls } from "../crawler/sitemap";

export async function runPipeline(
  getBrowser: () => Promise<Browser>,
  auditId: string,
  userConfig: Partial<PipelineConfig> & { baseUrl: string },
  llmClient: LLMClient | null,
): Promise<void> {
  const config: PipelineConfig = {
    maxPages: userConfig.maxPages ?? 50,
    maxDepth: userConfig.maxDepth ?? 5,
    wcagLevel: userConfig.wcagLevel ?? "AA",
    pageTimeout: userConfig.pageTimeout ?? 15_000,
    concurrency: userConfig.concurrency ?? 3,
    pagesPerContext: userConfig.pagesPerContext ?? 25,
    probePagesPerContext: userConfig.probePagesPerContext ?? 5,
    maxProbeTemplates: userConfig.maxProbeTemplates ?? 25,
    navModel: userConfig.navModel ?? "kimi-k2-turbo-preview",
    rateLimitRpm: userConfig.rateLimitRpm ?? 10,
    baseUrl: userConfig.baseUrl,
  };

  const tracer = new AuditTracer(auditId, (spans) => persistSpans(spans));
  const startTime = Date.now();
  const startMemory = process.memoryUsage().heapUsed;

  try {
    await tracer.trace("audit:run", async (auditSpan) => {
      auditSpan.setMeta({ url: config.baseUrl, maxPages: config.maxPages, startMemoryMb: Math.round(startMemory / 1024 / 1024) });

      // ── Resolve redirects to get canonical origin ──
      const resolvedOrigin = await resolveOrigin(config.baseUrl);

      // ── Seed URLs (base + sitemap) ──
      const queue = new UrlQueue(config.maxPages, config.maxDepth);
      queue.seed([config.baseUrl], "link", 0);

      // Discover sitemap URLs
      try {
        const sitemapUrls = await discoverSitemapUrls(config.baseUrl);
        const sameOriginUrls = sitemapUrls.filter((u) => {
          try { return new URL(u).origin === resolvedOrigin; } catch { return false; }
        });
        queue.seed(sameOriginUrls, "sitemap", 1);
      } catch {
        // Sitemap discovery is non-fatal
      }

      // Collect all URLs to scan
      const urlsToScan: string[] = [];
      let url: string | null;
      while ((url = queue.next()) !== null) {
        urlsToScan.push(url);
      }

      await emitAuditEvent(auditId, "scan:start", { pageCount: urlsToScan.length });

      // ══════════════════════════════════════════════
      // PHASE 1: SCAN
      // ══════════════════════════════════════════════
      const { scanResults, allLinks, crawlErrors } = await tracer.trace("audit:scan", async (scanSpan) => {
        const result = await runScanPhase(
          getBrowser, auditId, urlsToScan, resolvedOrigin, config, tracer, llmClient,
        );
        scanSpan.setMeta({
          pageCount: result.scanResults.size,
          errorCount: result.crawlErrors.length,
        });

        // Feed discovered links back into queue for additional pages
        for (const [pageUrl, links] of result.allLinks) {
          const depth = queue.getDepth(pageUrl) ?? 1;
          const sameOriginLinks = links.filter((l) => {
            try { return new URL(l).origin === resolvedOrigin; } catch { return false; }
          });
          queue.seed(sameOriginLinks, "link", depth + 1);
        }

        // Scan any newly discovered URLs
        const additionalUrls: string[] = [];
        let nextUrl: string | null;
        while ((nextUrl = queue.next()) !== null) {
          additionalUrls.push(nextUrl);
        }

        if (additionalUrls.length > 0) {
          const additional = await runScanPhase(
            getBrowser, auditId, additionalUrls, resolvedOrigin, config, tracer, llmClient,
          );
          for (const [k, v] of additional.scanResults) result.scanResults.set(k, v);
          result.crawlErrors.push(...additional.crawlErrors);
        }

        return result;
      });

      await emitAuditEvent(auditId, "scan:complete", { pagesScanned: scanResults.size });

      // ══════════════════════════════════════════════
      // PHASE 2: CLASSIFY
      // ══════════════════════════════════════════════
      const templates = await tracer.trace("audit:classify", async (classifySpan) => {
        const allResults = [...scanResults.values()];
        const clusters = clusterPages(allResults);

        // Select representatives and build test plans
        for (const cluster of clusters) {
          cluster.representative = selectRepresentative(cluster, scanResults);
          cluster.testPlan = buildTestPlan(cluster);
        }

        // Cap templates for PROBE
        const { probed, skipped } = prioritizeTemplates(clusters, config.maxProbeTemplates);

        classifySpan.setMeta({
          templateCount: clusters.length,
          probedCount: probed.length,
          skippedCount: skipped.length,
        });

        return probed;
      });

      await tracer.flush(); // Phase boundary flush — CLASSIFY spans survive if PROBE crashes

      await emitAuditEvent(auditId, "probe:start", {
        templateCount: templates.length,
        representatives: templates.map((t) => t.representative),
      });

      // ══════════════════════════════════════════════
      // PHASE 3: PROBE
      // ══════════════════════════════════════════════
      await tracer.trace("audit:probe", async (probeSpan) => {
        await runProbePhase(getBrowser, auditId, templates, config, tracer);
        probeSpan.setMeta({ templatesProbed: templates.length });
      });

      // ── Post-processing ──
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      const endMemory = process.memoryUsage().heapUsed;
      auditSpan.setMeta({ endMemoryMb: Math.round(endMemory / 1024 / 1024), durationSeconds });

      // Build summary
      const summary = {
        totalPages: scanResults.size,
        totalTemplates: templates.length,
        pipelineVersion: "v4.0",
      };

      await markAuditCompleted(
        auditId,
        summary,
        { totalUrlsDiscovered: scanResults.size, urlsFromSitemap: 0, urlsFromLinks: scanResults.size, urlsFromInteraction: 0 },
        (llmClient?.usage ?? { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, navigationCalls: 0, enrichmentCalls: 0 }) as unknown as Record<string, unknown>,
        durationSeconds,
        null, // wcag_score computed separately if needed
        crawlErrors.length > 0 ? crawlErrors : null,
      );

      await emitAuditEvent(auditId, "audit:complete", { durationSeconds });
    });
  } catch (err) {
    await markAuditFailed(auditId, err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await tracer.flush(); // Final flush for any remaining spans
  }
}

async function resolveOrigin(baseUrl: string): Promise<string> {
  try {
    const resp = await fetch(baseUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    return new URL(resp.url).origin;
  } catch {
    return new URL(baseUrl).origin;
  }
}
