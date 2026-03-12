/**
 * Spike Part 2: axe-core on jsdom + linkedom alternative approaches
 */

import { JSDOM } from "jsdom";
import { parseHTML } from "linkedom";
import axe from "axe-core";

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── Test 1: axe-core on JSDOM ───
async function testAxeOnJsdom(html: string, url: string): Promise<{
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
    const dom = new JSDOM(html, {
      url,
      pretendToBeVisual: true,
      runScripts: "outside-only",
    });

    const { window } = dom;
    const { document } = window;

    // jsdom provides a more complete window — let's inject it
    const g = globalThis as any;
    const origW = g.window;
    const origD = g.document;
    const origN = g.navigator;
    g.window = window;
    g.document = document;
    g.navigator = window.navigator;

    try {
      axe.reset();

      // Disable color-contrast (known to fail on jsdom)
      const results = await axe.run(document.documentElement as any, {
        rules: {
          "color-contrast": { enabled: false },
          "color-contrast-enhanced": { enabled: false },
        },
      });

      const timeMs = Math.round(performance.now() - start);
      const memoryMB = Math.round((process.memoryUsage().heapUsed - memBefore) / 1024 / 1024 * 10) / 10;

      return {
        success: true,
        totalRules: results.passes.length + results.violations.length + results.incomplete.length + results.inapplicable.length,
        violations: results.violations.length,
        violationRules: results.violations.map(v => `${v.id}(${v.nodes.length})`),
        passes: results.passes.length,
        incomplete: results.incomplete.length,
        inapplicable: results.inapplicable.length,
        timeMs,
        memoryMB,
      };
    } finally {
      g.window = origW;
      g.document = origD;
      g.navigator = origN;
      dom.window.close();
    }
  } catch (err) {
    return {
      success: false,
      totalRules: 0,
      violations: 0,
      violationRules: [],
      passes: 0,
      incomplete: 0,
      inapplicable: 0,
      error: (err instanceof Error ? err.stack || err.message : String(err)).slice(0, 500),
      timeMs: Math.round(performance.now() - start),
      memoryMB: 0,
    };
  }
}

