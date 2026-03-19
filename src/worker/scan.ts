// src/worker/scan.ts
import type { Browser, Page } from "playwright";
import type { Issue } from "../types/issue";
import type { ScanResult, CrawlError, PipelineConfig } from "../types/pipeline";
import { AxeBuilder } from "@axe-core/playwright";
import { SlotPool } from "./slot-pool";
import { NODE_SIGNATURE_FN, simhash } from "../analyzer/fingerprint";
import { insertPageV4, insertIssuesV4 } from "./db";
import { injectConsentPrehideCSS } from "../analyzer/consent-blocker";
import { discoverNavTargets } from "../discovery/nav";
import type { LLMClient } from "../llm/client";
import { AuditTracer } from "./tracer";

const MIN_INTERNAL_LINKS = 3;


interface ScanPhaseResult {
  scanResults: Map<string, ScanResult>;
  allLinks: Map<string, string[]>;
  crawlErrors: CrawlError[];
}

export async function runScanPhase(
  getBrowser: () => Promise<Browser>,
  auditId: string,
  urls: string[],
  resolvedOrigin: string,
  config: PipelineConfig,
  tracer: AuditTracer,
  llmClient: LLMClient | null,
): Promise<ScanPhaseResult> {
  const pool = new SlotPool(config.concurrency, config.pagesPerContext);
  const scanResults = new Map<string, ScanResult>();
  const allLinks = new Map<string, string[]>();
  const crawlErrors: CrawlError[] = [];

  async function scanPage(url: string): Promise<void> {
    const slot = await pool.acquire();
    try {
      await tracer.trace("scan:page", async (span) => {
        span.setMeta({ url });
        const context = await slot.get(getBrowser, "scan");
        const page = await context.newPage();
        try {
          // Navigate with error handling
          let response: Awaited<ReturnType<typeof page.goto>> | null = null;
          try {
            response = await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: config.pageTimeout,
            });
          } catch (err) {
            crawlErrors.push({ url, error: err instanceof Error ? err.message : String(err), timestamp: new Date() });
            span.end("error", "navigation-failed");
            return;
          }

          if (!response) {
            crawlErrors.push({ url, error: "no-response", timestamp: new Date() });
            span.end("error", "no-response");
            return;
          }

          const status = response.status();
          if (status >= 500) {
            // Retry once for server errors
            await page.waitForTimeout(2_000);
            try {
              const retry = await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.pageTimeout });
              if (!retry || retry.status() >= 400) {
                crawlErrors.push({ url, error: `http-${retry?.status() ?? status}`, timestamp: new Date() });
                span.end("error", `http-${retry?.status() ?? status}`);
                return;
              }
            } catch {
              crawlErrors.push({ url, error: `http-${status}-retry-failed`, timestamp: new Date() });
              span.end("error", `http-${status}-retry-failed`);
              return;
            }
          } else if (status >= 400) {
            crawlErrors.push({ url, error: `http-${status}`, timestamp: new Date() });
            span.end("error", `http-${status}`);
            return;
          }

          // Release response reference — context accumulates metadata per Playwright #6319
          response = null;

          // Check same-origin after redirect
          const finalUrl = page.url();
          if (new URL(finalUrl).origin !== resolvedOrigin) return;

          // Inject CSS prehide for consent banners
          await injectConsentPrehideCSS(page);

          // Batch DOM extraction: fingerprint + links + capabilities
          const domData = await page.evaluate(`
            (function() {
              ${NODE_SIGNATURE_FN}
              var links = Array.from(document.querySelectorAll("a[href]"), function(a) { return a.href; });
              var hasForms = document.querySelectorAll("form").length > 0;
              var hasMedia = document.querySelectorAll("video, audio, iframe[src*='youtube'], iframe[src*='vimeo']").length > 0;
              var hasCarousel = !!document.querySelector('[class*="carousel" i], [class*="slider" i], [aria-roledescription="carousel"]');
              var hasDataTables = document.querySelectorAll("table:not([role='presentation'])").length > 0;
              var isSpaShell = !!(
                document.querySelector("app-root, #root, #app, #__next, #__nuxt") &&
                document.querySelectorAll("a[href]").length < 3
              );
              return {
                fingerprint: nodeSignature(document.body, 0),
                title: document.title,
                links: links,
                elementCount: document.querySelectorAll("*").length,
                capabilities: { hasForms: hasForms, hasMedia: hasMedia, hasCarousel: hasCarousel, hasDataTables: hasDataTables, isSpaShell: isSpaShell },
              };
            })()
          `) as {
            fingerprint: string;
            title: string;
            links: string[];
            elementCount: number;
            capabilities: {
              hasForms: boolean;
              hasMedia: boolean;
              hasCarousel: boolean;
              hasDataTables: boolean;
              isSpaShell: boolean;
            };
          };

          // axe-core FULL — all WCAG AA rules (results cached for probe phase reuse)
          let axeIssues: Issue[] = [];
          try {
            const axeResults = await new AxeBuilder({ page })
              .setLegacyMode(true)
              .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
              .options({ resultTypes: ["violations", "incomplete"] })
              .analyze();

            axeIssues = axeResults.violations.flatMap((v) =>
              v.nodes.map((node) => ({
                id: crypto.randomUUID(),
                url: finalUrl,
                rule: v.id,
                impact: (v.impact ?? "minor") as Issue["impact"],
                description: node.failureSummary ? `${v.description}. ${node.failureSummary}` : v.description,
                help: v.help,
                helpUrl: v.helpUrl,
                wcagTags: v.tags,
                selector: node.target.join(", "),
                html: node.html,
                surroundingHtml: "",
                xpath: "",
                viewportWidth: 1280,
                pageTitle: domData.title,
                checkSource: "axe" as const,
                suggestedFix: node.failureSummary ?? "",
                fixConfidence: null,
                llmConfidence: null,
                wcagCriterion: "",
                violationCategory: "structural" as const,
              })),
            );
          } catch {
            // axe failure is non-fatal
          }

          // LLM nav discovery fallback for SPA shells
          let discoveryMethod: ScanResult["discoveryMethod"] = "standard";
          let links = domData.links as string[];

          const internalLinks = links.filter((l) => {
            try { return new URL(l).origin === resolvedOrigin; } catch { return false; }
          });

          if (internalLinks.length < MIN_INTERNAL_LINKS && domData.capabilities.isSpaShell && llmClient) {
            await page.waitForLoadState("networkidle").catch(() => {});
            const reExtracted: string[] = await page.evaluate(() =>
              Array.from(document.querySelectorAll("a[href]"), (a) => (a as HTMLAnchorElement).href),
            );

            if (reExtracted.filter((l) => { try { return new URL(l).origin === new URL(location.href).origin; } catch { return false; } }).length < MIN_INTERNAL_LINKS) {
              // Still no links — use LLM
              try {
                discoveryMethod = "llm";
              } catch {
                // LLM failure is non-fatal
              }
            } else {
              links = reExtracted;
              discoveryMethod = "networkidle-retry";
            }
          }

          // Persist immediately
          const pageId = await insertPageV4(auditId, {
            url: finalUrl,
            title: domData.title,
            fingerprint: domData.fingerprint,
            elementCount: domData.elementCount,
            capabilities: domData.capabilities,
            issueCount: axeIssues.length,
          });

          if (axeIssues.length > 0) {
            await insertIssuesV4(
              auditId,
              pageId,
              axeIssues.map((i) => ({
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
              })),
            );
          }

          const result: ScanResult = {
            url: finalUrl,
            fingerprint: domData.fingerprint,
            title: domData.title,
            links,
            elementCount: domData.elementCount,
            capabilities: domData.capabilities,
            axeIssues,
            pageId,
            discoveryMethod,
          };

          scanResults.set(finalUrl, result);
          allLinks.set(finalUrl, links);

          span.setMeta({
            axeIssueCount: axeIssues.length,
            elementCount: domData.elementCount,
            linkCount: links.length,
            discoveryMethod,
          });
        } finally {
          try { await page.close(); } catch { /* already closed */ }
        }
      });
    } finally {
      pool.release(slot);
    }
  }

  try {
    await Promise.all(urls.map((url) => scanPage(url)));
  } finally {
    await pool.closeAll();
  }

  await tracer.flush(); // Phase boundary flush — SCAN spans survive even if CLASSIFY/PROBE crash

  return { scanResults, allLinks, crawlErrors };
}
