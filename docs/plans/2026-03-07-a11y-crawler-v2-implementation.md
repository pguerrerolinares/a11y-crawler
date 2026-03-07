# A11y Crawler v2 - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an AI-powered accessibility crawler that discovers pages via PlaywrightCrawler + Moonshot LLM and analyzes them with axe-core in a single pass, producing enriched JSON reports with fix suggestions.

**Architecture:** PlaywrightCrawler (Crawlee) handles crawling with a single-pass requestHandler that runs axe-core, builds a tiered page representation (ARIA snapshot -> pruned HTML -> CSS heuristic), sends it to Moonshot AI for nav discovery, interacts with targets, and enriches critical violations with LLM fix suggestions.

**Tech Stack:** TypeScript, Bun, Crawlee (PlaywrightCrawler), @axe-core/playwright, Playwright, OpenAI SDK (for Moonshot API), Zod

**Reference:** Architecture doc at `docs/plans/2026-03-07-a11y-crawler-v2-architecture.md`

---

## Phase 1: Project Setup + Types

### Task 1: Initialize project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `.gitignore`

**Step 1: Create project and init**

```bash
mkdir -p ~/Documentos/proyectos/a11y-crawler-v2
cd ~/Documentos/proyectos/a11y-crawler-v2
bun init -y
```

**Step 2: Install dependencies**

```bash
bun add crawlee @axe-core/playwright playwright openai zod
bun add -d @types/node typescript bun-types
```

**Step 3: Create .gitignore**

```
node_modules/
dist/
*.json
!package.json
!tsconfig.json
.env
report*.json
test-report*.json
```

**Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 5: Create project structure**

```bash
mkdir -p src/{crawler,repr,discovery,analyzer,enrichment,llm,reporter,cli,types}
mkdir -p src/{crawler,repr,discovery,analyzer,enrichment,llm,reporter}/__tests__
```

**Step 6: Create minimal src/index.ts**

```typescript
export { audit } from "./orchestrator.ts";
```

Note: This file will fail to compile until orchestrator exists. That's fine for now.

**Step 7: Init git and commit**

```bash
git init
git add package.json tsconfig.json .gitignore bun.lockb
git commit -m "chore: init project with dependencies"
```

---

### Task 2: Define all TypeScript types

**Files:**
- Create: `src/types/config.ts`
- Create: `src/types/issue.ts`
- Create: `src/types/page.ts`
- Create: `src/types/report.ts`

**Step 1: Create src/types/config.ts**

```typescript
export interface CrawlConfig {
  /** Target base URL */
  baseUrl: string;
  /** Moonshot API key */
  apiKey: string;
  /** Moonshot model ID (default: "moonshot-v1-8k") */
  model: string;
  /** Max pages to crawl (default: 100) */
  maxPages: number;
  /** Max crawl depth from seed (default: 5) */
  maxDepth: number;
  /** Browser concurrency (default: 3) */
  concurrency: number;
  /** Per-page timeout in ms (default: 30000) */
  pageTimeout: number;
  /** WCAG conformance level (default: "AA") */
  wcagLevel: "A" | "AA" | "AAA";
  /** Skip sitemap.xml discovery (default: false) */
  skipSitemap: boolean;
  /** URL patterns to exclude (regex strings) */
  excludePatterns: string[];
  /** Only LLM-enrich issues at these impact levels (default: ["critical", "serious"]) */
  enrichImpactThreshold: ImpactLevel[];
  /** Moonshot API base URL (default: "https://api.moonshot.cn/v1") */
  apiBaseUrl: string;
  /** Max LLM requests per minute (default: 10) */
  rateLimitRpm: number;
}

// Re-export for convenience
import type { ImpactLevel } from "./issue.ts";

export const DEFAULT_CONFIG: Omit<CrawlConfig, "baseUrl" | "apiKey"> = {
  model: "moonshot-v1-8k",
  maxPages: 100,
  maxDepth: 5,
  concurrency: 3,
  pageTimeout: 30000,
  wcagLevel: "AA",
  skipSitemap: false,
  excludePatterns: [],
  enrichImpactThreshold: ["critical", "serious"],
  apiBaseUrl: "https://api.moonshot.cn/v1",
  rateLimitRpm: 10,
};
```

**Step 2: Create src/types/issue.ts**

```typescript
export type ImpactLevel = "critical" | "serious" | "moderate" | "minor";

export type CheckSource = "axe" | "llm";

export type ViolationCategory =
  | "structural"
  | "interactive"
  | "visual"
  | "media"
  | "semantic";

export interface Issue {
  id: string;
  url: string;
  rule: string;
  impact: ImpactLevel;
  description: string;
  help: string;
  helpUrl: string;
  wcagTags: string[];
  selector: string;
  html: string;
  surroundingHtml: string;
  xpath: string;
  viewportWidth: number;
  pageTitle: string;
  checkSource: CheckSource;
  suggestedFix: string | null;
  fixConfidence: "unvalidated, requires human review" | null;
  violationCategory: ViolationCategory;
}
```

**Step 3: Create src/types/page.ts**

```typescript
export type RepresentationTier = "aria-snapshot" | "pruned-html" | "css-heuristic";

export interface PageRepresentation {
  tier: RepresentationTier;
  content: string;
  tokenEstimate: number;
  tierReason: string;
}

export interface NavTarget {
  selector: string;
  description: string;
  expectedBehavior: "navigate" | "expand" | "reveal";
  confidence: number;
}

export interface PageResult {
  url: string;
  title: string;
  issues: Issue[];
  groupedByRule: Record<string, Issue[]>;
  discoveredUrls: string[];
  discoveryMethods: Record<string, "link" | "sitemap" | "interaction">;
  representationTier: RepresentationTier;
  timestamp: string;
  processingMs: number;
}
```

**Step 4: Create src/types/report.ts**

```typescript
import type { ImpactLevel, ViolationCategory } from "./issue.ts";

export interface SiteReport {
  meta: {
    version: "2.0.0";
    generatedAt: string;
    baseUrl: string;
    wcagLevel: "A" | "AA" | "AAA";
    totalDurationSeconds: number;
    toolVersions: {
      crawler: string;
      axeCore: string;
      playwright: string;
    };
  };
  pages: import("./page.ts").PageResult[];
  summary: {
    totalPages: number;
    totalIssues: number;
    issuesByImpact: Record<ImpactLevel, number>;
    issuesByRule: Record<string, number>;
    issuesByCategory: Record<ViolationCategory, number>;
    pagesWithZeroIssues: number;
    averageIssuesPerPage: number;
  };
  sharedIssues: SharedIssue[];
  discovery: {
    totalUrlsDiscovered: number;
    urlsFromSitemap: number;
    urlsFromLinks: number;
    urlsFromInteraction: number;
    urlsAnalyzed: number;
    urlsSkipped: number;
  };
  llmUsage: {
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    estimatedCostUsd: number;
    callsByPurpose: {
      navigation: number;
      enrichment: number;
    };
  };
  errors: CrawlError[];
}

export interface SharedIssue {
  rule: string;
  selectorPattern: string;
  html: string;
  affectedPages: string[];
  pageCount: number;
  suggestedFix: string | null;
}

export interface CrawlError {
  url: string;
  phase: "navigation" | "axe" | "representation" | "llm-nav" | "llm-enrich" | "interaction";
  message: string;
  timestamp: string;
}
```

**Step 5: Run type check**

```bash
bunx tsc --noEmit
```

Expected: May fail because `src/index.ts` references non-existent orchestrator. That's expected.

**Step 6: Commit**

```bash
git add src/types/
git commit -m "feat: define all TypeScript types for crawler, issues, pages, and reports"
```

---

## Phase 2: Safety + Sitemap (Foundation)

### Task 3: Interaction safety module

