/**
 * Spike Part 2b: axe-core injected INTO jsdom context (correct approach)
 */

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Load axe-core source to inject into jsdom
const axeSource = readFileSync(
  join(import.meta.dir, "../node_modules/axe-core/axe.min.js"),
  "utf-8"
);

async function runAxeInJsdom(html: string, url: string): Promise<{
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
      runScripts: "dangerously",  // Required to run axe-core inside jsdom
      resources: "usable",
    });

    const { window } = dom;

    // Inject axe-core into jsdom's own window context
    window.eval(axeSource);

    // Now run axe from inside jsdom's context
    const results: any = await new Promise((resolve, reject) => {
      const axeInWindow = (window as any).axe;
      if (!axeInWindow) {
        reject(new Error("axe-core not found in jsdom window after injection"));
        return;
      }

      axeInWindow.run(
        window.document.documentElement,
        {
          rules: {
            "color-contrast": { enabled: false },
            "color-contrast-enhanced": { enabled: false },
          },
        },
        (err: any, results: any) => {
          if (err) reject(err);
          else resolve(results);
        }
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
      totalRules: 0,
      violations: 0,
      violationRules: [],
      passes: 0,
      incomplete: 0,
      inapplicable: 0,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      timeMs: Math.round(performance.now() - start),
      memoryMB: 0,
    };
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  SPIKE: axe-core INJECTED into jsdom (correct approach)");
  console.log("═══════════════════════════════════════════════════════════\n");

  const testSites = [
    { url: "https://example.com", label: "Static minimal" },
    { url: "https://www.gov.uk", label: "Gov SSR complex" },
    { url: "https://news.ycombinator.com", label: "HN simple SSR" },
    { url: "https://www.wikipedia.org", label: "Wikipedia SSR" },
    { url: "https://github.com", label: "GitHub SSR+hydration" },
    { url: "https://www.finnk.com", label: "Finnk (Angular CSR)" },
    { url: "https://react.dev", label: "React.dev (Next.js SSR)" },
  ];

  let totalSuccess = 0;
  let totalFail = 0;
  const allResults: Array<{ url: string; rules: number; violations: number; timeMs: number; memMB: number }> = [];

  for (const site of testSites) {
    console.log(`Testing: ${site.url} (${site.label})`);

    try {
      const html = await fetch(site.url, {
        headers: { "User-Agent": CHROME_UA, "Accept-Language": "en-US,en;q=0.9" },
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      }).then(r => r.text());

      console.log(`   HTML: ${html.length} bytes, ${(html.match(/<[a-z]/gi) || []).length} tags`);

      const result = await runAxeInJsdom(html, site.url);

      if (result.success) {
        totalSuccess++;
        allResults.push({ url: site.url, rules: result.totalRules, violations: result.violations, timeMs: result.timeMs, memMB: result.memoryMB });
        console.log(`   ✅ ${result.totalRules} rules | ${result.violations} violations | ${result.passes} passes | ${result.incomplete} incomplete | ${result.inapplicable} N/A`);
        if (result.violationRules.length > 0) {
          console.log(`   Violations: ${result.violationRules.join(", ")}`);
        }
        console.log(`   ⏱ ${result.timeMs}ms | 💾 ${result.memoryMB}MB`);
      } else {
        totalFail++;
        console.log(`   ❌ ${result.error}`);
      }
    } catch (err) {
      totalFail++;
      console.log(`   💀 Fetch failed: ${err instanceof Error ? err.message : err}`);
    }
    console.log();
  }

  // ─── Summary ───
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  RESULTS: ${totalSuccess}/${testSites.length} sites passed`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (allResults.length > 0) {
    console.log("Performance summary:");
    console.log("┌────────────────────────────────┬───────┬────────────┬─────────┬────────┐");
    console.log("│ Site                           │ Rules │ Violations │ Time ms │ Mem MB │");
    console.log("├────────────────────────────────┼───────┼────────────┼─────────┼────────┤");
    for (const r of allResults) {
      const site = r.url.replace("https://", "").padEnd(30);
      console.log(`│ ${site} │ ${String(r.rules).padStart(5)} │ ${String(r.violations).padStart(10)} │ ${String(r.timeMs).padStart(7)} │ ${String(r.memMB).padStart(6)} │`);
    }
    console.log("└────────────────────────────────┴───────┴────────────┴─────────┴────────┘");

    const avgTime = Math.round(allResults.reduce((s, r) => s + r.timeMs, 0) / allResults.length);
    const avgMem = Math.round(allResults.reduce((s, r) => s + r.memMB, 0) / allResults.length * 10) / 10;
    const avgRules = Math.round(allResults.reduce((s, r) => s + r.rules, 0) / allResults.length);
    console.log(`\nAverages: ${avgRules} rules | ${avgTime}ms | ${avgMem}MB per site`);
    console.log(`\nFor comparison: Playwright + axe runs ~104 rules at ~10,000ms and ~250MB`);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  SPIKE COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch(console.error);
