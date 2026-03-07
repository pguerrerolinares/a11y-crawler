# A11y Crawler v2 - Architecture Proposal

> **Date:** 2026-03-07
> **Status:** Draft - Pending review by critic agent
> **Supersedes:** `2026-03-07-a11y-crawler-v2-design.md` (StagehandCrawler approach abandoned)

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Crawler engine | Crawlee `PlaywrightCrawler` | Stable, Bun-compatible. `@crawlee/stagehand` is unverified. |
| LLM provider | Moonshot AI via OpenAI SDK | OpenAI-compatible API, cost-effective. No vision support. |
| Discovery + Analysis | Single-pass (one visit per page) | Halves browser overhead and page loads. |
| Page representation | Tiered: ARIA snapshot -> pruned HTML -> class/ID heuristics | Handles both accessible and inaccessible sites. |
| A11y detection | axe-core as primary, LLM for fix suggestions | axe-core is deterministic and free; LLM adds remediation value. |
| ARIA snapshot API | `page.locator('body').ariaSnapshot()` (YAML) | `page.accessibility.snapshot()` is deprecated. |

---

## 1. Architecture Diagram

```
                         +---------------------------+
                         |       CLI / API Entry     |
                         |   src/cli/index.ts        |
                         +------------+--------------+
                                      |
                                      | CrawlConfig
                                      v
                         +---------------------------+
                         |       Orchestrator        |
                         |   src/orchestrator.ts     |
                         |                           |
                         |  - Manages crawl lifecycle|
                         |  - Aggregates results     |
                         |  - Detects shared issues  |
                         +------+----------+--------+
                                |          |
                   CrawlConfig  |          | SiteReport
                                v          ^
                    +-----------+----------+---------+
                    |      PlaywrightCrawler         |
                    |   src/crawler/crawler.ts       |
                    |                                |
                    |  requestHandler (per page):    |
                    |  1. goto (networkidle)          |
                    |  2. axe-core scan              |
                    |  3. page representation        |
                    |  4. LLM nav discovery          |
                    |  5. interact + enqueue         |
                    |  6. LLM fix suggestions        |
                    +---+------+------+------+------+
                        |      |      |      |
               +--------+  +--+--+  +-+---+ ++---------+
               |           |     |  |     | |          |
    +----------v---+ +----v---+ +v------+ +v--------+ +v-----------+
    | AxeAnalyzer  | | PageRep| | NavDis| | LLMEnri | | Reporter   |
    | src/analyzer | | src/   | | src/  | | src/    | | src/       |
    | /axe.ts      | | repr/  | | disc/ | | enrich/ | | reporter/  |
    |              | | tier.ts| | nav.ts| | llm.ts  | | json.ts    |
    | - inject axe | | - aria | | - LLM | | - fix   | | - JSON out |
    | - parse viols| |   snap | |   call | |   suggest| | - grouping|
    | - map to     | | - prune| | - sel  | | - cost  | |            |
    |   Issue[]    | |   HTML | |   parse| |   gate  | |            |
    +--------------+ | - CSS  | +-------+ +---------+ +------------+
                     |   fall |
                     |   back |
                     +--------+
```

### Data Flow (per page visit)

```
  goto(url, networkidle)
         |
         v
  axe-core.analyze()  ------------>  Issue[] (deterministic)
         |
         v
  buildPageRepresentation()  ------>  { tier, content, tokens }
         |
         v
  LLM: discoverNavigation()  ----->  NavTarget[] (selectors to click)
         |
         v
  for each NavTarget:
    click -> wait -> extract new URLs -> enqueue
    (goBack if navigated away)
         |
         v
  LLM: enrichIssues()  ----------->  Issue[] with suggestedFix
  (only critical/serious, cost-gated)
         |
         v
  return PageResult
```

---

## 2. Module List

### `src/cli/index.ts` - CLI Entry Point
**Responsibility:** Parse CLI args, validate config, invoke orchestrator, write output.
**Interface:** `main(argv: string[]): Promise<void>`

### `src/orchestrator.ts` - Crawl Lifecycle Manager
**Responsibility:** Configure PlaywrightCrawler, aggregate PageResults into SiteReport, detect shared violations across pages, manage rate limiting.
**Interface:**
```
audit(config: CrawlConfig): Promise<SiteReport>
```