**Files:**
- Create: `src/crawler/safety.ts`
- Create: `src/crawler/__tests__/safety.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/crawler/__tests__/safety.test.ts
import { describe, test, expect } from "bun:test";
import { isBlacklistedAction, isBlacklistedUrl } from "../safety.ts";

describe("isBlacklistedAction", () => {
  test("blocks dangerous actions", () => {
    expect(isBlacklistedAction("Logout button")).toBe(true);
    expect(isBlacklistedAction("Cerrar sesion")).toBe(true);
    expect(isBlacklistedAction("Delete account")).toBe(true);
    expect(isBlacklistedAction("Buy now")).toBe(true);
    expect(isBlacklistedAction("Accept cookies")).toBe(true);
    expect(isBlacklistedAction("Submit form")).toBe(true);
    expect(isBlacklistedAction("Download PDF")).toBe(true);
  });

  test("allows safe navigation actions", () => {
    expect(isBlacklistedAction("Navigation menu")).toBe(false);
    expect(isBlacklistedAction("Services dropdown")).toBe(false);
    expect(isBlacklistedAction("Expand section")).toBe(false);
    expect(isBlacklistedAction("About us link")).toBe(false);
  });
});

describe("isBlacklistedUrl", () => {
  test("blocks non-HTML URLs", () => {
    expect(isBlacklistedUrl("https://example.com/doc.pdf")).toBe(true);
    expect(isBlacklistedUrl("https://example.com/img.png")).toBe(true);
    expect(isBlacklistedUrl("mailto:a@b.com")).toBe(true);
    expect(isBlacklistedUrl("tel:+34944355050")).toBe(true);
    expect(isBlacklistedUrl("javascript:void(0)")).toBe(true);
  });

  test("allows HTML URLs", () => {
    expect(isBlacklistedUrl("https://example.com/about")).toBe(false);
    expect(isBlacklistedUrl("https://example.com/servicios/")).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/crawler/__tests__/safety.test.ts
```

Expected: FAIL - module not found

**Step 3: Implement safety module**

```typescript
// src/crawler/safety.ts

const ACTION_BLACKLIST = [
  /log\s*out/i, /sign\s*out/i, /cerrar\s*sesi[oó]n/i,
  /delete/i, /eliminar/i, /borrar/i, /remove/i,
  /submit/i, /enviar/i, /send/i,
  /buy/i, /comprar/i, /purchase/i, /pay/i, /pagar/i, /checkout/i,
  /download/i, /descargar/i,
  /subscribe/i, /suscribir/i, /unsubscribe/i,
  /cookie/i, /consent/i, /gdpr/i, /accept.*cookie/i,
];

const URL_BLACKLIST = [
  /\.(pdf|docx?|xlsx?|pptx?|zip|rar|tar|gz)$/i,
  /\.(jpe?g|png|gif|svg|webp|ico|mp[34]|avi|mov|webm)$/i,
  /\.(css|js|json|xml|txt|woff2?|ttf|eot)$/i,
  /^mailto:/i,
  /^tel:/i,
  /^javascript:/i,
  /#$/,
];

export function isBlacklistedAction(description: string): boolean {
  return ACTION_BLACKLIST.some((pattern) => pattern.test(description));
}

export function isBlacklistedUrl(url: string): boolean {
  return URL_BLACKLIST.some((pattern) => pattern.test(url));
}
```

**Step 4: Run tests**

```bash
bun test src/crawler/__tests__/safety.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/crawler/safety.ts src/crawler/__tests__/safety.test.ts
git commit -m "feat: interaction and URL safety blacklists"
```

---

### Task 4: Sitemap URL discovery

**Files:**
- Create: `src/crawler/sitemap.ts`
- Create: `src/crawler/__tests__/sitemap.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/crawler/__tests__/sitemap.test.ts
import { describe, test, expect } from "bun:test";
import { parseSitemapXml } from "../sitemap.ts";

describe("parseSitemapXml", () => {
  test("extracts URLs from sitemap XML", () => {
    const xml = `<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/page1</loc></url>
      <url><loc>https://example.com/page2</loc></url>
    </urlset>`;
    expect(parseSitemapXml(xml)).toEqual([
      "https://example.com/page1",
      "https://example.com/page2",
    ]);
  });

  test("handles empty sitemap", () => {
    const xml = `<?xml version="1.0"?><urlset></urlset>`;
    expect(parseSitemapXml(xml)).toEqual([]);
  });

  test("handles whitespace in loc elements", () => {
    const xml = `<urlset><url><loc>
      https://example.com/page1
    </loc></url></urlset>`;
    expect(parseSitemapXml(xml)).toEqual(["https://example.com/page1"]);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/crawler/__tests__/sitemap.test.ts
```

Expected: FAIL

**Step 3: Implement sitemap module**

```typescript
// src/crawler/sitemap.ts

/**
 * Fetch and parse sitemap.xml URLs. Best-effort, non-blocking.
 */
export async function discoverSitemapUrls(baseUrl: string): Promise<string[]> {
  const urls: string[] = [];
  const sitemapPaths = ["/sitemap.xml", "/sitemap_index.xml"];

  for (const path of sitemapPaths) {
    try {
      const response = await fetch(new URL(path, baseUrl).href, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) continue;

      const xml = await response.text();

      // Check if this is a sitemap index (contains other sitemaps)
      const sitemapRefs = parseSitemapIndex(xml);
      if (sitemapRefs.length > 0) {
        for (const ref of sitemapRefs) {
          try {
            const subResponse = await fetch(ref, {
              signal: AbortSignal.timeout(10000),
            });
            if (!subResponse.ok) continue;
            const subXml = await subResponse.text();
            urls.push(...parseSitemapXml(subXml));
          } catch {
            // Best-effort
          }
        }
      } else {
        urls.push(...parseSitemapXml(xml));
      }
    } catch {
      // Best-effort
    }
  }

  return [...new Set(urls)];
}

/**
 * Parse sitemap XML and extract <loc> URLs.
 */
export function parseSitemapXml(xml: string): string[] {
  const urls: string[] = [];
  const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    if (match[1]) urls.push(match[1].trim());
  }
  return urls;
}

/**
 * Parse sitemap index XML and extract sub-sitemap URLs.
 */
function parseSitemapIndex(xml: string): string[] {
  if (!xml.includes("<sitemapindex")) return [];
  return parseSitemapXml(xml);
}
```

**Step 4: Run tests**

```bash
bun test src/crawler/__tests__/sitemap.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/crawler/sitemap.ts src/crawler/__tests__/sitemap.test.ts
git commit -m "feat: sitemap XML discovery and parsing"
```

---

## Phase 3: LLM Client

### Task 5: Moonshot LLM client with rate limiting

**Files:**
- Create: `src/llm/client.ts`
- Create: `src/llm/__tests__/client.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/llm/__tests__/client.test.ts
import { describe, test, expect } from "bun:test";
import { TokenBucket, estimateTokens } from "../client.ts";

describe("TokenBucket", () => {
  test("allows requests within rate limit", () => {
    const bucket = new TokenBucket(10); // 10 per minute
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
  });

  test("blocks when bucket is empty", () => {
    const bucket = new TokenBucket(2);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });
});

describe("estimateTokens", () => {
  test("estimates token count from text", () => {
    const text = "Hello world, this is a test string";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/llm/__tests__/client.test.ts
```

Expected: FAIL

**Step 3: Implement LLM client**

```typescript
// src/llm/client.ts
import OpenAI from "openai";

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  rateLimitRpm: number;
}

export interface LLMResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMUsageTracker {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  navigationCalls: number;
  enrichmentCalls: number;
}

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private bucket: TokenBucket;
  private maxRetries = 5;
  private circuitBreakerFailures = 0;
  private circuitBreakerThreshold = 3;
  public usage: LLMUsageTracker = {
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    navigationCalls: 0,
    enrichmentCalls: 0,
  };

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.model = config.model;
    this.bucket = new TokenBucket(config.rateLimitRpm);
  }

  async chat(
    messages: OpenAI.ChatCompletionMessageParam[],
    purpose: "navigation" | "enrichment",
  ): Promise<LLMResponse | null> {
    if (this.circuitBreakerFailures >= this.circuitBreakerThreshold) {
      return null;
    }

    await this.bucket.waitForToken();

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages,
          temperature: 0.1,
        });

        this.circuitBreakerFailures = 0;
        const result: LLMResponse = {
          content: response.choices[0]?.message?.content || "",
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        };

        this.usage.totalCalls++;
        this.usage.totalInputTokens += result.inputTokens;
        this.usage.totalOutputTokens += result.outputTokens;
        if (purpose === "navigation") this.usage.navigationCalls++;
        else this.usage.enrichmentCalls++;

        return result;
      } catch (error) {
        const waitMs = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    this.circuitBreakerFailures++;
    return null;
  }
}

export class TokenBucket {
  private tokens: number;
  private capacity: number;
  private refillIntervalMs: number;
  private lastRefill: number;

  constructor(rpm: number) {
    this.capacity = rpm;
    this.tokens = rpm;
    this.refillIntervalMs = (60 * 1000) / rpm;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return true;
    }
    return false;
  }

  async waitForToken(): Promise<void> {
    while (!this.tryConsume()) {
      await new Promise((r) => setTimeout(r, this.refillIntervalMs));
    }
  }
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
```

