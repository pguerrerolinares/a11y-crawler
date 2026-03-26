// src/worker/probe.ts
import type { Browser, Page } from "playwright";
import type { Issue } from "../types/issue";
import type { TemplateCluster, PipelineConfig } from "../types/pipeline";
import type { ElementManifest, StyleGroup } from "../types/manifest";
import { AxeBuilder } from "@axe-core/playwright";
import { ProbeContextManager } from "./probe-context";
import type { PageLease } from "./probe-context";
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
import { shouldBatch } from "./ram-guard";

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

// ── Types for overlapping loop ──

interface ReadOnlyResult {
  issues: Issue[];
  promotedToTier3: ElementManifest[];
  manifest: ElementManifest[];
  cssFingerprint: string;
  phaseTimings: Record<string, number>;
  timer: TierTimer;
  templateCacheStats: CacheStats;
  pageTitle: string;
  spanMeta: Record<string, unknown>;
  wallClockStart: number;
}

interface MutatingResult {
  issues: Issue[];
  phaseTimings: Record<string, number>;
}

interface CacheStats {
  hfHits: number;
  hfMisses: number;
  tier1Hits: number;
  tier1Misses: number;
  evalHits: number;
  evalMisses: number;
}

interface PendingMutating {
  promise: Promise<MutatingResult>;
  lease: PageLease;
  cluster: TemplateCluster;
  url: string;
  readOnlyResult: ReadOnlyResult;
  overlapped: boolean;
}

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
  const cacheEnabled = process.env.PROBE_CACHE !== "false";
  const hfCache: HoverFocusCache | undefined = cacheEnabled ? new Map() : undefined;
  const tier1Cache = cacheEnabled ? new Map<string, { issues: Issue[] }>() : undefined;
  const evaluateCache = cacheEnabled ? new Map<string, Issue[]>() : undefined;

  const globalCacheStats: CacheStats = { hfHits: 0, hfMisses: 0, tier1Hits: 0, tier1Misses: 0, evalHits: 0, evalMisses: 0 };

  let pendingMutating: PendingMutating | null = null;
  let pendingPrefetchLease: PageLease | null = null;

  try {
    for (let i = 0; i < templates.length; i++) {
      const cluster = templates[i];
      const url = cluster.representative;

      // Acquire a lease — reuse prefetched page if available (already navigated)
      let lease: PageLease;
      let skipNavigation = false;
      if (pendingPrefetchLease) {
        lease = pendingPrefetchLease;
        pendingPrefetchLease = null;
        skipNavigation = true;
      } else {
        lease = await probeCtx.lease();
      }

      // Hoisted for cleanup in catch block
      let activePrefetchPromise: Promise<PageLease | null> = Promise.resolve(null);

      try {
        const readOnlyResult = await runReadOnlyPhases(
          lease.page, cluster, url, auditId, config, llmClient,
          tier1Cache, evaluateCache, hfCache, axeCache, skipNavigation,
        );

        // Finalize the PREVIOUS template now that read-only phases of the current one are done.
        // The previous template's mutating phases were running concurrently with our read-only phases.
        if (pendingMutating) {
          const prev = pendingMutating;
          const mutatingResult = await prev.promise;
          await finalizeTemplate(
            prev.cluster, prev.url, prev.readOnlyResult, mutatingResult,
            auditId, prev.lease.page, tracer, globalCacheStats, prev.overlapped,
          );
          await prev.lease.release();
          pendingMutating = null;
        }

        // Decide whether to overlap: start P3+P4 in background while next template's P1+P2 runs
        const canBatch = shouldBatch() && i < templates.length - 1;

        if (canBatch) {
          // Fire P3+P4 in background; loop continues to next template
          pendingMutating = {
            promise: runMutatingPhases(
              lease.page, cluster, url, auditId, llmClient,
              readOnlyResult.promotedToTier3, readOnlyResult.manifest,
              readOnlyResult.cssFingerprint, cvdCache, viewportCache,
            ),
            lease,
            cluster,
            url,
            readOnlyResult,
            overlapped: true,
          };
          // Do NOT release lease here — runMutatingPhases is still using the page
        } else {
          // Sequential: optionally prefetch next template's navigation during P3+P4
          const hasNextTemplate = i < templates.length - 1;

          if (hasNextTemplate) {
            const nextUrl = templates[i + 1].representative;
            activePrefetchPromise = (async () => {
              try {
                const pLease = await probeCtx.lease();
                try {
                  await pLease.page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
                  await injectConsentPrehideCSS(pLease.page);
                  return pLease; // Success — return the lease
                } catch {
                  await pLease.release();
                  return null;
                }
              } catch {
                return null; // lease() itself failed
              }
            })();
          }

          // Run P3+P4 while prefetch happens concurrently
          const mutatingResult = await runMutatingPhases(
            lease.page, cluster, url, auditId, llmClient,
            readOnlyResult.promotedToTier3, readOnlyResult.manifest,
            readOnlyResult.cssFingerprint, cvdCache, viewportCache,
          );
          await finalizeTemplate(
            cluster, url, readOnlyResult, mutatingResult,
            auditId, lease.page, tracer, globalCacheStats, false,
          );
          await lease.release();

          // Await prefetch directly — P3+P4 already completed, so this just waits
          // for the (likely already finished) navigation of the next template.
          const prefetched = await activePrefetchPromise;
          if (prefetched) {
            pendingPrefetchLease = prefetched;
          }
          // If null, prefetch failed — next iteration navigates normally
        }
      } catch (err) {
        // Clean up all leases on error (including in-flight prefetch)
        if (pendingMutating) {
          await pendingMutating.promise.catch(() => {});
          await pendingMutating.lease.release();
          pendingMutating = null;
        }
        if (pendingPrefetchLease) {
          await pendingPrefetchLease.release();
          pendingPrefetchLease = null;
        }
        // Clean up in-flight prefetch that hasn't been assigned to pendingPrefetchLease yet
        activePrefetchPromise.then((p) => p?.release()).catch(() => {});
        await lease.release();
        throw err;
      }
    }

    // Release any unused prefetch lease (e.g. loop ended before reuse)
    if (pendingPrefetchLease) {
      await pendingPrefetchLease.release();
      pendingPrefetchLease = null;
    }

    // Finalize the last template if it was left pending
    if (pendingMutating) {
      const prev = pendingMutating;
      try {
        const mutatingResult = await prev.promise;
        await finalizeTemplate(
          prev.cluster, prev.url, prev.readOnlyResult, mutatingResult,
          auditId, prev.lease.page, tracer, globalCacheStats, prev.overlapped,
        );
      } finally {
        await prev.lease.release();
        pendingMutating = null;
      }
    }

    console.log(`[probe] Cache stats — hf: ${globalCacheStats.hfHits}/${globalCacheStats.hfHits + globalCacheStats.hfMisses} hits, tier1: ${globalCacheStats.tier1Hits}/${globalCacheStats.tier1Hits + globalCacheStats.tier1Misses}, eval: ${globalCacheStats.evalHits}/${globalCacheStats.evalHits + globalCacheStats.evalMisses}`);
  } finally {
    // If still pending after an uncaught throw, release
    if (pendingMutating) {
      await pendingMutating.promise.catch(() => {});
      await pendingMutating.lease.release();
    }
    if (pendingPrefetchLease) {
      await pendingPrefetchLease.release();
      pendingPrefetchLease = null;
    }
    await probeCtx.close();
  }
}