### `src/crawler/crawler.ts` - Request Handler
**Responsibility:** Single-page processing pipeline. Coordinates axe, page representation, nav discovery, LLM enrichment within one page visit.
**Interface:**
```
createRequestHandler(deps: HandlerDeps): RequestHandler
```

### `src/analyzer/axe.ts` - Axe-Core Wrapper
**Responsibility:** Run axe-core on a Playwright Page, map violations to our Issue type. Configurable WCAG level.
**Interface:**
```
runAxe(page: Page, config: AxeConfig): Promise<Issue[]>
```

### `src/repr/tier.ts` - Tiered Page Representation
**Responsibility:** Build the most efficient page representation for the LLM. Implements the decision tree: try ARIA snapshot first, fall back to pruned HTML, then CSS/ID heuristics.
**Interface:**
```
buildRepresentation(page: Page): Promise<PageRepresentation>
```

### `src/discovery/nav.ts` - LLM Navigation Discovery
**Responsibility:** Send page representation to Moonshot, parse response into clickable selectors. Handles prompt construction and response parsing.
**Interface:**
```
discoverNavTargets(repr: PageRepresentation, llmClient: LLMClient): Promise<NavTarget[]>
```

### `src/enrichment/llm.ts` - LLM Issue Enrichment
**Responsibility:** For critical/serious axe violations, ask LLM for fix suggestions. Cost-gated: skips minor/moderate. Batches violations by rule for efficiency.
**Interface:**
```
enrichIssues(issues: Issue[], pageContext: PageContext, llmClient: LLMClient): Promise<Issue[]>
```

### `src/llm/client.ts` - Moonshot LLM Client
**Responsibility:** OpenAI-compatible client with exponential backoff, rate limiting, token counting. Single client shared across all LLM callers.
**Interface:**
```
createLLMClient(config: LLMConfig): LLMClient
LLMClient.chat(messages: Message[], schema?: ZodSchema): Promise<LLMResponse>
```

### `src/reporter/json.ts` - JSON Report Writer
**Responsibility:** Serialize SiteReport to JSON. Handle Map serialization, add metadata.
**Interface:**
```
writeReport(report: SiteReport, path: string): Promise<void>
```

### `src/crawler/sitemap.ts` - Sitemap Discovery
**Responsibility:** Fetch and parse sitemap.xml, robots.txt. Best-effort, non-blocking.
**Interface:**
```
discoverSitemapUrls(baseUrl: string): Promise<string[]>
```

### `src/crawler/safety.ts` - Interaction Safety
**Responsibility:** Blacklist dangerous actions (logout, delete, purchase) and non-HTML URLs. Validate selectors before clicking.
**Interface:**
```
isBlacklistedAction(description: string): boolean
isBlacklistedUrl(url: string): boolean
```

---

## 3. Data Types (TypeScript Interfaces)