**Step 4: Run tests**

```bash
bun test src/llm/__tests__/client.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/llm/client.ts src/llm/__tests__/client.test.ts
git commit -m "feat: Moonshot LLM client with rate limiting and circuit breaker"
```

---

## Phase 4: Tiered Page Representation

### Task 6: ARIA snapshot extraction

**Files:**
- Create: `src/repr/aria.ts`
- Create: `src/repr/__tests__/aria.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/repr/__tests__/aria.test.ts
import { describe, test, expect } from "bun:test";
import { countNavNodes } from "../aria.ts";

describe("countNavNodes", () => {
  test("counts navigation-related lines in ARIA YAML", () => {
    const yaml = `- navigation "Main Menu":
  - link "Home"
  - button "Services" [expanded=false]
  - link "About Us"
  - link "Contact"
- contentinfo "Footer":
  - link "Privacy"`;
    expect(countNavNodes(yaml)).toBe(5); // nav, 3 links, 1 button
  });

  test("returns 0 for empty content", () => {
    expect(countNavNodes("")).toBe(0);
  });

  test("counts buttons and links without navigation parent", () => {
    const yaml = `- banner:
  - link "Logo"
  - button "Menu"`;
    expect(countNavNodes(yaml)).toBe(2);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/repr/__tests__/aria.test.ts
```

**Step 3: Implement ARIA extraction**

```typescript
// src/repr/aria.ts
import type { Page } from "playwright";

const NAV_PATTERNS = /\b(navigation|link|button|menuitem|menu|tab)\b/i;

/**
 * Get ARIA snapshot from page. Returns YAML string.
 */
export async function getAriaSnapshot(page: Page): Promise<string> {
  try {
    return await page.locator("body").ariaSnapshot();
  } catch {
    return "";
  }
}

/**
 * Count navigation-relevant nodes in ARIA YAML.
 */
export function countNavNodes(ariaYaml: string): number {
  if (!ariaYaml) return 0;
  const lines = ariaYaml.split("\n");
  return lines.filter((line) => NAV_PATTERNS.test(line)).length;
}
```

**Step 4: Run tests**

```bash
bun test src/repr/__tests__/aria.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/repr/aria.ts src/repr/__tests__/aria.test.ts
git commit -m "feat: ARIA snapshot extraction with nav node counting"
```

---

### Task 7: Pruned HTML extraction

**Files:**
- Create: `src/repr/pruned-html.ts`
- Create: `src/repr/__tests__/pruned-html.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/repr/__tests__/pruned-html.test.ts
import { describe, test, expect } from "bun:test";
import { stripHtmlNoise } from "../pruned-html.ts";

describe("stripHtmlNoise", () => {
  test("removes script tags", () => {
    const html = `<nav><a href="/">Home</a><script>alert(1)</script></nav>`;
    expect(stripHtmlNoise(html)).not.toContain("<script>");
    expect(stripHtmlNoise(html)).toContain('<a href="/">Home</a>');
  });

  test("removes style tags", () => {
    const html = `<nav><style>.foo{color:red}</style><a href="/">Home</a></nav>`;
    expect(stripHtmlNoise(html)).not.toContain("<style>");
  });

  test("removes data-* attributes except data-testid", () => {
    const html = `<a href="/" data-analytics="click" data-testid="home">Home</a>`;
    const result = stripHtmlNoise(html);
    expect(result).not.toContain("data-analytics");
    expect(result).toContain("data-testid");
  });

  test("removes inline styles", () => {
    const html = `<a href="/" style="color: red; font-size: 14px">Home</a>`;
    expect(stripHtmlNoise(html)).not.toContain("style=");
  });

  test("removes SVG content", () => {
    const html = `<nav><svg><path d="M0 0"/></svg><a href="/">Home</a></nav>`;
    expect(stripHtmlNoise(html)).not.toContain("<svg>");
  });

  test("removes HTML comments", () => {
    const html = `<nav><!-- comment --><a href="/">Home</a></nav>`;
    expect(stripHtmlNoise(html)).not.toContain("comment");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/repr/__tests__/pruned-html.test.ts
```

**Step 3: Implement pruned HTML extraction**

```typescript
// src/repr/pruned-html.ts
import type { Page } from "playwright";

const NAV_SELECTORS = [
  "nav",
  '[role="navigation"]',
  '[role="menubar"]',
  '[role="banner"]',
  "header",
  ".nav", ".navbar", ".navigation", ".menu", ".main-nav",
  "#nav", "#navbar", "#navigation", "#menu", "#main-nav",
  "footer",
];

/**
 * Extract navigation-related HTML subtrees from the page.
 */
export async function getPrunedHtml(page: Page): Promise<string> {
  const parts: string[] = [];

  for (const selector of NAV_SELECTORS) {
    try {
      const elements = await page.locator(selector).all();
      for (const el of elements) {
        const html = await el.innerHTML();
        if (html.trim()) {
          parts.push(`<!-- ${selector} -->\n${stripHtmlNoise(html)}`);
        }
      }
    } catch {
      // Element not found, continue
    }
  }

  return parts.join("\n\n");
}

/**
 * Strip noise from HTML: scripts, styles, SVGs, data attributes, inline styles, comments.
 */
export function stripHtmlNoise(html: string): string {
  return html
    // Remove script tags and content
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    // Remove style tags and content
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Remove SVG tags and content
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, "")
    // Remove data-* attributes (except data-testid)
    .replace(/\s+data-(?!testid)[\w-]+(="[^"]*")?/gi, "")
    // Remove inline styles
    .replace(/\s+style="[^"]*"/gi, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}
```

**Step 4: Run tests**

```bash
bun test src/repr/__tests__/pruned-html.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/repr/pruned-html.ts src/repr/__tests__/pruned-html.test.ts
git commit -m "feat: pruned HTML extraction with noise stripping"
```

---

### Task 8: CSS/ID heuristic fallback

**Files:**
- Create: `src/repr/heuristic.ts`
- Create: `src/repr/__tests__/heuristic.test.ts`

**Step 1: Write the failing test**

```typescript
// src/repr/__tests__/heuristic.test.ts
import { describe, test, expect } from "bun:test";
import { formatElementList } from "../heuristic.ts";

describe("formatElementList", () => {
  test("formats links and buttons into readable list", () => {
    const elements = [
      { tag: "a", text: "Home", href: "/", selector: "a.nav-link" },
      { tag: "button", text: "Services", href: null, selector: "button#services" },
    ];
    const result = formatElementList(elements);
    expect(result).toContain("link: 'Home' -> /");
    expect(result).toContain("button: 'Services'");
  });

  test("handles empty list", () => {
    expect(formatElementList([])).toBe("");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/repr/__tests__/heuristic.test.ts
```

**Step 3: Implement heuristic extraction**

```typescript
// src/repr/heuristic.ts
import type { Page } from "playwright";

interface ElementInfo {
  tag: string;
  text: string;
  href: string | null;
  selector: string;
}

/**
 * Enumerate all links and buttons on the page as a simplified list.
 * Last resort when no nav landmarks are found.
 */
export async function getHeuristicElements(page: Page): Promise<string> {
  const elements: ElementInfo[] = await page.evaluate(() => {
    const results: ElementInfo[] = [];
    const seen = new Set<string>();

    // All links
    document.querySelectorAll("a[href]").forEach((el) => {
      const href = el.getAttribute("href");
      const text = (el.textContent || "").trim().slice(0, 50);
      if (href && !seen.has(href) && text) {
        seen.add(href);
        results.push({
          tag: "a",
          text,
          href,
          selector: generateSelector(el),
        });
      }
    });

    // All buttons
    document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"]').forEach((el) => {
      const text = (el.textContent || "").trim().slice(0, 50);
      if (text) {
        results.push({
          tag: el.tagName.toLowerCase(),
          text,
          href: null,
          selector: generateSelector(el),
        });
      }
    });

    function generateSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      const classes = Array.from(el.classList).slice(0, 2).join(".");
      if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
      return el.tagName.toLowerCase();
    }

    return results;
  });

  return formatElementList(elements);
}

/**
 * Format element list into a readable string for LLM consumption.
 */
export function formatElementList(elements: ElementInfo[]): string {
  return elements
    .map((el) => {
      if (el.tag === "a" && el.href) {
        return `- link: '${el.text}' -> ${el.href} [${el.selector}]`;
      }
      return `- ${el.tag === "button" ? "button" : "interactive"}: '${el.text}' [${el.selector}]`;
    })
    .join("\n");
}
```

**Step 4: Run tests**

