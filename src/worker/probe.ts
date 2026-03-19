// src/worker/probe.ts
import type { Browser, Page } from "playwright";
import type { Issue } from "../types/issue";
import type { TemplateCluster, TestType, PipelineConfig } from "../types/pipeline";
import { AxeBuilder } from "@axe-core/playwright";
import { ProbeContextManager } from "./probe-context";
import { insertPageV4, insertIssuesV4, insertTier3Job } from "./db";
import { injectConsentPrehideCSS } from "../analyzer/consent-blocker";
import { runInteractiveTests } from "../analyzer/interactive";
import { testReflow, testTextSpacing, testResizeText, testMultimedia, testTimedEvents, testTargetSize, testErrorIdentification, testNonTextContrast } from "../analyzer/wcag-tests";
import { AuditTracer } from "./tracer";
import type { LLMClient } from "../llm/client";
import { testMeaningfulSequence } from "../analyzer/wcag-meaningful-sequence";
import { testSemanticStructure } from "../analyzer/wcag-semantic-structure";
import { testStatusMessages } from "../analyzer/wcag-status-messages";
import { testColorUse } from "../analyzer/wcag-color-use";
import { testSensoryInstructions } from "../analyzer/wcag-sensory-instructions";
import { testLegalA11y } from "../analyzer/wcag-legal-checks";
import { collectManifest, groupByFingerprint } from "./manifest";
import { runTier1 } from "./tier1";
import { runTier2 } from "./tier2";
import { TierTimer } from "./tier-timer";

const TEMPLATE_LEVEL_RULES = new Set([
  "color-contrast", "color-contrast-enhanced", "heading-order",
  "landmark-one-main", "region", "bypass", "html-has-lang",
  "html-lang-valid", "page-has-heading-one", "tabindex",
  "reflow", "text-spacing", "resize-text", "non-text-contrast",
  "focus-order", "focus-visible", "keyboard-trap", "skip-nav",
  "target-size",
  // v4.3
  "meaningful-sequence", "meaningful-sequence-reorder",
  "semantic-pseudo-heading", "semantic-pseudo-list", "semantic-missing-fieldset",
  "aria-state-missing",
  "hover-focus-not-persistent", "hover-focus-not-hoverable", "hover-focus-not-dismissible",
  "status-message-no-live-region",
  // v4.4
  "color-use-link-color-only", "color-use-status-color-only",
  "color-use-cvd", "color-use-llm",
  "sensory-instruction",
  // v4.5
  "skip-nav-missing", "accessibility-declaration-missing",
  "state-change-low-contrast",
  // v5 tier system
  "state-change-contrast", "hover-focus", "aria-states", "keyboard-operability",
]);