```typescript
// ============================================================
// src/types/config.ts
// ============================================================

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

// ============================================================
// src/types/issue.ts
// ============================================================

export type ImpactLevel = "critical" | "serious" | "moderate" | "minor";

export type CheckSource = "axe" | "llm";

export interface Issue {
  /** Unique ID: `axe-{ruleId}-{hash}` */
  id: string;
  /** Page URL where found */
  url: string;
  /** axe-core rule ID (e.g., "color-contrast", "image-alt") */
  rule: string;
  /** Violation severity */
  impact: ImpactLevel;
  /** Human-readable description of the violation */
  description: string;
  /** Short help text from axe */
  help: string;
  /** Link to Deque documentation */
  helpUrl: string;
  /** WCAG success criteria tags (e.g., ["wcag2a", "wcag412"]) */
  wcagTags: string[];
  /** CSS selector targeting the violating element */
  selector: string;
  /** Raw HTML of the violating element */
  html: string;
  /** HTML context around the violation (parent + siblings) */
  surroundingHtml: string;
  /** XPath to the element */
  xpath: string;
  /** Viewport width when detected */
  viewportWidth: number;
  /** Page title at time of detection */
  pageTitle: string;
  /** Detection source */
  checkSource: CheckSource;
  /** LLM-generated fix suggestion (null if not enriched) */
  suggestedFix: string | null;
  /** Disclaimer: always "unvalidated, requires human review" */
  fixConfidence: "unvalidated, requires human review" | null;
  /** Violation category for prompt routing */
  violationCategory: ViolationCategory;
}

export type ViolationCategory =
  | "structural"    // missing landmarks, heading order, list structure
  | "interactive"   // missing labels, keyboard traps, focus management
  | "visual"        // color contrast, text spacing, reflow
  | "media"         // image alt, video captions, audio descriptions
  | "semantic";     // language, link purpose, page title

// ============================================================
// src/types/page.ts
// ============================================================

export type RepresentationTier = "aria-snapshot" | "pruned-html" | "css-heuristic";

export interface PageRepresentation {
  /** Which tier was used */
  tier: RepresentationTier;
  /** The textual representation sent to LLM */
  content: string;
  /** Estimated token count */
  tokenEstimate: number;
  /** Why this tier was selected */
  tierReason: string;
}

export interface NavTarget {
  /** CSS selector to click */
  selector: string;
  /** Human-readable description of what this element is */
  description: string;
  /** Expected behavior: "navigate" | "expand" | "reveal" */
  expectedBehavior: "navigate" | "expand" | "reveal";
  /** Confidence score 0-1 from LLM */
  confidence: number;
}

export interface PageResult {
  /** Page URL */
  url: string;
  /** Page title */
  title: string;
  /** All issues found on this page */
  issues: Issue[];
  /** Issues grouped by axe rule ID for batched remediation */
  groupedByRule: Record<string, Issue[]>;
  /** URLs discovered from this page */
  discoveredUrls: string[];
  /** How URLs were discovered */
  discoveryMethods: Record<string, "link" | "sitemap" | "interaction">;
  /** Representation tier used for LLM */
  representationTier: RepresentationTier;
  /** Timestamp of analysis */
  timestamp: string;
  /** Processing duration in ms */
  processingMs: number;
}

// ============================================================
// src/types/report.ts
// ============================================================

export interface SiteReport {
  /** Report metadata */
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

  /** Per-page results */
  pages: PageResult[];

  /** Site-wide summary */
  summary: {
    totalPages: number;
    totalIssues: number;
    issuesByImpact: Record<ImpactLevel, number>;
    issuesByRule: Record<string, number>;
    issuesByCategory: Record<ViolationCategory, number>;
    pagesWithZeroIssues: number;
    averageIssuesPerPage: number;
  };

  /** Issues appearing on 3+ pages (likely template/component issues) */
  sharedIssues: SharedIssue[];

  /** Discovery statistics */
  discovery: {
    totalUrlsDiscovered: number;
    urlsFromSitemap: number;
    urlsFromLinks: number;
    urlsFromInteraction: number;
    urlsAnalyzed: number;
    urlsSkipped: number;
  };

  /** LLM usage statistics */
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

  /** Errors encountered during crawl */
  errors: CrawlError[];
}

export interface SharedIssue {
  /** axe rule ID */
  rule: string;
  /** CSS selector pattern (may be generalized) */
  selectorPattern: string;
  /** HTML snippet */
  html: string;
  /** Pages where this appears */
  affectedPages: string[];
  /** Count of affected pages */
  pageCount: number;
  /** Suggested fix (from any page's enrichment) */
  suggestedFix: string | null;
}

export interface CrawlError {
  url: string;
  phase: "navigation" | "axe" | "representation" | "llm-nav" | "llm-enrich" | "interaction";
  message: string;
  timestamp: string;
}
```

---

## 4. Request Handler Flow

This is the core of the crawler. Each page visit executes these steps sequentially within a single `requestHandler` call.