```bash
bun test src/repr/__tests__/heuristic.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/repr/heuristic.ts src/repr/__tests__/heuristic.test.ts
git commit -m "feat: CSS/ID heuristic fallback for element enumeration"
```

---

### Task 9: Tiered representation builder

**Files:**
- Create: `src/repr/tier.ts`
- Create: `src/repr/__tests__/tier.test.ts`

**Step 1: Write the failing test**

```typescript
// src/repr/__tests__/tier.test.ts
import { describe, test, expect } from "bun:test";
import { selectTier } from "../tier.ts";

describe("selectTier", () => {
  test("selects aria-snapshot when nav nodes >= 3", () => {
    const ariaYaml = `- navigation "Main":
  - link "Home"
  - link "About"
  - button "Services"`;
    const prunedHtml = "";
    const result = selectTier(ariaYaml, prunedHtml);
    expect(result.tier).toBe("aria-snapshot");
    expect(result.content).toBe(ariaYaml);
  });

  test("falls back to pruned-html when aria is sparse", () => {
    const ariaYaml = `- banner:
  - img "Logo"`;
    const prunedHtml = `<nav><a href="/">Home</a><a href="/about">About</a></nav>`;
    const result = selectTier(ariaYaml, prunedHtml);
    expect(result.tier).toBe("pruned-html");
  });

  test("falls back to css-heuristic when both are empty", () => {
    const result = selectTier("", "");
    expect(result.tier).toBe("css-heuristic");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/repr/__tests__/tier.test.ts
```

**Step 3: Implement tier builder**

```typescript
// src/repr/tier.ts
import type { Page } from "playwright";
import type { PageRepresentation } from "../types/page.ts";
import { getAriaSnapshot, countNavNodes } from "./aria.ts";
import { getPrunedHtml } from "./pruned-html.ts";
import { getHeuristicElements } from "./heuristic.ts";
import { estimateTokens } from "../llm/client.ts";

const MIN_NAV_NODES = 3;
const MIN_PRUNED_HTML_LENGTH = 100;

/**
 * Build the best page representation using tiered strategy.
 * Tries: ARIA snapshot -> Pruned HTML -> CSS heuristic
 */
export async function buildRepresentation(page: Page): Promise<PageRepresentation> {
  // Tier 1: ARIA snapshot
  const ariaYaml = await getAriaSnapshot(page);
  const prunedHtml = await getPrunedHtml(page);

  const selected = selectTier(ariaYaml, prunedHtml);

  // If css-heuristic is needed, fetch elements from page
  if (selected.tier === "css-heuristic") {
    const heuristicContent = await getHeuristicElements(page);
    return {
      tier: "css-heuristic",
      content: heuristicContent || "No interactive elements found",
      tokenEstimate: estimateTokens(heuristicContent),
      tierReason: "No landmarks found, using element enumeration",
    };
  }

  return selected;
}

/**
 * Select the best tier based on available content.
 * Pure function for easy testing.
 */
export function selectTier(
  ariaYaml: string,
  prunedHtml: string,
): PageRepresentation {
  // Tier 1: ARIA snapshot
  if (ariaYaml && countNavNodes(ariaYaml) >= MIN_NAV_NODES) {
    return {
      tier: "aria-snapshot",
      content: ariaYaml,
      tokenEstimate: estimateTokens(ariaYaml),
      tierReason: `ARIA snapshot contains ${countNavNodes(ariaYaml)} navigation nodes`,
    };
  }

  // Tier 2: Pruned HTML
  if (prunedHtml.length >= MIN_PRUNED_HTML_LENGTH) {
    return {
      tier: "pruned-html",
      content: prunedHtml,
      tokenEstimate: estimateTokens(prunedHtml),
      tierReason: "ARIA snapshot insufficient, using pruned HTML from landmarks",
    };
  }

  // Tier 3: placeholder - actual content fetched in buildRepresentation
  return {
    tier: "css-heuristic",
    content: "",
    tokenEstimate: 0,
    tierReason: "No landmarks found, using element enumeration",
  };
}
```

**Step 4: Run tests**

```bash
bun test src/repr/__tests__/tier.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/repr/tier.ts src/repr/__tests__/tier.test.ts
git commit -m "feat: tiered page representation builder (ARIA -> HTML -> heuristic)"
```

---

## Phase 5: axe-core + Violation Category Mapping

### Task 10: axe-core analyzer

**Files:**
- Create: `src/analyzer/axe.ts`
- Create: `src/analyzer/category.ts`
- Create: `src/analyzer/__tests__/category.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/analyzer/__tests__/category.test.ts
import { describe, test, expect } from "bun:test";
import { getViolationCategory } from "../category.ts";

describe("getViolationCategory", () => {
  test("maps color-contrast to visual", () => {
    expect(getViolationCategory("color-contrast")).toBe("visual");
  });

  test("maps image-alt to media", () => {
    expect(getViolationCategory("image-alt")).toBe("media");
  });

  test("maps button-name to interactive", () => {
    expect(getViolationCategory("button-name")).toBe("interactive");
  });

  test("maps heading-order to structural", () => {
    expect(getViolationCategory("heading-order")).toBe("structural");
  });

  test("maps html-has-lang to semantic", () => {
    expect(getViolationCategory("html-has-lang")).toBe("semantic");
  });

  test("defaults to structural for unknown rules", () => {
    expect(getViolationCategory("unknown-rule")).toBe("structural");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/analyzer/__tests__/category.test.ts
```

**Step 3: Implement violation category mapping**

```typescript
// src/analyzer/category.ts
import type { ViolationCategory } from "../types/issue.ts";

const CATEGORY_MAP: Record<string, ViolationCategory> = {
  // Structural
  "landmark-one-main": "structural",
  "region": "structural",
  "heading-order": "structural",
  "list": "structural",
  "listitem": "structural",
  "bypass": "structural",
  "page-has-heading-one": "structural",

  // Semantic
  "document-title": "semantic",
  "html-has-lang": "semantic",
  "html-lang-valid": "semantic",
  "valid-lang": "semantic",
  "link-in-text-block": "semantic",

  // Interactive
  "label": "interactive",
  "button-name": "interactive",
  "link-name": "interactive",
  "input-image-alt": "interactive",
  "select-name": "interactive",
  "tabindex": "interactive",
  "focus-order-semantics": "interactive",
  "aria-required-attr": "interactive",
  "aria-valid-attr": "interactive",
  "aria-valid-attr-value": "interactive",
  "aria-roles": "interactive",

  // Visual
  "color-contrast": "visual",
  "meta-viewport": "visual",
  "target-size": "visual",

  // Media
  "image-alt": "media",
  "image-redundant-alt": "media",
  "video-caption": "media",
  "audio-caption": "media",
  "object-alt": "media",
  "svg-img-alt": "media",
};

export function getViolationCategory(ruleId: string): ViolationCategory {
  return CATEGORY_MAP[ruleId] || "structural";
}
```

**Step 4: Run tests**

```bash
bun test src/analyzer/__tests__/category.test.ts
```

Expected: PASS

**Step 5: Implement axe-core wrapper**

```typescript
// src/analyzer/axe.ts
import type { Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import type { Issue, ImpactLevel } from "../types/issue.ts";
import { getViolationCategory } from "./category.ts";

const WCAG_TAGS: Record<string, string[]> = {
  A: ["wcag2a", "wcag21a"],
  AA: ["wcag2a", "wcag21a", "wcag2aa", "wcag21aa", "wcag22aa"],
  AAA: ["wcag2a", "wcag21a", "wcag2aa", "wcag21aa", "wcag22aa", "wcag2aaa", "wcag21aaa"],
};

/**
 * Run axe-core analysis on a page. Returns Issue[].
 */
export async function runAxe(
  page: Page,
  config: { wcagLevel: "A" | "AA" | "AAA" },
): Promise<Issue[]> {
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS[config.wcagLevel] || WCAG_TAGS.AA)
    .analyze();

  const title = await page.title();
  const url = page.url();

  return results.violations.flatMap((v) =>
    v.nodes.map((node) => {
      const parentHtml = node.html;

      return {
        id: `axe-${v.id}-${hashString(url + node.target.join(""))}`,
        url,
        rule: v.id,
        impact: (v.impact || "moderate") as ImpactLevel,
        description: v.description,
        help: v.help,
        helpUrl: v.helpUrl,
        wcagTags: v.tags,
        selector: node.target.join(" > "),
        html: node.html,
        surroundingHtml: parentHtml,
        xpath: node.xpath ? node.xpath.join(" > ") : "",
        viewportWidth: 1280,
        pageTitle: title,
        checkSource: "axe" as const,
        suggestedFix: null,
        fixConfidence: null,
        violationCategory: getViolationCategory(v.id),
      };
    }),
  );
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
```

