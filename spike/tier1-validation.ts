/**
 * Spike: Validate Tier 1 feasibility
 *
 * Tests:
 * 1. Can axe-core run on linkedom? How many rules work?
 * 2. Can axe-core run on jsdom? How many rules work?
 * 3. Does fetch() get useful content from real sites? (JS-rendered vs server-rendered)
 * 4. Compare axe results: linkedom vs jsdom vs real browser (via Playwright)
 */

import { parseHTML } from "linkedom";
import axe from "axe-core";

// ─── Test Sites: mix of SSR, SPA, static ───
const TEST_SITES = [
  { url: "https://www.finnk.com", type: "expected-ssr", description: "Our existing test site" },
  { url: "https://example.com", type: "static", description: "Minimal static HTML" },
  { url: "https://www.wikipedia.org", type: "ssr", description: "Server-rendered, complex" },
  { url: "https://www.gov.uk", type: "ssr", description: "Gov site, well-structured" },
  { url: "https://react.dev", type: "spa", description: "React SPA" },
  { url: "https://angular.dev", type: "spa", description: "Angular SPA" },
  { url: "https://news.ycombinator.com", type: "ssr", description: "Server-rendered, simple" },
  { url: "https://github.com", type: "ssr-hydrated", description: "SSR with JS hydration" },
];

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── Spike 1: axe-core on linkedom ───
async function testAxeOnLinkedom(html: string, url: string): Promise<{
  success: boolean;
  rulesRan: number;
  rulesFailed: number;
  violations: number;
  passes: number;
  incomplete: number;
  errors: string[];
  failedRules: string[];
}> {
  const errors: string[] = [];
  const failedRules: string[] = [];

  try {
    const { document, window } = parseHTML(html);

    // axe-core needs window context — let's see what linkedom provides
    const globalWithWindow = globalThis as any;
    const originalWindow = globalWithWindow.window;
    const originalDocument = globalWithWindow.document;

    // Inject linkedom's window/document into globals (axe-core expects these)
    globalWithWindow.window = window;
    globalWithWindow.document = document;

    try {
      // Reset axe for clean run
      axe.reset();

      const results = await axe.run(document as any, {
        // Don't disable any rules — we want to see which ones crash
        reporter: "v2",
      });

      return {
        success: true,
        rulesRan: results.passes.length + results.violations.length + results.incomplete.length + results.inapplicable.length,
        rulesFailed: 0,
        violations: results.violations.length,
        passes: results.passes.length,
        incomplete: results.incomplete.length,
        errors,
        failedRules,
      };
    } finally {
      // Restore globals
      globalWithWindow.window = originalWindow;
      globalWithWindow.document = originalDocument;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg.slice(0, 200));
    return {
      success: false,
      rulesRan: 0,
      rulesFailed: 0,
      violations: 0,
      passes: 0,
      incomplete: 0,
      errors,
      failedRules,
    };
  }
}

