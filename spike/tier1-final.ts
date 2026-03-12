/**
 * Spike FINAL: The correct approach — strip scripts, inject axe into clean jsdom
 */

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const axeSource = readFileSync(
  join(import.meta.dir, "../node_modules/axe-core/axe.min.js"),
  "utf-8"
);

/** Strip <script> tags from HTML — we only need the DOM, not the site's JS */
function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

async function runAxeJsdomClean(html: string, url: string): Promise<{
  success: boolean;
  totalRules: number;
  violations: number;
  violationRules: string[];
  passes: number;
  incomplete: number;
  inapplicable: number;
  error?: string;
  timeMs: number;
  memoryMB: number;
}> {
  const memBefore = process.memoryUsage().heapUsed;
  const start = performance.now();

  try {
    // Strip site scripts — we only need DOM structure for axe
    const cleanHtml = stripScripts(html);

    const dom = new JSDOM(cleanHtml, {
      url,
      pretendToBeVisual: true,
      runScripts: "dangerously",  // Only for axe injection — no site scripts
    });

    // Inject axe-core
    dom.window.eval(axeSource);

    const results: any = await new Promise((resolve, reject) => {
      const axeInWindow = (dom.window as any).axe;
      if (!axeInWindow) return reject(new Error("axe not found after injection"));

      axeInWindow.run(
        dom.window.document.documentElement,
        {
          rules: {
            "color-contrast": { enabled: false },
            "color-contrast-enhanced": { enabled: false },
          },
        },
        (err: any, res: any) => err ? reject(err) : resolve(res),
      );
    });

    const timeMs = Math.round(performance.now() - start);
    const memoryMB = Math.round((process.memoryUsage().heapUsed - memBefore) / 1024 / 1024 * 10) / 10;
    dom.window.close();

    return {
      success: true,
      totalRules: results.passes.length + results.violations.length + results.incomplete.length + results.inapplicable.length,
      violations: results.violations.length,
      violationRules: results.violations.map((v: any) => `${v.id}(${v.nodes.length})`),
      passes: results.passes.length,
      incomplete: results.incomplete.length,
      inapplicable: results.inapplicable.length,
      timeMs,
      memoryMB,
    };
  } catch (err) {
    return {
      success: false,
      totalRules: 0, violations: 0, violationRules: [], passes: 0, incomplete: 0, inapplicable: 0,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      timeMs: Math.round(performance.now() - start),
      memoryMB: 0,
    };
  }
}