// ── Read-only phases: nav + Tier 0 + P1 + P2 (no viewport mutation, no screenshots) ──

async function runReadOnlyPhases(
  page: Page,
  cluster: TemplateCluster,
  url: string,
  auditId: string,
  config: PipelineConfig,
  llmClient: LLMClient | null,
  tier1Cache: Map<string, { issues: Issue[] }> | undefined,
  evaluateCache: Map<string, Issue[]> | undefined,
  hfCache: HoverFocusCache | undefined,
  axeCache: Map<string, Issue[]> | undefined,
  skipNavigation = false,
): Promise<ReadOnlyResult> {
  const wallClockStart = Date.now();
  const timer = new TierTimer(auditId, cluster.id, url);
  const templateCacheStats: CacheStats = { hfHits: 0, hfMisses: 0, tier1Hits: 0, tier1Misses: 0, evalHits: 0, evalMisses: 0 };
  const phaseTimings: Record<string, number> = {};

  if (skipNavigation) {
    // Page was already navigated by speculative prefetch
    phaseTimings.navigationMs = 0;
    phaseTimings.prefetchUsed = 1;
  } else {
    const gotoStart = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await injectConsentPrehideCSS(page);
    phaseTimings.navigationMs = Date.now() - gotoStart;
    phaseTimings.prefetchUsed = 0;
  }

  // ── Tier 0: Element Interaction Manifest ──
  timer.startTier("tier0");
  const manifest = await collectManifest(page);
  const styleGroups = groupByFingerprint(manifest);
  timer.endTier("tier0", {
    elementsDiscovered: manifest.length,
    styleGroups: styleGroups.length,
    representativeElements: styleGroups.length,
  });

  // Compute cssFingerprint once per template (used by P1, P3, P4)
  const cssFingerprint = await computeCssFingerprint(page);

  // Capture page title before mutations (P3 mutates viewport)
  const pageTitle = await page.title();

  // ── Phase 1: Static ──
  const p1Start = Date.now();
  // Build a minimal span-like object for runPhase1Static's parentSpan parameter
  const spanMeta: Record<string, unknown> = {};
  const fakeParentSpan = { setMeta: (m: Record<string, unknown>) => Object.assign(spanMeta, m) };
  const { issues: phase1Issues, promotedElements } = await runPhase1Static(
    page, cluster, url, timer, styleGroups, axeCache, config, llmClient, fakeParentSpan,
    cssFingerprint, tier1Cache, evaluateCache, templateCacheStats,
  );
  phaseTimings.phase1StaticMs = Date.now() - p1Start;

  // ── Phase 2: Interaction ──
  const p2Start = Date.now();
  const { issues: phase2Issues, promotedToTier3 } = await runPhase2Interaction(
    page, promotedElements, url, timer, cluster, hfCache, templateCacheStats,
  );
  phaseTimings.phase2InteractionMs = Date.now() - p2Start;

  return {
    issues: [...phase1Issues, ...phase2Issues],
    promotedToTier3,
    manifest,
    cssFingerprint,
    phaseTimings,
    timer,
    templateCacheStats,
    pageTitle,
    spanMeta,
    wallClockStart,
  };
}