export async function runProbePhase(
  getBrowser: () => Promise<Browser>,
  auditId: string,
  templates: TemplateCluster[],
  config: PipelineConfig,
  tracer: AuditTracer,
  llmClient: LLMClient | null = null,
): Promise<void> {
  const probeCtx = new ProbeContextManager(getBrowser, config.probePagesPerContext);

  try {
    for (const cluster of templates) {
      const url = cluster.representative;

      await tracer.trace("probe:representative", async (parentSpan) => {
        parentSpan.setMeta({ url, templateId: cluster.id, testPlan: cluster.testPlan });

        const context = await probeCtx.get();
        const page = await context.newPage();
        const timer = new TierTimer(auditId, cluster.id, url);

        try {
          await page.goto(url, { waitUntil: "load", timeout: 60_000 });
          await injectConsentPrehideCSS(page);

          const allIssues: Issue[] = [];

          // --- Tier 0: Element Interaction Manifest ---
          timer.startTier("tier0");
          const manifest = await collectManifest(page);
          const styleGroups = groupByFingerprint(manifest);
          timer.endTier("tier0", {
            elementsDiscovered: manifest.length,
            styleGroups: styleGroups.length,
            representativeElements: styleGroups.length,
          });

          // 1. axe-core full (needs clean DOM — run first)
          if (cluster.testPlan.includes("axe-full")) {
            const axeIssues = await runAxeFull(page, url, config);
            allIssues.push(...axeIssues);
            parentSpan.setMeta({ axeViolations: axeIssues.length });
          }

          // 1.5. Error identification (form interaction — must run before interactive tests)
          if (cluster.testPlan.includes("error-identification")) {
            const errorIdIssues = await testErrorIdentification(page, url);
            allIssues.push(...errorIdIssues);
            parentSpan.setMeta({ errorIdViolations: errorIdIssues.length });
          }

          // 2. page.evaluate()-only tests (parallel) — unchanged
          const evaluateTests: Promise<Issue[]>[] = [];
          if (cluster.testPlan.includes("target-size")) evaluateTests.push(testTargetSize(page, url));
          if (cluster.testPlan.includes("multimedia")) evaluateTests.push(testMultimedia(page, url));
          if (cluster.testPlan.includes("timed-events")) evaluateTests.push(testTimedEvents(page, url));
          if (cluster.testPlan.includes("non-text-contrast")) evaluateTests.push(testNonTextContrast(page, url));
          if (cluster.testPlan.includes("meaningful-sequence")) evaluateTests.push(testMeaningfulSequence(page, url));
          if (cluster.testPlan.includes("semantic-structure")) evaluateTests.push(testSemanticStructure(page, url));
          if (cluster.testPlan.includes("legal-a11y")) evaluateTests.push(testLegalA11y(page, url));
          const evaluateResults = await Promise.all(evaluateTests);
          allIssues.push(...evaluateResults.flat());

          // 3. Interactive tests (legacy — kept for non-tiered rules)
          if (cluster.testPlan.includes("interactive")) {
            const interactiveIssues = await runInteractiveTests(page, url);
            allIssues.push(...interactiveIssues);
          }

          // --- Tier 1: DOM/CSSOM Analysis (replaces separate state-change, hover-focus, aria-states) ---
          const { issues: tier1Issues, promotedElements } = await runTier1(page, styleGroups, url, timer);
          allIssues.push(...tier1Issues);

          // --- Tier 2: Unified Interaction Pass (only elements Tier 1 couldn't resolve) ---
          const { issues: tier2Issues, promotedToTier3 } = await runTier2(page, promotedElements, url, timer);
          allIssues.push(...tier2Issues);

          // --- Tier 3: Queue async LLM vision jobs ---
          if (promotedToTier3.length > 0 && llmClient) {
            const tier3Elements = promotedToTier3.map(el => ({
              selector: el.selector,
              context: `${el.tag} element: ${el.accessibleName || el.selector}`,
              promptType: "color-use-link", // default; specialized by test context
            }));
            await insertTier3Job(auditId, cluster.id, tier3Elements, 2).catch(err => {
              console.warn(`[probe] Failed to insert tier3 job: ${err}`);
            });
          }

          // 3.5. Status messages (form autofill — not replaced by tier system)
          const withTimeout = <T>(fn: Promise<T>, ms = 30_000): Promise<T | null> =>
            Promise.race([fn, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

          if (cluster.testPlan.includes("status-messages")) {
            const r = await withTimeout(testStatusMessages(page, url));
            if (r) allIssues.push(...r);
          }

          // 4. Viewport tests (sequential — each modifies viewport)
          if (cluster.testPlan.includes("reflow")) {
            allIssues.push(...await testReflow(page, url));
          }
          if (cluster.testPlan.includes("resize-text")) {
            allIssues.push(...await testResizeText(page, url));
          }

          // 5. Text spacing (CSS injection — modifies page, run last)
          if (cluster.testPlan.includes("text-spacing")) {
            allIssues.push(...await testTextSpacing(page, url));
          }

          // 6. CVD color analysis (screenshots — run after viewport tests restore)
          if (cluster.testPlan.includes("color-use")) {
            const colorResult = await withTimeout(testColorUse(page, url, llmClient), 45_000);
            if (colorResult) {
              allIssues.push(...colorResult.issues);
              if (colorResult.screenshots.length > 0) {
                const { join } = await import("node:path");
                const screenshotDir = join(
                  process.env.REPORTS_DIR || "./reports",
                  auditId, "screenshots",
                );
                await Bun.write(join(screenshotDir, ".keep"), "");
                const templatePrefix = cluster.id.slice(0, 8);
                for (const ss of colorResult.screenshots) {
                  await Bun.write(join(screenshotDir, `${templatePrefix}-${ss.deficiency}-normal.png`), ss.normalPng);
                  await Bun.write(join(screenshotDir, `${templatePrefix}-${ss.deficiency}-cvd.png`), ss.cvdPng);
                }
              }
            }
          }

          // 7. Sensory instructions (LLM text analysis — can run anytime)
          if (cluster.testPlan.includes("sensory-instructions")) {
            const r = await withTimeout(testSensoryInstructions(page, url, llmClient), 30_000);
            if (r) allIssues.push(...r);
          }

          // --- Template amplification ---
          const templateIssues = allIssues.filter((i) => TEMPLATE_LEVEL_RULES.has(i.rule));

          // Representative page: ALL issues
          const repPageId = await insertPageV4(auditId, {
            url,
            title: await page.title(),
            templateId: cluster.id,
            isRepresentative: true,
            issueCount: allIssues.length,
          });
          await insertIssuesV4(auditId, repPageId, allIssues.map((i) => ({
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
            suggestedFix: i.suggestedFix ?? undefined,
            fixConfidence: null,
            templateId: cluster.id,
          })));

          // Other pages: ONLY template-level issues (amplified)
          for (const memberUrl of cluster.urls.filter((u) => u !== url)) {
            if (templateIssues.length > 0) {
              const pageId = await insertPageV4(auditId, {
                url: memberUrl,
                templateId: cluster.id,
                isRepresentative: false,
                issueCount: templateIssues.length,
              });
              await insertIssuesV4(auditId, pageId, templateIssues.map((i) => ({
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
                suggestedFix: i.suggestedFix ?? undefined,
                fixConfidence: null,
                templateId: cluster.id,
                affectedPages: cluster.urls.length,
                amplifiedFrom: url,
              })));
            }
          }

          parentSpan.setMeta({
            totalIssues: allIssues.length,
            templateIssues: templateIssues.length,
            amplifiedToPages: cluster.urls.length - 1,
            tier0Elements: manifest.length,
            tier1Issues: tier1Issues.length,
            tier2Issues: tier2Issues.length,
            tier3Queued: promotedToTier3.length,
            tierTiming: timer.getTiming(),
          });
        } finally {
          try { await page.close(); } catch { /* already closed */ }
          await tracer.flush(); // Phase boundary flush per representative
        }
      });
    }
  } finally {
    await probeCtx.close();
  }
}

async function runAxeFull(page: Page, url: string, config: PipelineConfig): Promise<Issue[]> {
  const tags =
    config.wcagLevel === "AAA"
      ? ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "wcag2aaa", "wcag21aaa"]
      : config.wcagLevel === "AA"
        ? ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
        : ["wcag2a", "wcag21a"];

  const results = await new AxeBuilder({ page })
    .withTags(tags)
    .options({ resultTypes: ["violations", "incomplete"] })
    .analyze();

  return results.violations.flatMap((v) =>
    v.nodes.map((node) => ({
      id: crypto.randomUUID(),
      url,
      rule: v.id,
      impact: (v.impact ?? "minor") as Issue["impact"],
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      wcagTags: v.tags,
      selector: node.target.join(", "),
      html: node.html,
      surroundingHtml: "",
      xpath: "",
      viewportWidth: 1280,
      pageTitle: "",
      checkSource: "axe" as const,
      suggestedFix: node.failureSummary ?? "",
      fixConfidence: null,
      llmConfidence: null,
      wcagCriterion: "",
      violationCategory: "structural" as const,
    })),
  );
}