/** Static analysis using linkedom (no axe, just DOM checks) */
function runStaticAnalysis(html: string, url: string): {
  hasMedia: boolean;
  mediaWithoutCaptions: number;
  hasAutoplay: boolean;
  hasMetaRefresh: boolean;
  hasCarousel: boolean;
  hasForms: boolean;
  formsMissingAutocomplete: number;
  hasOrientationLock: boolean;
  linkCount: number;
  elementCount: number;
  timeMs: number;
} {
  const start = performance.now();
  const { document } = parseHTML(html);

  // Multimedia (WCAG 1.2.x)
  const videos = document.querySelectorAll("video");
  const audios = document.querySelectorAll("audio");
  const iframes = document.querySelectorAll('iframe[src*="youtube"], iframe[src*="vimeo"]');
  const mediaWithoutCaptions = [...videos].filter(
    v => !v.querySelector('track[kind="captions"], track[kind="subtitles"]')
  ).length + iframes.length; // iframes can't be checked for captions

  // Timed events (WCAG 2.2.x)
  const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
  const autoplay = document.querySelectorAll("video[autoplay], audio[autoplay]");
  const carousels = document.querySelectorAll(
    '[class*="carousel" i], [class*="slider" i], [class*="swiper" i], [role="timer"]'
  );

  // Input purpose (WCAG 1.3.5)
  const PURPOSE_PATTERNS = /^(name|email|tel|phone|address|city|zip|postal|country|cc-|username|password|bday|sex|url)/i;
  const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
  let formsMissingAutocomplete = 0;
  for (const input of inputs) {
    const nameOrId = input.getAttribute("name") || input.getAttribute("id") || "";
    if (PURPOSE_PATTERNS.test(nameOrId) && !input.getAttribute("autocomplete")) {
      formsMissingAutocomplete++;
    }
  }

  // Orientation (WCAG 1.3.4)
  const viewport = document.querySelector('meta[name="viewport"]');
  const hasOrientationLock = viewport?.getAttribute("content")?.includes("orientation") || false;

  return {
    hasMedia: videos.length + audios.length + iframes.length > 0,
    mediaWithoutCaptions,
    hasAutoplay: autoplay.length > 0,
    hasMetaRefresh: !!metaRefresh,
    hasCarousel: carousels.length > 0,
    hasForms: document.querySelectorAll("form").length > 0,
    formsMissingAutocomplete,
    hasOrientationLock,
    linkCount: document.querySelectorAll("a[href]").length,
    elementCount: document.querySelectorAll("*").length,
    timeMs: Math.round(performance.now() - start),
  };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  SPIKE FINAL: jsdom (scripts stripped) + linkedom static analysis");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const sites = [
    { url: "https://example.com", label: "Static minimal" },
    { url: "https://www.gov.uk", label: "Gov SSR" },
    { url: "https://news.ycombinator.com", label: "HN SSR" },
    { url: "https://www.wikipedia.org", label: "Wikipedia" },
    { url: "https://github.com", label: "GitHub" },
    { url: "https://www.finnk.com", label: "Finnk (Angular)" },
    { url: "https://react.dev", label: "React.dev (Next)" },
  ];

  console.log("── Part A: axe-core on jsdom (scripts stripped) ──\n");

  const axeResults: Array<{ url: string; label: string; rules: number; violations: number; vRules: string[]; timeMs: number; memMB: number; success: boolean }> = [];

  for (const site of sites) {
    const html = await fetch(site.url, {
      headers: { "User-Agent": CHROME_UA },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    }).then(r => r.text()).catch(() => "");

    if (!html) {
      console.log(`💀 ${site.url} — fetch failed\n`);
      continue;
    }

    const result = await runAxeJsdomClean(html, site.url);
    axeResults.push({
      url: site.url, label: site.label,
      rules: result.totalRules, violations: result.violations,
      vRules: result.violationRules,
      timeMs: result.timeMs, memMB: result.memoryMB,
      success: result.success,
    });

    const icon = result.success ? "✅" : "❌";
    console.log(`${icon} ${site.label.padEnd(20)} | ${result.success ? `${result.totalRules} rules, ${result.violations} violations` : result.error}`);
    if (result.success) {
      console.log(`   ${result.timeMs}ms | ${result.memoryMB}MB | violations: ${result.violationRules.join(", ") || "none"}`);
    }
    console.log();
  }

  const successes = axeResults.filter(r => r.success);
  console.log(`\naxe-core success rate: ${successes.length}/${axeResults.length}`);
  if (successes.length > 0) {
    const avgTime = Math.round(successes.reduce((s, r) => s + r.timeMs, 0) / successes.length);
    const avgMem = Math.round(successes.reduce((s, r) => s + r.memMB, 0) / successes.length * 10) / 10;
    const avgRules = Math.round(successes.reduce((s, r) => s + r.rules, 0) / successes.length);
    console.log(`Averages: ${avgRules} rules | ${avgTime}ms | ${avgMem}MB`);
    console.log(`Comparison: Playwright+axe = ~104 rules | ~10,000ms | ~250MB shared browser`);
  }

  // ─── Part B: Static analysis with linkedom ───
  console.log("\n── Part B: Static analysis (linkedom, no axe) ──\n");

  for (const site of sites) {
    const html = await fetch(site.url, {
      headers: { "User-Agent": CHROME_UA },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    }).then(r => r.text()).catch(() => "");

    if (!html) continue;

    const analysis = runStaticAnalysis(html, site.url);
    const flags: string[] = [];
    if (analysis.hasMedia) flags.push(`media(${analysis.mediaWithoutCaptions} no captions)`);
    if (analysis.hasAutoplay) flags.push("autoplay");
    if (analysis.hasMetaRefresh) flags.push("meta-refresh");
    if (analysis.hasCarousel) flags.push("carousel");
    if (analysis.hasForms) flags.push("forms");
    if (analysis.formsMissingAutocomplete > 0) flags.push(`autocomplete-missing(${analysis.formsMissingAutocomplete})`);
    if (analysis.hasOrientationLock) flags.push("orientation-lock");

    console.log(`${site.label.padEnd(20)} | ${analysis.elementCount} els | ${analysis.linkCount} links | ${analysis.timeMs}ms`);
    console.log(`   Capabilities: ${flags.length > 0 ? flags.join(", ") : "none detected"}`);
    console.log();
  }

  // ─── Part C: Finnk.com — can we get anything useful? ───
  console.log("── Part C: Angular CSR site (finnk.com) — what does fetch() return? ──\n");

  const finnkHtml = await fetch("https://www.finnk.com", {
    headers: { "User-Agent": CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.text());

  console.log(`HTML size: ${finnkHtml.length} bytes`);
  console.log(`First 500 chars:\n${finnkHtml.slice(0, 500)}\n`);

  const { document: finnkDoc } = parseHTML(finnkHtml);
  console.log(`Elements: ${finnkDoc.querySelectorAll("*").length}`);
  console.log(`Text content: "${(finnkDoc.body?.textContent?.trim() || "").slice(0, 200)}"`);
  console.log(`Links: ${finnkDoc.querySelectorAll("a[href]").length}`);
  console.log(`Has <app-root>: ${!!finnkDoc.querySelector("app-root")}`);
  console.log(`Has <noscript>: ${!!finnkDoc.querySelector("noscript")}`);
  const noscript = finnkDoc.querySelector("noscript");
  if (noscript) console.log(`Noscript content: "${noscript.textContent?.trim().slice(0, 100)}"`);

  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("  SPIKE COMPLETE — Data for design decisions");
  console.log("═══════════════════════════════════════════════════════════════════");
}

main().catch(console.error);
