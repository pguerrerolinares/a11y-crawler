// src/worker/probe.ts
import type { Browser, Page } from "playwright";
import type { Issue } from "../types/issue";
import type { TemplateCluster, PipelineConfig } from "../types/pipeline";
import type { ElementManifest, StyleGroup } from "../types/manifest";
import { AxeBuilder } from "@axe-core/playwright";
import { ProbeContextManager } from "./probe-context";
import { insertPageV4, insertIssuesV4 } from "./db-pages";
import { insertTier3Job } from "./db-tier3";
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
import type { HoverFocusCache } from "./tier2";
import { collectManifest, groupByFingerprint } from "./manifest";
import { runTier1 } from "./tier1";
import { runTier2 } from "./tier2";
import { TierTimer } from "./tier-timer";
import { enableAnimations } from "./adaptive-wait";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { computeCssFingerprint } from "../analyzer/screenshot-cvd";
import { computeColorUseFingerprint, collectDomStructure, computeDomHash } from "./probe-cache";

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
  "custom-element-not-focusable",
]);

const withTimeout = <T>(fn: Promise<T>, ms = 30_000): Promise<T | null> =>
  Promise.race([fn, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

export async function runProbePhase(
  getBrowser: () => Promise<Browser>,
  auditId: string,
  templates: TemplateCluster[],
  config: PipelineConfig,
  tracer: AuditTracer,
  llmClient: LLMClient | null = null,
  axeCache?: Map<string, Issue[]>,
): Promise<void> {
  const probeCtx = new ProbeContextManager(getBrowser, config.probePagesPerContext);
  const cvdCache = new Map<string, { diffPercent: number; issues: Issue[] }>();
  const viewportCache = new Map<string, Issue[]>();
  const hfCache: HoverFocusCache = new Map();
  const tier1Cache = new Map<string, { issues: Issue[]; promotedElements: ElementManifest[] }>();
  const evaluateCache = new Map<string, Issue[]>();

  try {
    for (const cluster of templates) {
      const url = cluster.representative;

      await tracer.trace("probe:representative", async (parentSpan) => {
        parentSpan.setMeta({ url, templateId: cluster.id, testPlan: cluster.testPlan });

        const context = await probeCtx.get();
        const page = await context.newPage();
        const timer = new TierTimer(auditId, cluster.id, url);

        try {
          const gotoStart = Date.now();
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await injectConsentPrehideCSS(page);
          const navigationMs = Date.now() - gotoStart;

          const allIssues: Issue[] = [];

          {
            const phaseTimings: Record<string, number> = { navigationMs };

            // ── Tier 0: Element Interaction Manifest (shared across Phase 1 and 2) ──
            timer.startTier("tier0");
            const manifest = await collectManifest(page);
            const styleGroups = groupByFingerprint(manifest);
            timer.endTier("tier0", {
              elementsDiscovered: manifest.length,
              styleGroups: styleGroups.length,
              representativeElements: styleGroups.length,
            });

            // Compute cssFingerprint once per template (used by Phase 3 + Phase 4)
            const cssFingerprint = await computeCssFingerprint(page);

            // ── Phase 1: Static — Tier 1, axe, evaluate tests (no DOM mutation) ──
            const p1Start = Date.now();
            const { issues: phase1Issues, promotedElements } = await runPhase1Static(
              page, cluster, url, timer, styleGroups, axeCache, config, llmClient, parentSpan,
              cssFingerprint, tier1Cache, evaluateCache,
            );
            allIssues.push(...phase1Issues);
            phaseTimings.phase1StaticMs = Date.now() - p1Start;

            // ── Phase 2: Interaction — Tier 2, interactive tests, re-enable animations ──
            const p2Start = Date.now();
            const { issues: phase2Issues, promotedToTier3 } = await runPhase2Interaction(
              page, promotedElements, url, timer, cluster, hfCache,
            );
            allIssues.push(...phase2Issues);
            phaseTimings.phase2InteractionMs = Date.now() - p2Start;

            // ── Phase 3: Viewport — reflow, resize-text, text-spacing ──
            const p3Start = Date.now();
            const phase3Issues = await runPhase3Viewport(page, url, cluster, viewportCache, cssFingerprint);
            allIssues.push(...phase3Issues);
            phaseTimings.phase3ViewportMs = Date.now() - p3Start;

            // ── Phase 4: Capture — color-use screenshots, status messages, Tier 3 queue ──
            const p4Start = Date.now();
            const phase4Issues = await runPhase4Capture(
              page, url, cluster, auditId, llmClient, promotedToTier3, cvdCache,
              cssFingerprint, manifest,
            );
            allIssues.push(...phase4Issues);
            phaseTimings.phase4CaptureMs = Date.now() - p4Start;
            phaseTimings.totalTemplateMs = Date.now() - gotoStart;

            parentSpan.setMeta({ phaseTimings });
          }

          // ── Template amplification ──
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

// ── Phase 1: Static (Tier 1, axe, evaluate tests — no DOM mutation) ──

async function runPhase1Static(
  page: Page,
  cluster: TemplateCluster,
  url: string,
  timer: TierTimer,
  styleGroups: StyleGroup[],
  axeCache: Map<string, Issue[]> | undefined,
  config: PipelineConfig,
  llmClient: LLMClient | null,
  parentSpan: { setMeta: (m: Record<string, unknown>) => void },
  cssFingerprint: string,
  tier1Cache: Map<string, { issues: Issue[]; promotedElements: ElementManifest[] }>,
  evaluateCache: Map<string, Issue[]>,
): Promise<{ issues: Issue[]; promotedElements: ElementManifest[] }> {
  const issues: Issue[] = [];

  // Tier 1: CSSOM hover contrast (cache by cssFingerprint — same CSS = same CSSOM results)
  let promotedElements: ElementManifest[];
  if (tier1Cache.has(cssFingerprint)) {
    const cached = tier1Cache.get(cssFingerprint)!;
    issues.push(...cached.issues.map(i => ({ ...i, url, id: crypto.randomUUID() })));
    promotedElements = cached.promotedElements;
  } else {
    const { issues: tier1Issues, promotedElements: promoted } = await runTier1(page, styleGroups, url, timer);
    issues.push(...tier1Issues);
    promotedElements = promoted;
    tier1Cache.set(cssFingerprint, { issues: tier1Issues, promotedElements: promoted });
  }

  // axe-core (from cache or fallback)
  if (cluster.testPlan.includes("axe-full")) {
    let axeIssues: Issue[];
    if (axeCache?.has(url)) {
      axeIssues = axeCache.get(url)!;
    } else {
      axeIssues = await runAxeFull(page, url, config);
    }
    issues.push(...axeIssues);
    parentSpan.setMeta({ axeViolations: axeIssues.length });
  }

  // Error identification (must run before interactive tests)
  if (cluster.testPlan.includes("error-identification")) {
    const errorIdIssues = await testErrorIdentification(page, url);
    issues.push(...errorIdIssues);
    parentSpan.setMeta({ errorIdViolations: errorIdIssues.length });
  }

  // page.evaluate()-only tests (parallel, read-only) — cache by domHash
  const domStructure = await collectDomStructure(page);
  const domHash = computeDomHash(domStructure);

  if (evaluateCache.has(domHash)) {
    issues.push(...evaluateCache.get(domHash)!.map(i => ({ ...i, url, id: crypto.randomUUID() })));
  } else {
    const evaluateTests: Promise<Issue[]>[] = [];
    if (cluster.testPlan.includes("target-size")) evaluateTests.push(testTargetSize(page, url));
    if (cluster.testPlan.includes("multimedia")) evaluateTests.push(testMultimedia(page, url));
    if (cluster.testPlan.includes("timed-events")) evaluateTests.push(testTimedEvents(page, url));
    if (cluster.testPlan.includes("non-text-contrast")) evaluateTests.push(testNonTextContrast(page, url));
    if (cluster.testPlan.includes("meaningful-sequence")) evaluateTests.push(testMeaningfulSequence(page, url));
    if (cluster.testPlan.includes("semantic-structure")) evaluateTests.push(testSemanticStructure(page, url));
    if (cluster.testPlan.includes("legal-a11y")) evaluateTests.push(testLegalA11y(page, url));
    const evalResults = await Promise.all(evaluateTests);
    const evalIssues = evalResults.flat();
    issues.push(...evalIssues);
    evaluateCache.set(domHash, evalIssues);
  }

  // Sensory instructions (LLM text analysis — can run during static phase)
  if (cluster.testPlan.includes("sensory-instructions")) {
    const r = await withTimeout(testSensoryInstructions(page, url, llmClient), 30_000);
    if (r) issues.push(...r);
  }

  return { issues, promotedElements };
}

// ── Phase 2: Interaction (Tier 2, interactive tests, re-enable animations) ──

async function runPhase2Interaction(
  page: Page,
  promotedElements: ElementManifest[],
  url: string,
  timer: TierTimer,
  cluster: TemplateCluster,
  hfCache: HoverFocusCache,
): Promise<{ issues: Issue[]; promotedToTier3: ElementManifest[] }> {
  const issues: Issue[] = [];

  // Tier 2: unified interaction pass
  const { issues: tier2Issues, promotedToTier3 } = await runTier2(page, promotedElements, url, timer, hfCache);
  issues.push(...tier2Issues);

  // Legacy interactive tests (minus keyboard-operability, now handled by Tier 2)
  if (cluster.testPlan.includes("interactive")) {
    const interactiveIssues = await runInteractiveTests(page, url);
    issues.push(...interactiveIssues);
  }

  // Re-enable animations disabled by Tier 2 (for viewport tests and screenshots)
  await enableAnimations(page);

  return { issues, promotedToTier3 };
}

// ── Phase 3: Viewport (reflow, resize-text, text-spacing — viewport mutation) ──

async function runPhase3Viewport(
  page: Page,
  url: string,
  cluster: TemplateCluster,
  viewportCache: Map<string, Issue[]>,
  cssFingerprint: string,
): Promise<Issue[]> {
  const hasViewportTests = cluster.testPlan.includes("reflow") ||
    cluster.testPlan.includes("resize-text") || cluster.testPlan.includes("text-spacing");
  if (!hasViewportTests) return [];

  // Viewport tests are style-dependent (CSS, not content).
  // Skip if a template with the same CSS fingerprint was already tested.
  const fingerprint = cssFingerprint;
  if (viewportCache.has(fingerprint)) {
    return viewportCache.get(fingerprint)!.map(i => ({ ...i, url, id: crypto.randomUUID() }));
  }

  const issues: Issue[] = [];

  if (cluster.testPlan.includes("reflow")) {
    issues.push(...await testReflow(page, url));
  }
  if (cluster.testPlan.includes("resize-text")) {
    issues.push(...await testResizeText(page, url));
  }
  if (cluster.testPlan.includes("text-spacing")) {
    issues.push(...await testTextSpacing(page, url));
  }

  viewportCache.set(fingerprint, issues);
  return issues;
}

// ── Phase 4: Capture (color-use screenshots, status messages, Tier 3 queue) ──

async function runPhase4Capture(
  page: Page,
  url: string,
  cluster: TemplateCluster,
  auditId: string,
  llmClient: LLMClient | null,
  promotedToTier3: ElementManifest[],
  cvdCache: Map<string, { diffPercent: number; issues: Issue[] }>,
  cssFingerprint: string,
  manifest: ElementManifest[],
): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Defensive viewport reset after Phase 3 modifications
  await page.setViewportSize({ width: 1280, height: 720 });

  // Color-use CVD + Status messages — run in parallel (independent tests, same page)
  const parallel: Promise<Issue[] | null>[] = [];

  if (cluster.testPlan.includes("color-use")) {
    const screenshotDir = join(process.env.REPORTS_DIR || "./reports", auditId, "screenshots");
    await mkdir(screenshotDir, { recursive: true });
    parallel.push(
      withTimeout(
        testColorUse(
        page, url, llmClient, screenshotDir, cluster.id.slice(0, 8), cvdCache,
        computeColorUseFingerprint(cssFingerprint, manifest),
      ),
        45_000,
      ).then(r => r?.issues ?? []),
    );
  }

  if (cluster.testPlan.includes("status-messages")) {
    parallel.push(
      withTimeout(testStatusMessages(page, url), 30_000),
    );
  }

  const results = await Promise.all(parallel);
  for (const r of results) {
    if (r) issues.push(...r);
  }

  // Tier 3: queue async LLM vision jobs
  if (promotedToTier3.length > 0 && llmClient) {
    const tier3Elements = promotedToTier3.map(el => ({
      selector: el.selector,
      context: `${el.tag} element: ${el.accessibleName || el.selector}`,
      promptType: "color-use-link",
    }));
    await insertTier3Job(auditId, cluster.id, tier3Elements, 2).catch(err => {
      console.warn(`[probe] Failed to insert tier3 job: ${err}`);
    });
  }

  return issues;
}

// ── Shared axe-core full scan ──

async function runAxeFull(page: Page, url: string, config: PipelineConfig): Promise<Issue[]> {
  const tags =
    config.wcagLevel === "AAA"
      ? ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "wcag2aaa", "wcag21aaa"]
      : config.wcagLevel === "AA"
        ? ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]
        : ["wcag2a", "wcag21a"];

  const results = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(tags)
    .options({ resultTypes: ["violations", "incomplete"] })
    .analyze();

  return results.violations.flatMap((v) =>
    v.nodes.map((node) => ({
      id: crypto.randomUUID(),
      url,
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