```typescript
// Pseudocode for src/crawler/crawler.ts requestHandler

async function requestHandler({ page, request, enqueueLinks, log }) {
  const startTime = Date.now();
  const url = request.loadedUrl || request.url;

  // -------------------------------------------------------
  // STEP 1: Navigate (networkidle for full render)
  // -------------------------------------------------------
  // Use networkidle to ensure SPAs finish loading.
  // Critical: axe-core results are unreliable on partially-loaded pages.
  await page.goto(url, {
    waitUntil: "networkidle",
    timeout: config.pageTimeout,
  });

  // -------------------------------------------------------
  // STEP 2: Run axe-core FIRST (before any interactions)
  // -------------------------------------------------------
  // Rationale: interactions may change DOM state. We want the
  // "as-loaded" accessibility snapshot for accurate auditing.
  const axeIssues = await runAxe(page, {
    wcagLevel: config.wcagLevel,
  });

  // -------------------------------------------------------
  // STEP 3: Build page representation for LLM
  // -------------------------------------------------------
  // Tiered strategy (see Section 6 for decision tree).
  const repr = await buildRepresentation(page);

  // -------------------------------------------------------
  // STEP 4: LLM navigation discovery
  // -------------------------------------------------------
  // Send representation to Moonshot, get back selectors to click.
  const navTargets = await discoverNavTargets(repr, llmClient);

  // -------------------------------------------------------
  // STEP 5: Standard link extraction (no LLM needed)
  // -------------------------------------------------------
  await enqueueLinks({
    strategy: "same-origin",
    transformRequestFunction: (req) => {
      if (isBlacklistedUrl(req.url)) return false;
      return req;
    },
  });

  // -------------------------------------------------------
  // STEP 6: Interact with nav targets and enqueue new URLs
  // -------------------------------------------------------
  for (const target of navTargets) {
    if (isBlacklistedAction(target.description)) continue;

    try {
      const urlBefore = page.url();
      await page.locator(target.selector).click({ timeout: 3000 });
      await page.waitForTimeout(1500);  // Let DOM settle
      const urlAfter = page.url();

      if (urlAfter !== urlBefore) {
        // Navigation occurred - enqueue new URL
        enqueueNewUrl(urlAfter);
        await page.goBack({ waitUntil: "networkidle" });
      } else {
        // Menu/dropdown expanded - extract newly visible links
        // DELTA ONLY: re-run enqueueLinks to catch new <a> elements
        await enqueueLinks({ strategy: "same-origin" });
      }
    } catch {
      // Interaction failed, continue to next target
    }
  }

  // -------------------------------------------------------
  // STEP 7: LLM-enrich critical/serious issues (cost-gated)
  // -------------------------------------------------------
  const enrichedIssues = await enrichIssues(
    axeIssues.filter(i =>
      config.enrichImpactThreshold.includes(i.impact)
    ),
    { url, title: await page.title(), repr },
    llmClient,
  );

  // Merge enriched fixes back into full issue list
  const finalIssues = mergeEnrichedIssues(axeIssues, enrichedIssues);

  // -------------------------------------------------------
  // STEP 8: Build and return PageResult
  // -------------------------------------------------------
  return buildPageResult(url, finalIssues, repr, Date.now() - startTime);
}
```

### Timing Estimates per Page

| Step | Duration | Notes |
|------|----------|-------|
| 1. Navigate (networkidle) | 2-5s | Depends on site speed |
| 2. axe-core | 0.5-2s | Deterministic, no network |
| 3. Page representation | 0.1-0.5s | Local DOM queries |
| 4. LLM nav discovery | 1-3s | 1 Moonshot API call |
| 5. Standard link extraction | <0.1s | DOM query only |
| 6. Interactions | 1-5s | 0-3 clicks, 1.5s wait each |
| 7. LLM enrichment | 1-4s | 0-2 Moonshot calls (batched by rule) |
| **Total** | **5-15s** | **Avg ~8s per page** |

---

## 5. LLM Integration

### 5.1 LLM Client Configuration

```typescript
// src/llm/client.ts

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: config.apiKey,
  baseURL: config.apiBaseUrl,  // "https://api.moonshot.cn/v1"
});

// Exponential backoff: 1s, 2s, 4s, 8s, 16s (max 5 retries)
// Rate limit: config.rateLimitRpm requests per minute (token bucket)
```

### 5.2 Navigation Discovery Prompt