**Step 6: Commit**

```bash
git add src/analyzer/axe.ts src/analyzer/category.ts src/analyzer/__tests__/category.test.ts
git commit -m "feat: axe-core analyzer with violation category mapping"
```

---

## Phase 6: LLM Navigation Discovery

### Task 11: Navigation discovery with LLM

**Files:**
- Create: `src/discovery/nav.ts`
- Create: `src/discovery/__tests__/nav.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/discovery/__tests__/nav.test.ts
import { describe, test, expect } from "bun:test";
import { parseNavTargets, buildNavPrompt } from "../nav.ts";

describe("parseNavTargets", () => {
  test("parses valid JSON response", () => {
    const response = `[
      {"selector": "button#menu", "description": "Main menu toggle", "expectedBehavior": "expand", "confidence": 0.9},
      {"selector": "a.dropdown", "description": "Services dropdown", "expectedBehavior": "reveal", "confidence": 0.8}
    ]`;
    const targets = parseNavTargets(response);
    expect(targets).toHaveLength(2);
    expect(targets[0].selector).toBe("button#menu");
    expect(targets[0].expectedBehavior).toBe("expand");
  });

  test("returns empty array for invalid JSON", () => {
    expect(parseNavTargets("not json")).toEqual([]);
    expect(parseNavTargets("")).toEqual([]);
  });

  test("filters out targets with confidence < 0.5", () => {
    const response = `[
      {"selector": "a.link", "description": "Low conf", "expectedBehavior": "navigate", "confidence": 0.3}
    ]`;
    expect(parseNavTargets(response)).toEqual([]);
  });

  test("limits to 10 targets max", () => {
    const targets = Array.from({ length: 15 }, (_, i) => ({
      selector: `a#link-${i}`,
      description: `Link ${i}`,
      expectedBehavior: "navigate",
      confidence: 0.9,
    }));
    const result = parseNavTargets(JSON.stringify(targets));
    expect(result).toHaveLength(10);
  });
});