// ─── Test 2: axe-core source injected into linkedom (alternative approach) ───
async function testAxeInjectedInLinkedom(html: string, url: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const { document, window } = parseHTML(html);

    // Try using axe.run with the document element directly
    // but first set up the global context axe expects
    const g = globalThis as any;

    // Create a minimal window-like object from linkedom's window
    const fakeWindow = {
      ...window,
      getComputedStyle: () => ({}),
      innerWidth: 1280,
      innerHeight: 720,
      Node: (window as any).Node || { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    };

    g.window = fakeWindow;
    g.document = document;
    g.Node = fakeWindow.Node;

    try {
      axe.reset();
      const results = await axe.run(document.documentElement as any, {
        rules: { "color-contrast": { enabled: false } },
      });

      return { success: true };
    } finally {
      delete g.window;
      delete g.document;
      delete g.Node;
    }
  } catch (err) {
    return {
      success: false,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

// ─── Test 3: Memory comparison — jsdom vs linkedom for DOM parsing only ───
async function measureMemory(html: string): Promise<{
  jsdom: { memoryMB: number; parseMs: number; elementCount: number };
  linkedom: { memoryMB: number; parseMs: number; elementCount: number };
}> {
  // linkedom
  global.gc?.();
  const lMemBefore = process.memoryUsage().heapUsed;
  const lStart = performance.now();
  const { document: lDoc } = parseHTML(html);
  const lTime = Math.round(performance.now() - lStart);
  const lElements = lDoc.querySelectorAll("*").length;
  const lMem = Math.round((process.memoryUsage().heapUsed - lMemBefore) / 1024 / 1024 * 10) / 10;

  // jsdom
  global.gc?.();
  const jMemBefore = process.memoryUsage().heapUsed;
  const jStart = performance.now();
  const jDom = new JSDOM(html, { url: "https://example.com" });
  const jTime = Math.round(performance.now() - jStart);
  const jElements = jDom.window.document.querySelectorAll("*").length;
  const jMem = Math.round((process.memoryUsage().heapUsed - jMemBefore) / 1024 / 1024 * 10) / 10;
  jDom.window.close();

  return {
    linkedom: { memoryMB: lMem, parseMs: lTime, elementCount: lElements },
    jsdom: { memoryMB: jMem, parseMs: jTime, elementCount: jElements },
  };
}

// ─── Main ───
async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  SPIKE Part 2: jsdom + alternative approaches");
  console.log("═══════════════════════════════════════════════════════════\n");

  const testSites = [
    "https://example.com",
    "https://www.gov.uk",
    "https://news.ycombinator.com",
    "https://www.wikipedia.org",
    "https://github.com",
  ];

  // ─── Part 1: axe-core on JSDOM ───
  console.log("── TEST 1: axe-core on JSDOM ──\n");

  for (const url of testSites) {
    const html = await fetch(url, {
      headers: { "User-Agent": CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    }).then(r => r.text());

    const result = await testAxeOnJsdom(html, url);
    if (result.success) {
      console.log(`✅ ${url}`);
      console.log(`   Rules: ${result.totalRules} total | Violations: ${result.violations} | Passes: ${result.passes} | Incomplete: ${result.incomplete} | N/A: ${result.inapplicable}`);
      if (result.violationRules.length > 0) {
        console.log(`   Violation rules: ${result.violationRules.join(", ")}`);
      }
      console.log(`   Time: ${result.timeMs}ms | Memory: ${result.memoryMB}MB`);
    } else {
      console.log(`❌ ${url}`);
      console.log(`   Error: ${result.error}`);
    }
    console.log();
  }

  // ─── Part 2: linkedom alternative approach ───
  console.log("── TEST 2: axe-core injected into linkedom (fake window) ──\n");

  const simpleHtml = await fetch("https://example.com").then(r => r.text());
  const linkedomResult = await testAxeInjectedInLinkedom(simpleHtml, "https://example.com");
  console.log(linkedomResult.success
    ? "✅ axe-core works on linkedom with fake window!"
    : `❌ Still fails: ${linkedomResult.error}`);
  console.log();

  // ─── Part 3: Memory comparison ───
  console.log("── TEST 3: Memory — jsdom vs linkedom (parse only) ──\n");

  const bigHtml = await fetch("https://www.wikipedia.org", {
    headers: { "User-Agent": CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.text());

  const mem = await measureMemory(bigHtml);
  console.log("Wikipedia.org parsing:");
  console.log(`   linkedom: ${mem.linkedom.parseMs}ms, ${mem.linkedom.memoryMB}MB, ${mem.linkedom.elementCount} elements`);
  console.log(`   jsdom:    ${mem.jsdom.parseMs}ms, ${mem.jsdom.memoryMB}MB, ${mem.jsdom.elementCount} elements`);
  console.log(`   Ratio:    jsdom is ${Math.round(mem.jsdom.parseMs / Math.max(1, mem.linkedom.parseMs))}x slower, ${Math.round(Math.max(0.1, mem.jsdom.memoryMB) / Math.max(0.1, mem.linkedom.memoryMB))}x more memory`);
  console.log();

  // ─── Part 4: jsdom rule count vs known axe total ───
  console.log("── TEST 4: Rule coverage analysis ──\n");

  const govHtml = await fetch("https://www.gov.uk", {
    headers: { "User-Agent": CHROME_UA },
    signal: AbortSignal.timeout(10_000),
  }).then(r => r.text());

  // Run with ALL rules enabled (including color-contrast) to see what fails
  console.log("Running axe-core on gov.uk with ALL rules (including color-contrast)...");
  const allRules = await testAxeOnJsdom(govHtml, "https://www.gov.uk");
  if (allRules.success) {
    console.log(`✅ Even with all rules: ${allRules.totalRules} rules ran`);
    console.log(`   Violations: ${allRules.violations} | Passes: ${allRules.passes} | Incomplete: ${allRules.incomplete}`);
  } else {
    console.log(`❌ Failed with all rules: ${allRules.error}`);
  }

  // Count total axe rules
  const ruleList = axe.getRules();
  console.log(`\nTotal axe-core rules available: ${ruleList.length}`);
  const wcagAA = ruleList.filter(r => r.tags.some(t => t.includes("wcag2") || t.includes("wcag21") || t.includes("wcag22")));
  console.log(`WCAG-related rules: ${wcagAA.length}`);
  console.log(`Best-practice rules: ${ruleList.filter(r => r.tags.includes("best-practice")).length}`);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  SPIKE Part 2 COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch(console.error);