**When called:** Once per page, after building page representation.
**Input:** Page representation (ARIA snapshot or pruned HTML).
**Output:** JSON array of NavTarget objects.

```
SYSTEM:
You are a web navigation analyzer. Given a page representation, identify
interactive elements that reveal additional navigation (menus, dropdowns,
accordions, tab panels) or link to other sections of the same website.

Return ONLY a JSON array. Each object must have:
- "selector": a CSS selector that uniquely identifies the element
- "description": what the element is (e.g., "Services dropdown menu")
- "expectedBehavior": one of "navigate", "expand", "reveal"
- "confidence": 0.0 to 1.0

Rules:
- Do NOT include: search inputs, login/logout, cookie banners, external links
- Focus on primary and secondary navigation patterns
- Include hamburger/mobile menu toggles
- Maximum 10 targets per page

USER:
Page URL: {url}
Page title: {title}
Representation ({tier}):

{content}
```

### 5.3 Issue Enrichment Prompt (3-Tier Strategy)

**When called:** Once per violation category batch (structural, interactive, visual), only for critical/serious issues.
**Input:** Grouped violations + surrounding HTML context.
**Output:** Fix suggestions per violation.

The prompt is selected based on `violationCategory`:

#### Structural Violations Prompt
```
SYSTEM:
You are a WCAG 2.2 accessibility remediation expert specializing in
document structure. For each violation below, provide a concrete HTML fix.

Rules:
- Provide the EXACT corrected HTML (not descriptions of what to change)
- Preserve all existing attributes and content
- Only modify what is necessary to fix the violation
- If unsure, say "Manual review required: [reason]"

USER:
Page: {url}
Violations:

{for each issue in batch:}
### Violation: {issue.rule} ({issue.impact})
Description: {issue.description}
Current HTML:
```html
{issue.surroundingHtml}
```
Selector: {issue.selector}
{end for}

Respond with a JSON array:
[{ "issueId": "...", "suggestedFix": "corrected HTML or explanation" }]
```

#### Interactive Violations Prompt
```
SYSTEM:
You are a WCAG 2.2 accessibility remediation expert specializing in
interactive elements (forms, buttons, links, keyboard navigation).
[... same rules as structural ...]
```

#### Visual Violations Prompt
```
SYSTEM:
You are a WCAG 2.2 accessibility remediation expert specializing in
visual presentation (color contrast, text spacing, reflow, resize).
[... same rules as structural ...]
NOTE: Without a screenshot, base suggestions on the HTML/CSS provided.
If the fix requires visual verification, say "Requires visual review: [reason]".
```

### 5.4 Violation Category Mapping

```typescript
const CATEGORY_MAP: Record<string, ViolationCategory> = {
  // Structural
  "landmark-one-main": "structural",
  "region": "structural",
  "heading-order": "structural",
  "list": "structural",
  "listitem": "structural",
  "bypass": "structural",
  "document-title": "semantic",
  "html-has-lang": "semantic",
  "html-lang-valid": "semantic",
  "page-has-heading-one": "structural",

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
};

// Default: "structural" for unmapped rules
```

### 5.5 Cost Model

| Operation | Input tokens | Output tokens | Cost (Moonshot est.) |
|-----------|-------------|---------------|---------------------|
| Nav discovery (ARIA) | 200-600 | 200-400 | ~$0.001 |
| Nav discovery (pruned HTML) | 1000-3000 | 200-400 | ~$0.004 |
| Issue enrichment (batch of 5) | 500-2000 | 300-800 | ~$0.003 |
| **Per page (avg)** | | | **~$0.005-0.01** |
| **100-page site** | | | **~$0.50-1.00** |

---

## 6. Tiered Representation Strategy

### Decision Tree