// ── Mutating phases: P3 (viewport) + P4 (capture/screenshots) ──

async function runMutatingPhases(
  page: Page,
  cluster: TemplateCluster,
  url: string,
  auditId: string,
  llmClient: LLMClient | null,
  promotedToTier3: ElementManifest[],
  manifest: ElementManifest[],
  cssFingerprint: string,
  cvdCache: Map<string, { diffPercent: number; issues: Issue[] }>,
  viewportCache: Map<string, Issue[]>,
): Promise<MutatingResult> {
  const phaseTimings: Record<string, number> = {};

  // ── Phase 3: Viewport ──
  const p3Start = Date.now();
  const phase3Issues = await runPhase3Viewport(page, url, cluster, viewportCache, cssFingerprint);
  phaseTimings.phase3ViewportMs = Date.now() - p3Start;

  // ── Phase 4: Capture ──
  const p4Start = Date.now();
  const phase4Issues = await runPhase4Capture(
    page, url, cluster, auditId, llmClient, promotedToTier3, cvdCache,
    cssFingerprint, manifest,
  );
  phaseTimings.phase4CaptureMs = Date.now() - p4Start;

  return {
    issues: [...phase3Issues, ...phase4Issues],
    phaseTimings,
  };
}

// ── Finalize: combine issues, amplify, insert to DB, flush tracer ──