// ─── Spike 2: axe-core on linkedom with problematic rules disabled ───
async function testAxeOnLinkedomSafe(html: string, url: string): Promise<{
  success: boolean;
  rulesRan: number;
  violations: number;
  passes: number;
  incomplete: number;
  disabledRules: string[];
  error?: string;
}> {
  // Rules known to need browser APIs
  const RULES_NEEDING_BROWSER = [
    "color-contrast",
    "color-contrast-enhanced",
    "link-in-text-block",
    "meta-viewport-large",
    "meta-viewport",
    "scrollable-region-focusable",
    "target-size",
    "focus-order-semantics",
  ];

  try {
    const { document, window } = parseHTML(html);
    const globalWithWindow = globalThis as any;
    const origW = globalWithWindow.window;
    const origD = globalWithWindow.document;
    globalWithWindow.window = window;
    globalWithWindow.document = document;

    try {
      axe.reset();
      const rulesConfig: Record<string, { enabled: boolean }> = {};
      for (const rule of RULES_NEEDING_BROWSER) {
        rulesConfig[rule] = { enabled: false };
      }

      const results = await axe.run(document as any, {
        rules: rulesConfig,
        reporter: "v2",
      });

      return {
        success: true,
        rulesRan: results.passes.length + results.violations.length + results.incomplete.length + results.inapplicable.length,
        violations: results.violations.length,
        passes: results.passes.length,
        incomplete: results.incomplete.length,
        disabledRules: RULES_NEEDING_BROWSER,
      };
    } finally {
      globalWithWindow.window = origW;
      globalWithWindow.document = origD;
    }
  } catch (err) {
    return {
      success: false,
      rulesRan: 0,
      violations: 0,
      passes: 0,
      incomplete: 0,
      disabledRules: RULES_NEEDING_BROWSER,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

// ─── Spike 3: fetch() content analysis ───
async function analyzeFetchContent(url: string): Promise<{
  url: string;
  statusCode: number;
  htmlSize: number;
  hasBody: boolean;
  elementCount: number;
  textLength: number;
  hasMainContent: boolean;
  hasNav: boolean;
  hasForms: boolean;
  hasMedia: boolean;
  linkCount: number;
  jsRenderedIndicators: string[];
  verdict: "server-rendered" | "js-rendered" | "partial" | "error";
  fetchTimeMs: number;
}> {
  const start = performance.now();
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": CHROME_UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });

    const html = await response.text();
    const fetchTimeMs = Math.round(performance.now() - start);
    const { document } = parseHTML(html);

    const body = document.querySelector("body");
    const textContent = body?.textContent?.trim() || "";
    const elementCount = document.querySelectorAll("*").length;
    const linkCount = document.querySelectorAll("a[href]").length;
    const hasMainContent = !!(
      document.querySelector("main") ||
      document.querySelector("[role='main']") ||
      document.querySelector("article")
    );
    const hasNav = !!(
      document.querySelector("nav") ||
      document.querySelector("[role='navigation']")
    );
    const hasForms = document.querySelectorAll("form").length > 0;
    const hasMedia = document.querySelectorAll("video, audio, iframe").length > 0;

    // Detect JS-rendering indicators
    const jsIndicators: string[] = [];
    if (document.querySelector("#__next")) jsIndicators.push("Next.js");
    if (document.querySelector("#__nuxt")) jsIndicators.push("Nuxt");
    if (document.querySelector("#root") && elementCount < 50) jsIndicators.push("React SPA (empty root)");
    if (document.querySelector("#app") && elementCount < 50) jsIndicators.push("Vue SPA (empty app)");
    if (document.querySelector("script[src*='chunk']")) jsIndicators.push("Bundled JS chunks");
    if (html.includes("__NEXT_DATA__")) jsIndicators.push("Next.js SSR data");
    if (html.includes("__NUXT__")) jsIndicators.push("Nuxt SSR data");
    const noscript = document.querySelector("noscript");
    if (noscript?.textContent?.includes("enable JavaScript")) jsIndicators.push("JS-required noscript warning");

    // Verdict
    let verdict: "server-rendered" | "js-rendered" | "partial" | "error";
    if (textContent.length < 100 && elementCount < 30) {
      verdict = "js-rendered";
    } else if (textContent.length < 500 && !hasMainContent) {
      verdict = "partial";
    } else {
      verdict = "server-rendered";
    }

    return {
      url,
      statusCode: response.status,
      htmlSize: html.length,
      hasBody: !!body,
      elementCount,
      textLength: textContent.length,
      hasMainContent,
      hasNav,
      hasForms,
      hasMedia,
      linkCount,
      jsRenderedIndicators: jsIndicators,
      verdict,
      fetchTimeMs,
    };
  } catch (err) {
    return {
      url,
      statusCode: 0,
      htmlSize: 0,
      hasBody: false,
      elementCount: 0,
      textLength: 0,
      hasMainContent: false,
      hasNav: false,
      hasForms: false,
      hasMedia: false,
      linkCount: 0,
      jsRenderedIndicators: [],
      verdict: "error",
      fetchTimeMs: Math.round(performance.now() - start),
    };
  }
}

// ─── Main ───
async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  SPIKE: Tier 1 Feasibility Validation");
  console.log("═══════════════════════════════════════════════════════════\n");

  // ─── Part 1: fetch() content analysis ───
  console.log("── PART 1: Does fetch() get useful content? ──\n");

  const fetchResults = [];
  for (const site of TEST_SITES) {
    const result = await analyzeFetchContent(site.url);
    fetchResults.push({ ...result, expectedType: site.type, description: site.description });

    console.log(`${result.verdict === "server-rendered" ? "✅" : result.verdict === "partial" ? "⚠️" : result.verdict === "js-rendered" ? "❌" : "💀"} ${site.url}`);
    console.log(`   Type: ${site.type} | Verdict: ${result.verdict} | ${result.fetchTimeMs}ms`);
    console.log(`   Elements: ${result.elementCount} | Text: ${result.textLength} chars | Links: ${result.linkCount}`);
    console.log(`   Main: ${result.hasMainContent} | Nav: ${result.hasNav} | Forms: ${result.hasForms} | Media: ${result.hasMedia}`);
    if (result.jsRenderedIndicators.length > 0) {
      console.log(`   JS indicators: ${result.jsRenderedIndicators.join(", ")}`);
    }
    console.log();
  }

  const ssrCount = fetchResults.filter(r => r.verdict === "server-rendered").length;
  const jsCount = fetchResults.filter(r => r.verdict === "js-rendered").length;
  const partialCount = fetchResults.filter(r => r.verdict === "partial").length;
  const errorCount = fetchResults.filter(r => r.verdict === "error").length;

  console.log(`Summary: ${ssrCount} SSR, ${partialCount} partial, ${jsCount} JS-rendered, ${errorCount} errors out of ${TEST_SITES.length} sites\n`);

  // ─── Part 2: axe-core on linkedom (all rules) ───
  console.log("── PART 2: axe-core on linkedom (all rules enabled) ──\n");

  // Use a simple test with example.com (always SSR, simple HTML)
  const simpleHtml = await fetch("https://example.com").then(r => r.text());
  const allRulesResult = await testAxeOnLinkedom(simpleHtml, "https://example.com");

  if (allRulesResult.success) {
    console.log(`✅ axe-core ran successfully on linkedom!`);
    console.log(`   Rules ran: ${allRulesResult.rulesRan}`);
    console.log(`   Violations: ${allRulesResult.violations} | Passes: ${allRulesResult.passes} | Incomplete: ${allRulesResult.incomplete}`);
  } else {
    console.log(`❌ axe-core FAILED on linkedom`);
    console.log(`   Errors: ${allRulesResult.errors.join("\n   ")}`);
  }
  console.log();

  // Now test with a real site
  const finnkHtml = fetchResults.find(r => r.url.includes("finnk"))?.htmlSize
    ? await fetch("https://www.finnk.com").then(r => r.text())
    : null;

  if (finnkHtml) {
    console.log("Testing with finnk.com (real site):");
    const finnkResult = await testAxeOnLinkedom(finnkHtml, "https://www.finnk.com");
    if (finnkResult.success) {
      console.log(`✅ axe-core ran on finnk.com via linkedom`);
      console.log(`   Rules ran: ${finnkResult.rulesRan}`);
      console.log(`   Violations: ${finnkResult.violations} | Passes: ${finnkResult.passes} | Incomplete: ${finnkResult.incomplete}`);
    } else {
      console.log(`❌ axe-core FAILED on finnk.com via linkedom`);
      console.log(`   Errors: ${finnkResult.errors.join("\n   ")}`);
    }
    console.log();
  }

  // ─── Part 3: axe-core on linkedom (safe mode — browser rules disabled) ───
  console.log("── PART 3: axe-core on linkedom (safe mode) ──\n");

  const safeSites = ["https://example.com", "https://www.finnk.com", "https://news.ycombinator.com"];

  for (const url of safeSites) {
    try {
      const html = await fetch(url, {
        headers: { "User-Agent": CHROME_UA },
        signal: AbortSignal.timeout(10_000),
      }).then(r => r.text());

      const result = await testAxeOnLinkedomSafe(html, url);
      if (result.success) {
        console.log(`✅ ${url}`);
        console.log(`   Rules ran: ${result.rulesRan} (disabled: ${result.disabledRules.length})`);
        console.log(`   Violations: ${result.violations} | Passes: ${result.passes} | Incomplete: ${result.incomplete}`);
      } else {
        console.log(`❌ ${url}`);
        console.log(`   Error: ${result.error}`);
      }
    } catch (err) {
      console.log(`💀 ${url} — fetch failed: ${err instanceof Error ? err.message : err}`);
    }
    console.log();
  }

  // ─── Part 4: DOM fingerprint feasibility ───
  console.log("── PART 4: DOM fingerprint on fetched HTML ──\n");

  for (const site of TEST_SITES.slice(0, 4)) {
    try {
      const html = await fetch(site.url, {
        headers: { "User-Agent": CHROME_UA },
        signal: AbortSignal.timeout(10_000),
      }).then(r => r.text());

      const { document } = parseHTML(html);
      const elementCount = document.querySelectorAll("*").length;

      // Simple structural fingerprint
      function serialize(el: Element, depth: number): string {
        if (depth > 6) return "";
        const tag = el.tagName?.toLowerCase() || "";
        const role = el.getAttribute?.("role") || "";
        const landmark = ["main", "nav", "header", "footer", "aside", "form"].includes(tag) ? tag : "";
        const sig = role || landmark || tag;
        const children = el.children ? [...el.children] : [];
        const childSigs = children.map(c => serialize(c as Element, depth + 1)).filter(Boolean).join(",");
        return childSigs ? `${sig}(${childSigs})` : sig;
      }

      const skeleton = serialize(document.body as unknown as Element, 0);
      const fingerprint = skeleton.length > 100 ? skeleton.slice(0, 100) + "..." : skeleton;

      console.log(`${site.url}`);
      console.log(`   Elements: ${elementCount} | Fingerprint length: ${skeleton.length} chars`);
      console.log(`   Preview: ${fingerprint}`);
      console.log();
    } catch (err) {
      console.log(`💀 ${site.url} — failed: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  SPIKE COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch(console.error);