```
buildRepresentation(page):
  |
  |-- Step 1: Try ARIA Snapshot
  |     ariaYaml = page.locator('body').ariaSnapshot()
  |     navNodes = count lines matching /navigation|menu|link|button/i
  |
  |     IF navNodes >= 3:
  |       RETURN { tier: "aria-snapshot", content: ariaYaml }
  |       Reason: "ARIA snapshot contains sufficient navigation structure"
  |
  |-- Step 2: Try Pruned HTML
  |     Extract subtrees from these selectors (in order):
  |       - nav
  |       - [role="navigation"]
  |       - [role="menubar"]
  |       - [role="banner"]
  |       - header
  |       - .nav, .navbar, .navigation, .menu, .main-nav
  |       - #nav, #navbar, #navigation, #menu, #main-nav
  |       - footer (secondary nav)
  |
  |     Strip from each subtree:
  |       - <script>, <style>, <svg>, <!-- comments -->
  |       - data-* attributes (except data-testid)
  |       - class attributes (keep only nav-related classes)
  |       - inline styles
  |
  |     IF combined subtree HTML > 100 chars:
  |       RETURN { tier: "pruned-html", content: prunedHtml }
  |       Reason: "ARIA snapshot insufficient, using pruned HTML from N landmarks"
  |
  |-- Step 3: CSS/ID Heuristic Fallback
  |     Broader extraction:
  |       - All <a> elements with href (deduplicated)
  |       - All <button> elements
  |       - All [role="menuitem"], [role="tab"] elements
  |     Format as simplified list:
  |       "- link: 'Home' -> /home [a.nav-link]"
  |       "- button: 'Services' [button#services-toggle]"
  |
  |     RETURN { tier: "css-heuristic", content: elementList }
  |     Reason: "No landmarks found, using element enumeration"
```

### Token Budget Targets

| Tier | Target tokens | Max tokens | Typical accuracy |
|------|--------------|------------|-----------------|
| ARIA snapshot | 100-500 | 800 | High (if site is accessible) |
| Pruned HTML | 500-3000 | 5000 | Medium-high |
| CSS heuristic | 200-1500 | 3000 | Medium (best-effort) |

### The Circular Problem Mitigation

Sites with bad accessibility produce bad ARIA trees. This is exactly our target audience. The fallback chain handles this:

1. **Good a11y site** -> ARIA snapshot works -> fast, cheap analysis
2. **Moderate a11y site** -> ARIA snapshot sparse -> pruned HTML catches nav landmarks by tag
3. **Poor a11y site** -> no landmarks at all -> CSS/ID heuristic + raw link/button enumeration

The heuristic tier (step 3) is specifically designed for the worst case: sites that use `<div class="nav">` instead of `<nav>`, or `<span onclick="...">` instead of `<button>`.

---

## 7. Report Structure (JSON Schema)

The output file is a single JSON object conforming to `SiteReport` (defined in Section 3). Key structural decisions:

```jsonc
{
  "meta": {
    "version": "2.0.0",
    "generatedAt": "2026-03-07T14:30:00.000Z",
    "baseUrl": "https://example.com",
    "wcagLevel": "AA",
    "totalDurationSeconds": 245,
    "toolVersions": {
      "crawler": "2.0.0",
      "axeCore": "4.10.x",
      "playwright": "1.50.x"
    }
  },

  "pages": [
    {
      "url": "https://example.com/",
      "title": "Example - Home",
      "issues": [
        {
          "id": "axe-color-contrast-a1b2c3",
          "url": "https://example.com/",
          "rule": "color-contrast",
          "impact": "serious",
          "description": "Elements must meet minimum color contrast ratio thresholds",
          "help": "Elements must have sufficient color contrast",
          "helpUrl": "https://dequeuniversity.com/rules/axe/4.10/color-contrast",
          "wcagTags": ["wcag2aa", "wcag143"],
          "selector": ".hero-text > p",
          "html": "<p style=\"color: #999\">Welcome</p>",
          "surroundingHtml": "<div class=\"hero-text\"><h1>Hello</h1><p style=\"color: #999\">Welcome</p></div>",
          "xpath": "/html/body/div[2]/div/p",
          "viewportWidth": 1280,
          "pageTitle": "Example - Home",
          "checkSource": "axe",
          "suggestedFix": "<p style=\"color: #595959\">Welcome</p>",
          "fixConfidence": "unvalidated, requires human review",
          "violationCategory": "visual"
        }
      ],
      "groupedByRule": {
        "color-contrast": [ /* ...issues... */ ],
        "image-alt": [ /* ...issues... */ ]
      },
      "discoveredUrls": [
        "https://example.com/about",
        "https://example.com/services"
      ],
      "discoveryMethods": {
        "https://example.com/about": "link",
        "https://example.com/services": "interaction"
      },
      "representationTier": "aria-snapshot",
      "timestamp": "2026-03-07T14:30:05.000Z",
      "processingMs": 8200
    }
  ],

  "summary": {
    "totalPages": 25,
    "totalIssues": 142,
    "issuesByImpact": { "critical": 3, "serious": 28, "moderate": 89, "minor": 22 },
    "issuesByRule": { "color-contrast": 45, "image-alt": 23, "link-name": 18 },
    "issuesByCategory": { "visual": 50, "media": 30, "interactive": 35, "structural": 20, "semantic": 7 },
    "pagesWithZeroIssues": 2,
    "averageIssuesPerPage": 5.68
  },

  "sharedIssues": [
    {
      "rule": "image-alt",
      "selectorPattern": "header img.logo",
      "html": "<img src=\"/logo.png\" class=\"logo\">",
      "affectedPages": [
        "https://example.com/",
        "https://example.com/about",
        "https://example.com/services"
      ],
      "pageCount": 25,
      "suggestedFix": "<img src=\"/logo.png\" class=\"logo\" alt=\"Example Company Logo\">"
    }
  ],

  "discovery": {
    "totalUrlsDiscovered": 30,
    "urlsFromSitemap": 8,
    "urlsFromLinks": 15,
    "urlsFromInteraction": 7,
    "urlsAnalyzed": 25,
    "urlsSkipped": 5
  },

  "llmUsage": {
    "totalCalls": 35,
    "totalInputTokens": 28000,
    "totalOutputTokens": 9500,
    "estimatedCostUsd": 0.42,
    "callsByPurpose": { "navigation": 25, "enrichment": 10 }
  },

  "errors": []
}
```

### Shared Issue Detection Algorithm

After all pages are processed:

```
1. Group all issues by (rule + normalized HTML)
2. For each group with pageCount >= 3:
   - Add to sharedIssues[]
   - Generalize selector (find common ancestor pattern)
   - Attach suggestedFix from any enriched instance
3. Sort by pageCount descending (highest-impact template issues first)
```

This enables "fix once, fix everywhere" prioritization.

---

## 8. v1 Scope vs v2 Scope

### v1 Scope (This Architecture)

| Feature | Status | Notes |
|---------|--------|-------|
| PlaywrightCrawler with Crawlee | IN | Stable, Bun-compatible |
| Sitemap.xml discovery | IN | Best-effort, non-blocking |
| Standard `<a href>` extraction | IN | Via `enqueueLinks()` |
| LLM-powered nav discovery | IN | Moonshot via OpenAI SDK |
| Tiered page representation | IN | ARIA snapshot -> pruned HTML -> CSS heuristic |
| axe-core violation detection | IN | WCAG A/AA/AAA configurable |
| LLM fix suggestions | IN | Critical/serious only, cost-gated |
| Extended Issue type | IN | surroundingHtml, xpath, viewportWidth, pageTitle |
| groupedByRule on PageResult | IN | For batched remediation |
| Shared issue detection (3+ pages) | IN | Post-crawl aggregation |
| Violation category routing | IN | 3 prompt tiers: structural, interactive, visual |
| Exponential backoff for Moonshot | IN | 5 retries, token bucket rate limit |
| `waitUntil: "networkidle"` | IN | For accurate SPA analysis |
| Interaction safety blacklist | IN | Logout, delete, purchase, cookies |
| JSON report output | IN | Full SiteReport schema |
| CLI interface | IN | `bun run cli --url <url>` |
| `fixConfidence` disclaimer | IN | Always "unvalidated, requires human review" |

### v2 Scope (Future)