async function finalizeTemplate(
  cluster: TemplateCluster,
  url: string,
  readOnlyResult: ReadOnlyResult,
  mutatingResult: MutatingResult,
  auditId: string,
  page: Page,
  tracer: AuditTracer,
  globalCacheStats: CacheStats,
  overlapped: boolean,
): Promise<void> {
  const allIssues = [...readOnlyResult.issues, ...mutatingResult.issues];

  // Merge phase timings
  const phaseTimings: Record<string, number> = {
    ...readOnlyResult.phaseTimings,
    ...mutatingResult.phaseTimings,
  };
  phaseTimings.totalTemplateMs = Date.now() - readOnlyResult.wallClockStart;
  phaseTimings.overlapped = overlapped ? 1 : 0;

  const cs = readOnlyResult.templateCacheStats;
  phaseTimings.cacheHfHits = cs.hfHits;
  phaseTimings.cacheHfMisses = cs.hfMisses;
  phaseTimings.cacheTier1Hits = cs.tier1Hits;
  phaseTimings.cacheTier1Misses = cs.tier1Misses;
  phaseTimings.cacheEvalHits = cs.evalHits;
  phaseTimings.cacheEvalMisses = cs.evalMisses;

  globalCacheStats.hfHits += cs.hfHits;
  globalCacheStats.hfMisses += cs.hfMisses;
  globalCacheStats.tier1Hits += cs.tier1Hits;
  globalCacheStats.tier1Misses += cs.tier1Misses;
  globalCacheStats.evalHits += cs.evalHits;
  globalCacheStats.evalMisses += cs.evalMisses;

  // ── Template amplification ──
  const templateIssues = allIssues.filter((i) => TEMPLATE_LEVEL_RULES.has(i.rule));

  // Representative page: ALL issues
  const repPageId = await insertPageV4(auditId, {
    url,
    title: readOnlyResult.pageTitle,
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

  // Record span with all metadata and flush
  const span = tracer.startSpan("probe:representative", null, new Date(readOnlyResult.wallClockStart));
  span.setMeta({
    ...readOnlyResult.spanMeta,
    url,
    templateId: cluster.id,
    testPlan: cluster.testPlan,
    phaseTimings,
    totalIssues: allIssues.length,
    templateIssues: templateIssues.length,
    amplifiedToPages: cluster.urls.length - 1,
    tierTiming: readOnlyResult.timer.getTiming(),
    actualStartMs: readOnlyResult.wallClockStart,
  });
  span.end("ok");
  await tracer.flush();
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
  tier1Cache: Map<string, { issues: Issue[] }> | undefined,
  evaluateCache: Map<string, Issue[]> | undefined,
  cacheStats: { hfHits: number; hfMisses: number; tier1Hits: number; tier1Misses: number; evalHits: number; evalMisses: number },
): Promise<{ issues: Issue[]; promotedElements: ElementManifest[] }> {
  const issues: Issue[] = [];

  // Tier 1: CSSOM hover contrast (cache by cssFingerprint — same CSS = same CSSOM results)
  // Cache only issues, NOT promotedElements — cached selectors from template A
  // would not reference correct DOM elements on template B's page.
  // On cache hit, promote all elements from current manifest (conservative: more
  // elements go to Tier 2, but no false negatives from stale selectors).
  let promotedElements: ElementManifest[];
  if (tier1Cache?.has(cssFingerprint)) {
    cacheStats.tier1Hits++;
    const cached = tier1Cache.get(cssFingerprint)!;
    issues.push(...cached.issues.map(i => ({ ...i, url, id: crypto.randomUUID() })));
    // Promote all elements from current template's manifest (conservative)
    promotedElements = styleGroups.flatMap(g => g.members);
  } else {
    cacheStats.tier1Misses++;
    const { issues: tier1Issues, promotedElements: promoted } = await runTier1(page, styleGroups, url, timer);
    issues.push(...tier1Issues);
    promotedElements = promoted;
    tier1Cache?.set(cssFingerprint, { issues: tier1Issues });
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

  // page.evaluate()-only tests (parallel, read-only) — cache by domHash + testPlan
  const domStructure = await collectDomStructure(page);
  const evalTestNames = (["target-size","multimedia","timed-events","non-text-contrast","meaningful-sequence","semantic-structure","legal-a11y"] as const)
    .filter(t => cluster.testPlan.includes(t as any)).join(",");
  const evalCacheKey = computeDomHash(domStructure) + ":" + evalTestNames;

  if (evaluateCache?.has(evalCacheKey)) {
    cacheStats.evalHits++;
    issues.push(...evaluateCache.get(evalCacheKey)!.map(i => ({ ...i, url, id: crypto.randomUUID() })));
  } else {
    cacheStats.evalMisses++;
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
    evaluateCache?.set(evalCacheKey, evalIssues);
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
  hfCache: HoverFocusCache | undefined,
  cacheStats: { hfHits: number; hfMisses: number; tier1Hits: number; tier1Misses: number; evalHits: number; evalMisses: number },
): Promise<{ issues: Issue[]; promotedToTier3: ElementManifest[] }> {
  const issues: Issue[] = [];

  // Tier 2: unified interaction pass
  const { issues: tier2Issues, promotedToTier3, hfHits, hfMisses } = await runTier2(page, promotedElements, url, timer, hfCache);
  cacheStats.hfHits += hfHits;
  cacheStats.hfMisses += hfMisses;
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