describe("buildNavPrompt", () => {
  test("includes URL and representation content", () => {
    const prompt = buildNavPrompt("https://example.com", "Example", {
      tier: "aria-snapshot",
      content: "- navigation:\n  - link 'Home'",
      tokenEstimate: 20,
      tierReason: "test",
    });
    expect(prompt.user).toContain("https://example.com");
    expect(prompt.user).toContain("aria-snapshot");
    expect(prompt.user).toContain("- navigation:");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/discovery/__tests__/nav.test.ts
```

**Step 3: Implement navigation discovery**

```typescript
// src/discovery/nav.ts
import type { PageRepresentation, NavTarget } from "../types/page.ts";
import type { LLMClient } from "../llm/client.ts";

const NAV_SYSTEM_PROMPT = `You are a web navigation analyzer. Given a page representation, identify interactive elements that reveal additional navigation (menus, dropdowns, accordions, tab panels) or link to other sections of the same website.

Return ONLY a JSON array. Each object must have:
- "selector": a CSS selector that uniquely identifies the element
- "description": what the element is (e.g., "Services dropdown menu")
- "expectedBehavior": one of "navigate", "expand", "reveal"
- "confidence": 0.0 to 1.0

Rules:
- Do NOT include: search inputs, login/logout, cookie banners, external links
- Focus on primary and secondary navigation patterns
- Include hamburger/mobile menu toggles
- Maximum 10 targets per page`;

export function buildNavPrompt(
  url: string,
  title: string,
  repr: PageRepresentation,
): { system: string; user: string } {
  return {
    system: NAV_SYSTEM_PROMPT,
    user: `Page URL: ${url}\nPage title: ${title}\nRepresentation (${repr.tier}):\n\n${repr.content}`,
  };
}

/**
 * Call LLM to discover navigation targets on the page.
 */
export async function discoverNavTargets(
  url: string,
  title: string,
  repr: PageRepresentation,
  llmClient: LLMClient,
): Promise<NavTarget[]> {
  const prompt = buildNavPrompt(url, title, repr);

  const response = await llmClient.chat(
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    "navigation",
  );

  if (!response) return [];
  return parseNavTargets(response.content);
}

/**
 * Parse LLM response into NavTarget array.
 */
export function parseNavTargets(response: string): NavTarget[] {
  try {
    // Extract JSON array from response (may have surrounding text)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (t: any) =>
          t.selector &&
          t.description &&
          t.expectedBehavior &&
          typeof t.confidence === "number" &&
          t.confidence >= 0.5,
      )
      .slice(0, 10)
      .map((t: any) => ({
        selector: String(t.selector),
        description: String(t.description),
        expectedBehavior: t.expectedBehavior as NavTarget["expectedBehavior"],
        confidence: Number(t.confidence),
      }));
  } catch {
    return [];
  }
}
```

**Step 4: Run tests**

```bash
bun test src/discovery/__tests__/nav.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/discovery/nav.ts src/discovery/__tests__/nav.test.ts
git commit -m "feat: LLM navigation discovery with prompt construction and response parsing"
```

---

## Phase 7: LLM Issue Enrichment

### Task 12: Issue enrichment with fix suggestions

**Files:**
- Create: `src/enrichment/prompts.ts`
- Create: `src/enrichment/llm.ts`
- Create: `src/enrichment/__tests__/prompts.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/enrichment/__tests__/prompts.test.ts
import { describe, test, expect } from "bun:test";
import { getPromptForCategory, parseFixes } from "../prompts.ts";

describe("getPromptForCategory", () => {
  test("returns structural prompt for structural category", () => {
    const prompt = getPromptForCategory("structural");
    expect(prompt).toContain("document structure");
  });

  test("returns interactive prompt for interactive category", () => {
    const prompt = getPromptForCategory("interactive");
    expect(prompt).toContain("interactive elements");
  });

  test("returns visual prompt for visual category", () => {
    const prompt = getPromptForCategory("visual");
    expect(prompt).toContain("visual presentation");
  });
});

describe("parseFixes", () => {
  test("parses valid JSON fix response", () => {
    const response = `[
      {"issueId": "axe-color-contrast-abc", "suggestedFix": "<p style='color: #333'>Text</p>"}
    ]`;
    const fixes = parseFixes(response);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].issueId).toBe("axe-color-contrast-abc");
  });

  test("returns empty array for invalid JSON", () => {
    expect(parseFixes("not json")).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/enrichment/__tests__/prompts.test.ts
```

**Step 3: Implement prompts**

```typescript
// src/enrichment/prompts.ts
import type { ViolationCategory } from "../types/issue.ts";

const COMMON_RULES = `Rules:
- Provide the EXACT corrected HTML (not descriptions of what to change)
- Preserve all existing attributes and content
- Only modify what is necessary to fix the violation
- If unsure, say "Manual review required: [reason]"

Respond with a JSON array:
[{ "issueId": "...", "suggestedFix": "corrected HTML or explanation" }]`;

const PROMPTS: Record<ViolationCategory, string> = {
  structural: `You are a WCAG 2.2 accessibility remediation expert specializing in document structure (landmarks, headings, lists, regions).

${COMMON_RULES}`,

  interactive: `You are a WCAG 2.2 accessibility remediation expert specializing in interactive elements (forms, buttons, links, keyboard navigation, ARIA attributes).

${COMMON_RULES}`,

  visual: `You are a WCAG 2.2 accessibility remediation expert specializing in visual presentation (color contrast, text spacing, reflow, resize).

NOTE: Without a screenshot, base suggestions on the HTML/CSS provided. If the fix requires visual verification, say "Requires visual review: [reason]".

${COMMON_RULES}`,

  media: `You are a WCAG 2.2 accessibility remediation expert specializing in non-text content (images, video, audio, objects).

${COMMON_RULES}`,

  semantic: `You are a WCAG 2.2 accessibility remediation expert specializing in semantics (language attributes, link purpose, page titles).

${COMMON_RULES}`,
};

export function getPromptForCategory(category: ViolationCategory): string {
  return PROMPTS[category];
}

export interface FixResult {
  issueId: string;
  suggestedFix: string;
}

export function parseFixes(response: string): FixResult[] {
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((f: any) => f.issueId && f.suggestedFix)
      .map((f: any) => ({
        issueId: String(f.issueId),
        suggestedFix: String(f.suggestedFix),
      }));
  } catch {
    return [];
  }
}
```

**Step 4: Run tests**

```bash
bun test src/enrichment/__tests__/prompts.test.ts
```

Expected: PASS

**Step 5: Implement issue enrichment**

```typescript
// src/enrichment/llm.ts
import type { Issue, ViolationCategory } from "../types/issue.ts";
import type { LLMClient } from "../llm/client.ts";
import { getPromptForCategory, parseFixes } from "./prompts.ts";

/**
 * Enrich issues with LLM-generated fix suggestions.
 * Groups by violation category, sends one prompt per category batch.
 */
export async function enrichIssues(
  issues: Issue[],
  llmClient: LLMClient,
): Promise<Issue[]> {
  if (issues.length === 0) return issues;

  // Group by category
  const byCategory = new Map<ViolationCategory, Issue[]>();
  for (const issue of issues) {
    const existing = byCategory.get(issue.violationCategory) || [];
    existing.push(issue);
    byCategory.set(issue.violationCategory, existing);
  }

  const fixMap = new Map<string, string>();

  for (const [category, categoryIssues] of byCategory) {
    const systemPrompt = getPromptForCategory(category);
    const userContent = categoryIssues
      .map(
        (issue) =>
          `### Violation: ${issue.rule} (${issue.impact})\nID: ${issue.id}\nDescription: ${issue.description}\nCurrent HTML:\n\`\`\`html\n${issue.surroundingHtml || issue.html}\n\`\`\`\nSelector: ${issue.selector}`,
      )
      .join("\n\n");

    const response = await llmClient.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Page: ${categoryIssues[0].url}\n\n${userContent}` },
      ],
      "enrichment",
    );

    if (response) {
      const fixes = parseFixes(response.content);
      for (const fix of fixes) {
        fixMap.set(fix.issueId, fix.suggestedFix);
      }
    }
  }

  // Apply fixes back to issues
  return issues.map((issue) => {
    const fix = fixMap.get(issue.id);
    if (fix) {
      return {
        ...issue,
        suggestedFix: fix,
        fixConfidence: "unvalidated, requires human review" as const,
      };
    }
    return issue;
  });
}
```

**Step 6: Commit**

```bash
git add src/enrichment/prompts.ts src/enrichment/llm.ts src/enrichment/__tests__/prompts.test.ts
git commit -m "feat: LLM issue enrichment with 5-category prompt strategy"
```

---

## Phase 8: Shared Issue Detection + Reporter

### Task 13: Shared issue detection

**Files:**
- Create: `src/reporter/shared.ts`
- Create: `src/reporter/__tests__/shared.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/reporter/__tests__/shared.test.ts
import { describe, test, expect } from "bun:test";
import { detectSharedIssues } from "../shared.ts";
import type { PageResult } from "../../types/page.ts";

describe("detectSharedIssues", () => {
  test("detects issues appearing on 3+ pages", () => {
    const pages: PageResult[] = [
      makePage("https://a.com/1", [makeIssue("image-alt", '<img src="logo.png">')]),
      makePage("https://a.com/2", [makeIssue("image-alt", '<img src="logo.png">')]),
      makePage("https://a.com/3", [makeIssue("image-alt", '<img src="logo.png">')]),
    ];
    const shared = detectSharedIssues(pages);
    expect(shared).toHaveLength(1);
    expect(shared[0].rule).toBe("image-alt");
    expect(shared[0].pageCount).toBe(3);
  });

  test("ignores issues on fewer than 3 pages", () => {
    const pages: PageResult[] = [
      makePage("https://a.com/1", [makeIssue("image-alt", '<img src="logo.png">')]),
      makePage("https://a.com/2", [makeIssue("image-alt", '<img src="logo.png">')]),
    ];
    expect(detectSharedIssues(pages)).toHaveLength(0);
  });

  test("groups by rule + html combination", () => {
    const pages: PageResult[] = [
      makePage("https://a.com/1", [
        makeIssue("image-alt", '<img src="logo.png">'),
        makeIssue("image-alt", '<img src="hero.png">'),
      ]),
      makePage("https://a.com/2", [makeIssue("image-alt", '<img src="logo.png">')]),
      makePage("https://a.com/3", [makeIssue("image-alt", '<img src="logo.png">')]),
    ];
    const shared = detectSharedIssues(pages);
    expect(shared).toHaveLength(1); // Only logo appears 3 times
    expect(shared[0].html).toContain("logo.png");
  });
});

// Helpers
function makePage(url: string, issues: any[]): PageResult {
  return {
    url,
    title: "Test",
    issues,
    groupedByRule: {},
    discoveredUrls: [],
    discoveryMethods: {},
    representationTier: "aria-snapshot",
    timestamp: new Date().toISOString(),
    processingMs: 1000,
  };
}

function makeIssue(rule: string, html: string) {
  return {
    id: `axe-${rule}-${Math.random().toString(36).slice(2)}`,
    url: "",
    rule,
    impact: "serious" as const,
    description: "",
    help: "",
    helpUrl: "",
    wcagTags: [],
    selector: "img",
    html,
    surroundingHtml: html,
    xpath: "",
    viewportWidth: 1280,
    pageTitle: "Test",
    checkSource: "axe" as const,
    suggestedFix: null,
    fixConfidence: null,
    violationCategory: "media" as const,
  };
}
```

**Step 2: Run tests to verify they fail**

```bash
bun test src/reporter/__tests__/shared.test.ts
```

**Step 3: Implement shared issue detection**

```typescript
// src/reporter/shared.ts
import type { PageResult } from "../types/page.ts";
import type { SharedIssue } from "../types/report.ts";

const MIN_SHARED_PAGES = 3;

/**
 * Detect issues appearing on 3+ pages (likely template/component issues).
 */
export function detectSharedIssues(pages: PageResult[]): SharedIssue[] {
  const groups = new Map<string, {
    rule: string;
    html: string;
    selector: string;
    pages: Set<string>;
    suggestedFix: string | null;
  }>();

  for (const page of pages) {
    for (const issue of page.issues) {
      const key = `${issue.rule}::${normalizeHtml(issue.html)}`;

      if (!groups.has(key)) {
        groups.set(key, {
          rule: issue.rule,
          html: issue.html,
          selector: issue.selector,
          pages: new Set(),
          suggestedFix: null,
        });
      }

      const group = groups.get(key)!;
      group.pages.add(page.url);
      if (issue.suggestedFix && !group.suggestedFix) {
        group.suggestedFix = issue.suggestedFix;
      }
    }
  }

  return [...groups.values()]
    .filter((g) => g.pages.size >= MIN_SHARED_PAGES)
    .sort((a, b) => b.pages.size - a.pages.size)
    .map((g) => ({
      rule: g.rule,
      selectorPattern: g.selector,
      html: g.html,
      affectedPages: [...g.pages],
      pageCount: g.pages.size,
      suggestedFix: g.suggestedFix,
    }));
}

function normalizeHtml(html: string): string {
  return html.replace(/\s+/g, " ").trim().toLowerCase();
}
```

**Step 4: Run tests**

```bash
bun test src/reporter/__tests__/shared.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/reporter/shared.ts src/reporter/__tests__/shared.test.ts
git commit -m "feat: shared issue detection for template-level violations"
```

---

### Task 14: JSON reporter

**Files:**
- Create: `src/reporter/json.ts`

**Step 1: Implement JSON reporter**

```typescript
// src/reporter/json.ts
import type { SiteReport } from "../types/report.ts";

/**
 * Write the full report as JSON.
 */
export async function writeReport(
  report: SiteReport,
  outputPath: string,
): Promise<void> {
  const json = JSON.stringify(report, null, 2);
  await Bun.write(outputPath, json);
}
```

**Step 2: Commit**

```bash
git add src/reporter/json.ts
git commit -m "feat: JSON report writer"
```

---

## Phase 9: Orchestrator + Crawler

### Task 15: Request handler (core crawler logic)

**Files:**
- Create: `src/crawler/crawler.ts`

**Step 1: Implement the request handler**

```typescript
// src/crawler/crawler.ts
import type { PlaywrightCrawlingContext } from "crawlee";
import type { CrawlConfig } from "../types/config.ts";
import type { PageResult } from "../types/page.ts";
import type { Issue } from "../types/issue.ts";
import type { LLMClient } from "../llm/client.ts";
import { runAxe } from "../analyzer/axe.ts";
import { buildRepresentation } from "../repr/tier.ts";
import { discoverNavTargets } from "../discovery/nav.ts";
import { enrichIssues } from "../enrichment/llm.ts";
import { isBlacklistedAction, isBlacklistedUrl } from "./safety.ts";

export interface HandlerDeps {
  config: CrawlConfig;
  llmClient: LLMClient;
  discoveredUrls: Map<string, "link" | "sitemap" | "interaction">;
}

export function createRequestHandler(deps: HandlerDeps) {
  const { config, llmClient, discoveredUrls } = deps;

  return async function requestHandler(
    context: PlaywrightCrawlingContext,
  ): Promise<PageResult> {
    const { page, request, enqueueLinks, log } = context;
    const startTime = Date.now();
    const url = request.loadedUrl || request.url;

    log.info(`Processing: ${url}`);

    // STEP 1: Navigate (already done by Crawlee, but ensure networkidle)
    try {
      await page.waitForLoadState("networkidle", { timeout: config.pageTimeout });
    } catch {
      // Timeout waiting for networkidle is acceptable
    }

    // STEP 2: Run axe-core FIRST (before any interactions)
    let axeIssues: Issue[] = [];
    try {
      axeIssues = await runAxe(page, { wcagLevel: config.wcagLevel });
    } catch (err) {
      log.warning(`axe-core failed on ${url}: ${err}`);
    }

    // STEP 3: Build page representation
    const repr = await buildRepresentation(page);
    log.info(`Representation: ${repr.tier} (~${repr.tokenEstimate} tokens)`);

    // STEP 4: LLM navigation discovery
    const title = await page.title();
    const navTargets = await discoverNavTargets(url, title, repr, llmClient);
    log.info(`Nav targets: ${navTargets.length}`);

    // STEP 5: Standard link extraction
    await enqueueLinks({
      strategy: "same-origin",
      transformRequestFunction: (req) => {
        if (isBlacklistedUrl(req.url)) return false;
        if (!discoveredUrls.has(normalizeUrl(req.url))) {
          discoveredUrls.set(normalizeUrl(req.url), "link");
        }
        return req;
      },
    });

    // STEP 6: Interact with nav targets
    for (const target of navTargets) {
      if (isBlacklistedAction(target.description)) continue;

      try {
        const urlBefore = page.url();
        await page.locator(target.selector).click({ timeout: 3000 });
        await page.waitForTimeout(1500);
        const urlAfter = page.url();

        if (urlAfter !== urlBefore) {
          const normalized = normalizeUrl(urlAfter);
          if (
            new URL(urlAfter).origin === new URL(url).origin &&
            !isBlacklistedUrl(urlAfter) &&
            !discoveredUrls.has(normalized)
          ) {
            discoveredUrls.set(normalized, "interaction");
            await context.addRequests([{ url: urlAfter }]);
          }
          await page.goBack({ waitUntil: "networkidle" }).catch(() => {});
        } else {
          await enqueueLinks({
            strategy: "same-origin",
            transformRequestFunction: (req) => {
              if (isBlacklistedUrl(req.url)) return false;
              const norm = normalizeUrl(req.url);
              if (!discoveredUrls.has(norm)) {
                discoveredUrls.set(norm, "interaction");
              }
              return req;
            },
          });
        }
      } catch {
        log.debug(`Interaction failed: ${target.description}`);
      }
    }

    // STEP 7: LLM-enrich critical/serious issues
    const issuesToEnrich = axeIssues.filter((i) =>
      config.enrichImpactThreshold.includes(i.impact),
    );
    let enrichedIssues = axeIssues;
    if (issuesToEnrich.length > 0) {
      const enriched = await enrichIssues(issuesToEnrich, llmClient);
      const enrichedMap = new Map(enriched.map((i) => [i.id, i]));
      enrichedIssues = axeIssues.map((i) => enrichedMap.get(i.id) || i);
    }

    // STEP 8: Build PageResult
    const groupedByRule: Record<string, Issue[]> = {};
    for (const issue of enrichedIssues) {
      if (!groupedByRule[issue.rule]) groupedByRule[issue.rule] = [];
      groupedByRule[issue.rule].push(issue);
    }

    const pageDiscoveredUrls = [...discoveredUrls.entries()]
      .filter(([u]) => u !== normalizeUrl(url))
      .map(([u]) => u);

    return {
      url,
      title,
      issues: enrichedIssues,
      groupedByRule,
      discoveredUrls: pageDiscoveredUrls,
      discoveryMethods: Object.fromEntries(discoveredUrls),
      representationTier: repr.tier,
      timestamp: new Date().toISOString(),
      processingMs: Date.now() - startTime,
    };
  };
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.href;
  } catch {
    return url;
  }
}
```

**Step 2: Commit**

```bash
git add src/crawler/crawler.ts
git commit -m "feat: request handler with single-pass discovery + analysis pipeline"
```

---

### Task 16: Orchestrator

**Files:**
- Create: `src/orchestrator.ts`

**Step 1: Implement orchestrator**

```typescript
// src/orchestrator.ts
import { PlaywrightCrawler } from "crawlee";
import type { CrawlConfig } from "./types/config.ts";
import type { SiteReport, CrawlError } from "./types/report.ts";
import type { PageResult } from "./types/page.ts";
import type { ImpactLevel, ViolationCategory } from "./types/issue.ts";
import { LLMClient } from "./llm/client.ts";
import { createRequestHandler } from "./crawler/crawler.ts";
import { discoverSitemapUrls } from "./crawler/sitemap.ts";
import { detectSharedIssues } from "./reporter/shared.ts";
import { DEFAULT_CONFIG } from "./types/config.ts";

export async function audit(
  userConfig: Partial<CrawlConfig> & { baseUrl: string; apiKey: string },
): Promise<SiteReport> {
  const config: CrawlConfig = { ...DEFAULT_CONFIG, ...userConfig };
  const startTime = Date.now();
  const pages: PageResult[] = [];
  const errors: CrawlError[] = [];
  const discoveredUrls = new Map<string, "link" | "sitemap" | "interaction">();

  const llmClient = new LLMClient({
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    model: config.model,
    rateLimitRpm: config.rateLimitRpm,
  });

  // Phase 1: Sitemap discovery
  const seedUrls: string[] = [config.baseUrl];
  if (!config.skipSitemap) {
    console.log("=== Sitemap Discovery ===");
    const sitemapUrls = await discoverSitemapUrls(config.baseUrl);
    console.log(`Found ${sitemapUrls.length} URLs from sitemap`);
    const baseOrigin = new URL(config.baseUrl).origin;
    for (const url of sitemapUrls) {
      try {
        if (new URL(url).origin === baseOrigin) {
          discoveredUrls.set(url, "sitemap");
          seedUrls.push(url);
        }
      } catch {}
    }
    // Limit sitemap seeds
    if (seedUrls.length > config.maxPages / 2) {
      seedUrls.length = Math.ceil(config.maxPages / 2);
    }
  }

  // Phase 2: Crawl + Analyze
  console.log("\n=== Crawl + Analysis ===");
  const handler = createRequestHandler({ config, llmClient, discoveredUrls });

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: config.maxPages,
    maxConcurrency: config.concurrency,
    requestHandlerTimeoutSecs: config.pageTimeout / 1000 * 3,
    headless: true,

    async requestHandler(context) {
      try {
        const result = await handler(context);
        pages.push(result);
        console.log(
          `  [${pages.length}] ${result.url} - ${result.issues.length} issues (${result.representationTier})`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          url: context.request.url,
          phase: "navigation",
          message: msg,
          timestamp: new Date().toISOString(),
        });
      }
    },

    failedRequestHandler({ request }, error) {
      errors.push({
        url: request.url,
        phase: "navigation",
        message: error.message,
        timestamp: new Date().toISOString(),
      });
    },
  });

  await crawler.run(seedUrls);

  // Phase 3: Post-processing
  console.log("\n=== Post-processing ===");
  const sharedIssues = detectSharedIssues(pages);
  console.log(`Detected ${sharedIssues.length} shared issues`);

  const allIssues = pages.flatMap((p) => p.issues);
  const totalDuration = Math.round((Date.now() - startTime) / 1000);

  const countByImpact = (level: ImpactLevel) =>
    allIssues.filter((i) => i.impact === level).length;
  const countByCategory = (cat: ViolationCategory) =>
    allIssues.filter((i) => i.violationCategory === cat).length;

  const issuesByRule: Record<string, number> = {};
  for (const issue of allIssues) {
    issuesByRule[issue.rule] = (issuesByRule[issue.rule] || 0) + 1;
  }

  const estimatedCost =
    (llmClient.usage.totalInputTokens + llmClient.usage.totalOutputTokens) *
    0.000001; // rough estimate

  return {
    meta: {
      version: "2.0.0",
      generatedAt: new Date().toISOString(),
      baseUrl: config.baseUrl,
      wcagLevel: config.wcagLevel,
      totalDurationSeconds: totalDuration,
      toolVersions: {
        crawler: "2.0.0",
        axeCore: "4.10.x",
        playwright: "1.50.x",
      },
    },
    pages,
    summary: {
      totalPages: pages.length,
      totalIssues: allIssues.length,
      issuesByImpact: {
        critical: countByImpact("critical"),
        serious: countByImpact("serious"),
        moderate: countByImpact("moderate"),
        minor: countByImpact("minor"),
      },
      issuesByRule,
      issuesByCategory: {
        structural: countByCategory("structural"),
        interactive: countByCategory("interactive"),
        visual: countByCategory("visual"),
        media: countByCategory("media"),
        semantic: countByCategory("semantic"),
      },
      pagesWithZeroIssues: pages.filter((p) => p.issues.length === 0).length,
      averageIssuesPerPage:
        pages.length > 0 ? Math.round((allIssues.length / pages.length) * 100) / 100 : 0,
    },
    sharedIssues,
    discovery: {
      totalUrlsDiscovered: discoveredUrls.size,
      urlsFromSitemap: [...discoveredUrls.values()].filter((s) => s === "sitemap").length,
      urlsFromLinks: [...discoveredUrls.values()].filter((s) => s === "link").length,
      urlsFromInteraction: [...discoveredUrls.values()].filter((s) => s === "interaction").length,
      urlsAnalyzed: pages.length,
      urlsSkipped: discoveredUrls.size - pages.length,
    },
    llmUsage: {
      totalCalls: llmClient.usage.totalCalls,
      totalInputTokens: llmClient.usage.totalInputTokens,
      totalOutputTokens: llmClient.usage.totalOutputTokens,
      estimatedCostUsd: Math.round(estimatedCost * 100) / 100,
      callsByPurpose: {
        navigation: llmClient.usage.navigationCalls,
        enrichment: llmClient.usage.enrichmentCalls,
      },
    },
    errors,
  };
}
```

**Step 2: Update src/index.ts**

```typescript
// src/index.ts
export { audit } from "./orchestrator.ts";
```

**Step 3: Commit**

```bash
git add src/orchestrator.ts src/index.ts
git commit -m "feat: orchestrator with single-pass crawl lifecycle and post-processing"
```

---

## Phase 10: CLI

### Task 17: CLI entry point

**Files:**
- Create: `src/cli/index.ts`
- Modify: `package.json` (add scripts)

**Step 1: Implement CLI**

```typescript
// src/cli/index.ts
import { parseArgs } from "util";
import { audit } from "../orchestrator.ts";
import { writeReport } from "../reporter/json.ts";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: "string" },
      output: { type: "string", short: "o", default: "report.json" },
      "api-key": { type: "string" },
      "max-pages": { type: "string", default: "100" },
      "max-depth": { type: "string", default: "5" },
      model: { type: "string", default: "moonshot-v1-8k" },
      "api-base-url": { type: "string", default: "https://api.moonshot.cn/v1" },
      wcag: { type: "string", default: "AA" },
      concurrency: { type: "string", default: "3" },
      "no-sitemap": { type: "boolean", default: false },
      "no-enrich": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || !values.url) {
    console.log(`
a11y-crawler-v2 - AI-powered accessibility auditor

USAGE:
  bun run src/cli/index.ts --url <url> [options]

OPTIONS:
  --url <url>              Target URL (required)
  --api-key <key>          LLM API key (or set LLM_API_KEY env var)
  --output, -o <file>      Output file (default: report.json)
  --max-pages <n>          Max pages to discover (default: 100)
  --max-depth <n>          Max crawl depth (default: 5)
  --model <model>          LLM model (default: moonshot-v1-8k)
  --api-base-url <url>     LLM API base URL (default: https://api.moonshot.cn/v1)
  --wcag <level>           WCAG level: A, AA, AAA (default: AA)
  --concurrency <n>        Parallel pages (default: 3)
  --no-sitemap             Skip sitemap discovery
  --no-enrich              Skip LLM fix suggestions
  --help, -h               Show help
    `);
    process.exit(values.help ? 0 : 1);
  }

  const apiKey = values["api-key"] || process.env.LLM_API_KEY;
  if (!apiKey) {
    console.error("Error: --api-key or LLM_API_KEY env var required");
    process.exit(1);
  }

  console.log(`\nA11y Crawler v2`);
  console.log(`Target: ${values.url}`);
  console.log(`WCAG Level: ${values.wcag}`);
  console.log(`Max Pages: ${values["max-pages"]}\n`);

  const report = await audit({
    baseUrl: values.url,
    apiKey,
    maxPages: parseInt(values["max-pages"]!, 10),
    maxDepth: parseInt(values["max-depth"]!, 10),
    model: values.model!,
    apiBaseUrl: values["api-base-url"]!,
    wcagLevel: values.wcag as "A" | "AA" | "AAA",
    concurrency: parseInt(values.concurrency!, 10),
    skipSitemap: values["no-sitemap"]!,
    enrichImpactThreshold: values["no-enrich"] ? [] : ["critical", "serious"],
  });

  await writeReport(report, values.output!);

  console.log(`\n=== Results ===`);
  console.log(`Pages analyzed: ${report.summary.totalPages}`);
  console.log(`Total issues: ${report.summary.totalIssues}`);
  console.log(`  Critical: ${report.summary.issuesByImpact.critical}`);
  console.log(`  Serious: ${report.summary.issuesByImpact.serious}`);
  console.log(`  Moderate: ${report.summary.issuesByImpact.moderate}`);
  console.log(`  Minor: ${report.summary.issuesByImpact.minor}`);
  console.log(`Shared issues: ${report.sharedIssues.length}`);
  console.log(`LLM calls: ${report.llmUsage.totalCalls} (~$${report.llmUsage.estimatedCostUsd})`);
  console.log(`Duration: ${report.meta.totalDurationSeconds}s`);
  console.log(`\nReport saved to: ${values.output}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
```

**Step 2: Add scripts to package.json**

Add to `package.json`:
```json
{
  "scripts": {
    "cli": "bun run src/cli/index.ts",
    "test": "bun test"
  }
}
```

**Step 3: Commit**

```bash
git add src/cli/index.ts package.json
git commit -m "feat: CLI with full options (url, model, wcag level, enrichment toggle)"
```

---

## Phase 11: Integration Test

### Task 18: Run all unit tests

**Step 1: Run full test suite**

```bash
bun test
```

Expected: All tests pass.

**Step 2: Fix any failures**

Address any test failures before proceeding.

**Step 3: Commit if any fixes were needed**

```bash
git add -A && git commit -m "fix: resolve test failures"
```

---

### Task 19: E2E manual test

**Step 1: Run against a real site**

```bash
LLM_API_KEY=<key> bun run cli --url https://kutxabankinvestment.es --max-pages 10 --output test-report.json
```

**Step 2: Validate output**

```bash
cat test-report.json | bun -e "const r = await Bun.file('test-report.json').json(); console.log('Pages:', r.summary.totalPages); console.log('Issues:', r.summary.totalIssues); console.log('Discovery:', r.discovery); console.log('LLM:', r.llmUsage); console.log('Shared:', r.sharedIssues.length);"
```

**Expected behavior:**
- Discovery finds URLs from sitemap + links + LLM interactions
- axe-core reports violations per page
- Issues grouped by rule in each PageResult
- Critical/serious issues have `suggestedFix` populated
- Shared issues detected if same violation appears on 3+ pages
- LLM usage tracked with call counts and token estimates

**Step 3: Commit**

```bash
git add -A && git commit -m "test: e2e validation with kutxabankinvestment.es"
```

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-2 | Project setup + TypeScript types |
| 2 | 3-4 | Safety blacklists + Sitemap discovery |
| 3 | 5 | Moonshot LLM client with rate limiting |
| 4 | 6-9 | Tiered page representation (ARIA -> HTML -> heuristic) |
| 5 | 10 | axe-core analyzer + violation category mapping |
| 6 | 11 | LLM navigation discovery |
| 7 | 12 | LLM issue enrichment with fix suggestions |
| 8 | 13-14 | Shared issue detection + JSON reporter |
| 9 | 15-16 | Request handler + Orchestrator |
| 10 | 17 | CLI |
| 11 | 18-19 | Integration test |

**Total: 19 tasks, ~17 files, ~1200 lines of implementation code.**