| Feature | Priority | Notes |
|---------|----------|-------|
| HTML visual report | HIGH | Dashboard with charts, filtering, search |
| Vision/screenshot fallback | HIGH | When Moonshot or alternative supports multimodal |
| Legacy HTML difficulty scoring | MEDIUM | Predict remediation effort (tables, inline styles) |
| Automated fix application | MEDIUM | Apply suggestedFix to source code (Malaga approach) |
| Delta-only re-analysis | MEDIUM | After clicking, only send newly appeared elements to LLM |
| Keyboard navigation testing | MEDIUM | Tab order, focus traps, skip links |
| Multi-viewport analysis | MEDIUM | Mobile (375px), tablet (768px), desktop (1280px) |
| CI/CD integration | MEDIUM | GitHub Actions, exit codes, threshold enforcement |
| Framework-aware fixes | LOW | Angular/React/Vue component-level remediation |
| Historical comparison | LOW | Diff reports over time, regression detection |
| Concurrent site auditing | LOW | Audit multiple sites in parallel |

### Explicit Non-Goals for v1

- **No Stagehand.** We use direct Playwright + LLM calls instead of `page.observe()`/`page.act()`.
- **No screenshots sent to LLM.** Moonshot does not support vision. Visual violations get text-only fix suggestions with a "requires visual review" caveat.
- **No fix application.** We suggest fixes but do not modify source code.
- **No browser extension.** CLI-only interface.
- **No real-time analysis.** Batch processing, not live monitoring.

---

## Appendix A: File Structure

```
src/
  cli/
    index.ts              # CLI entry point, arg parsing
  crawler/
    crawler.ts            # PlaywrightCrawler setup + requestHandler
    sitemap.ts            # Sitemap.xml fetch + parse
    safety.ts             # URL and action blacklists
    __tests__/
      safety.test.ts
      sitemap.test.ts
  repr/
    tier.ts               # Tiered representation builder
    aria.ts               # ARIA snapshot extraction + quality check
    pruned-html.ts        # HTML pruning (nav subtrees only)
    heuristic.ts          # CSS/ID class-based fallback
    __tests__/
      tier.test.ts
  discovery/
    nav.ts                # LLM navigation discovery
    __tests__/
      nav.test.ts
  analyzer/
    axe.ts                # axe-core wrapper
    category.ts           # Violation category mapping
    __tests__/
      axe.test.ts
  enrichment/
    llm.ts                # LLM fix suggestion enrichment
    prompts.ts            # Prompt templates (structural, interactive, visual)
    __tests__/
      llm.test.ts
  llm/
    client.ts             # Moonshot client (OpenAI SDK + backoff + rate limit)
    __tests__/
      client.test.ts
  reporter/
    json.ts               # JSON report serialization
    shared.ts             # Shared issue detection algorithm
    __tests__/
      json.test.ts
      shared.test.ts
  orchestrator.ts         # Crawl lifecycle, aggregation
  types/
    config.ts             # CrawlConfig
    issue.ts              # Issue, ImpactLevel, ViolationCategory
    page.ts               # PageRepresentation, NavTarget, PageResult
    report.ts             # SiteReport, SharedIssue, CrawlError
  __tests__/
    e2e.test.ts           # End-to-end test
package.json
tsconfig.json
```

## Appendix B: Dependency List

```json
{
  "dependencies": {
    "crawlee": "^3.x",
    "@axe-core/playwright": "^4.10.x",
    "playwright": "^1.50.x",
    "openai": "^4.x",
    "zod": "^3.x"
  },
  "devDependencies": {
    "@types/node": "^22.x",
    "typescript": "^5.x",
    "bun-types": "latest"
  }
}
```

No `@crawlee/stagehand`, no `@browserbasehq/stagehand`.

## Appendix C: Rate Limiting Strategy

```
Token Bucket Algorithm:
  - Capacity: config.rateLimitRpm (default 10)
  - Refill: 1 token per (60 / rateLimitRpm) seconds
  - On empty bucket: wait until next token available

Exponential Backoff (on 429 or 5xx):
  - Attempt 1: wait 1s
  - Attempt 2: wait 2s
  - Attempt 3: wait 4s
  - Attempt 4: wait 8s
  - Attempt 5: wait 16s
  - After 5 failures: log error, skip LLM call, return null suggestedFix

Circuit Breaker:
  - If 3 consecutive LLM calls fail: disable LLM enrichment for rest of crawl
  - Navigation discovery continues (more critical than enrichment)
  - Log warning: "LLM enrichment disabled due to repeated failures"
```
