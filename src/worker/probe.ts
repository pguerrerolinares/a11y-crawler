// src/worker/probe.ts
import type { Browser, Page } from "playwright";
import type { Issue } from "../types/issue";
import type { TemplateCluster, TestType, PipelineConfig } from "../types/pipeline";
import { AxeBuilder } from "@axe-core/playwright";
import { ProbeContextManager } from "./probe-context";
import { insertPageV4, insertIssuesV4 } from "./db";
import { injectConsentPrehideCSS } from "../analyzer/consent-blocker";
import { runInteractiveTests } from "../analyzer/interactive";
import { testReflow, testTextSpacing, testResizeText, testMultimedia, testTimedEvents, testTargetSize, testErrorIdentification, testNonTextContrast } from "../analyzer/wcag-tests";
import { AuditTracer } from "./tracer";
import type { LLMClient } from "../llm/client";

const TEMPLATE_LEVEL_RULES = new Set([
  "color-contrast", "color-contrast-enhanced", "heading-order",
  "landmark-one-main", "region", "bypass", "html-has-lang",
  "html-lang-valid", "page-has-heading-one", "tabindex",
  "reflow", "text-spacing", "resize-text", "non-text-contrast",
  "focus-order", "focus-visible", "keyboard-trap", "skip-nav",
  "target-size",
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

        try {
          await page.goto(url, { waitUntil: "load", timeout: 60_000 });
          await injectConsentPrehideCSS(page);

          const allIssues: Issue[] = [];

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

          // 2. page.evaluate()-only tests (parallel)
          const evaluateTests: Promise<Issue[]>[] = [];
          if (cluster.testPlan.includes("target-size")) evaluateTests.push(testTargetSize(page, url));
          if (cluster.testPlan.includes("multimedia")) evaluateTests.push(testMultimedia(page, url));
          if (cluster.testPlan.includes("timed-events")) evaluateTests.push(testTimedEvents(page, url));
          if (cluster.testPlan.includes("non-text-contrast")) evaluateTests.push(testNonTextContrast(page, url));
          const evaluateResults = await Promise.all(evaluateTests);
          allIssues.push(...evaluateResults.flat());

          // 3. Interactive tests
          if (cluster.testPlan.includes("interactive")) {
            const interactiveIssues = await runInteractiveTests(page, url);
            allIssues.push(...interactiveIssues);
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
