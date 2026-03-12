# v4.0 Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the sequential per-page audit pipeline with a three-phase SCAN→CLASSIFY→PROBE architecture that is 3× faster, eliminates 330 false positives, and adds 5 new WCAG 2.2 tests.

**Architecture:** The worker's `runAudit()` is completely rewritten. SCAN visits all pages concurrently (3 slots) with lightweight analysis. CLASSIFY groups pages into templates via SimHash + URL patterns. PROBE runs deep analysis only on template representatives, then amplifies template-level issues to all pages in each cluster.

**Tech Stack:** Playwright (existing), @axe-core/playwright (existing), postgres (existing), crypto.randomUUID() (built-in). No new dependencies. Remove linkedom, jsdom, direct axe-core.

**Design doc:** `docs/plans/2026-03-12-crawler-v4-design.md`

---

## Task 1: DB Migration — audit_spans table + new columns

**Files:**
- Create: `src/server/db/migrations/001-v4-pipeline.sql`
- Modify: `src/server/db/schema.sql` (append new table + columns)

**Step 1: Write the migration SQL**

```sql
-- src/server/db/migrations/001-v4-pipeline.sql

-- New table: structured observability spans
CREATE TABLE IF NOT EXISTS audit_spans (
  id             BIGSERIAL PRIMARY KEY,
  audit_id       UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  trace_id       UUID NOT NULL,
  span_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  parent_span_id UUID,
  name           TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ,
  duration_ms    INTEGER GENERATED ALWAYS AS (
                   EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000
                 ) STORED,
  status         TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','timeout')),
  error_message  TEXT,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spans_audit ON audit_spans(audit_id);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON audit_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_name ON audit_spans(name);
CREATE INDEX IF NOT EXISTS idx_spans_metadata ON audit_spans USING GIN(metadata);

-- New columns on issues for template amplification
ALTER TABLE issues ADD COLUMN IF NOT EXISTS template_id TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS affected_pages INTEGER DEFAULT 1;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS amplified_from TEXT;

-- New JSONB fields on audits for template/coverage metadata
ALTER TABLE audits ADD COLUMN IF NOT EXISTS template_clusters JSONB;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS coverage JSONB;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS regression JSONB;

-- New columns on pages for template tracking
ALTER TABLE pages ADD COLUMN IF NOT EXISTS template_id TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS is_representative BOOLEAN DEFAULT false;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS element_count INTEGER;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS capabilities JSONB;
```

**Step 2: Update schema.sql to include the new structures**

Append the `audit_spans` CREATE TABLE and new columns to `src/server/db/schema.sql` so fresh installs get the complete schema.

**Step 3: Run migration against local/dev database**

Run: `bun run src/server/db/migrations/001-v4-pipeline.sql` via psql or the postgres client.

Verify: Query `\d audit_spans`, `\d issues`, `\d audits`, `\d pages` to confirm new columns/table exist.

**Step 4: Commit**

```bash
git add src/server/db/migrations/001-v4-pipeline.sql src/server/db/schema.sql
git commit -m "feat(db): add v4 pipeline schema — audit_spans, template columns, coverage fields"
```

---

## Task 2: New Types — v4 pipeline interfaces

**Files:**
- Create: `src/types/pipeline.ts`
- Modify: `src/types/issue.ts` (add new CheckSource values)

**Step 1: Write the failing test**

```typescript
// src/types/__tests__/pipeline.test.ts
import { describe, test, expect } from "bun:test";
import type {
  ScanResult,
  TemplateCluster,
  TestType,
  SpanRecord,
  CrawlError,
  PageCapabilities,
} from "../pipeline";

describe("pipeline types", () => {
  test("ScanResult has required fields", () => {
    const result: ScanResult = {
      url: "https://example.com",
      fingerprint: "abc",
      title: "Example",
      links: ["https://example.com/about"],
      elementCount: 42,
      capabilities: {
        hasForms: false,
        hasMedia: false,
        hasCarousel: false,
        hasDataTables: false,
        isSpaShell: false,
      },
      lightIssues: [],
      pageId: "uuid-123",
      discoveryMethod: "standard",
    };
    expect(result.url).toBe("https://example.com");
  });

  test("TemplateCluster has required fields", () => {
    const cluster: TemplateCluster = {
      id: "hash-pattern",
      fingerprint: 123n,
      urlPattern: "/blog/:slug",
      urls: ["https://example.com/blog/one"],
      representative: "https://example.com/blog/one",
      capabilities: {
        hasForms: false,
        hasMedia: false,
        hasCarousel: false,
        hasDataTables: false,
        isSpaShell: false,
      },
      lightIssues: [],
      testPlan: ["axe-full", "interactive", "reflow"],
    };
    expect(cluster.urlPattern).toBe("/blog/:slug");
  });

  test("TestType union covers v4.0 tests", () => {
    const tests: TestType[] = [
      "axe-full", "interactive", "reflow", "text-spacing",
      "resize-text", "multimedia", "timed-events",
    ];
    expect(tests).toHaveLength(7);
  });

  test("SpanRecord has all required fields", () => {
    const span: SpanRecord = {
      auditId: "uuid",
      traceId: "uuid",
      spanId: "uuid",
      parentSpanId: null,
      name: "scan:page",
      startedAt: new Date(),
      endedAt: new Date(),
      status: "ok",
      errorMessage: null,
      metadata: { url: "https://example.com" },
    };
    expect(span.name).toBe("scan:page");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/types/__tests__/pipeline.test.ts`
Expected: FAIL — module `../pipeline` not found.

**Step 3: Write the types**

```typescript
// src/types/pipeline.ts
import type { Issue } from "./issue";

export interface PageCapabilities {
  hasForms: boolean;
  hasMedia: boolean;
  hasCarousel: boolean;
  hasDataTables: boolean;
  isSpaShell: boolean;
}

export interface ScanResult {
  url: string;
  fingerprint: string; // structural skeleton from nodeSignature()
  title: string;
  links: string[];
  elementCount: number;
  capabilities: PageCapabilities;
  lightIssues: Issue[];
  pageId: string; // from DB insert
  discoveryMethod: "standard" | "networkidle-retry" | "llm";
}

export type TestType =
  | "axe-full"
  | "interactive"
  | "reflow"
  | "text-spacing"
  | "resize-text"
  | "multimedia"
  | "timed-events";
  // v4.1: | "target-size" | "error-identification"
  // v4.2: | "non-text-contrast"

export interface TemplateCluster {
  id: string; // SimHash hex + URL pattern
  fingerprint: bigint;
  urlPattern: string;
  urls: string[];
  representative: string;
  capabilities: PageCapabilities;
  lightIssues: Issue[];
  testPlan: TestType[];
}

export type SpanStatus = "ok" | "error" | "timeout";

export interface SpanRecord {
  auditId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedAt: Date;
  endedAt: Date | null;
  status: SpanStatus;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
}

export interface CrawlError {
  url: string;
  error: string;
  timestamp: Date;
}

export interface PipelineConfig {
  baseUrl: string;
  maxPages: number;
  maxDepth: number;
  wcagLevel: "A" | "AA" | "AAA";
  pageTimeout: number;
  concurrency: number;
  pagesPerContext: number;
  probePagesPerContext: number;
  maxProbeTemplates: number;
  navModel: string;
  rateLimitRpm: number;
}

export const DEFAULT_PIPELINE_CONFIG: Omit<PipelineConfig, "baseUrl"> = {
  maxPages: 50,
  maxDepth: 5,
  wcagLevel: "AA",
  pageTimeout: 15_000,
  concurrency: 3,
  pagesPerContext: 25,
  probePagesPerContext: 5,
  maxProbeTemplates: 25,
  navModel: "kimi-k2-turbo-preview",
  rateLimitRpm: 10,
};
```

**Step 4: Update src/types/issue.ts — add new CheckSource values**

Add `"scan-light"` and `"wcag-custom"` to `CheckSource` type:

```typescript
export type CheckSource = "axe" | "llm" | "interactive" | "scan-light" | "wcag-custom";
```

**Step 5: Run tests**

Run: `bun test src/types/__tests__/pipeline.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/types/pipeline.ts src/types/__tests__/pipeline.test.ts src/types/issue.ts
git commit -m "feat(types): add v4 pipeline types — ScanResult, TemplateCluster, SpanRecord, PipelineConfig"
```

---

## Task 3: Cookie Consent Blocking

**Files:**
- Create: `src/analyzer/consent-blocker.ts`
- Create: `src/analyzer/__tests__/consent-blocker.test.ts`

**Step 1: Write the failing test**

```typescript
// src/analyzer/__tests__/consent-blocker.test.ts
import { describe, test, expect } from "bun:test";
import {
  CONSENT_SCRIPT_PATTERNS,
  CONSENT_PREHIDE_CSS,
  installConsentBlocker,
  injectConsentPrehideCSS,
} from "../consent-blocker";

describe("consent-blocker", () => {
  test("CONSENT_SCRIPT_PATTERNS covers major CMPs", () => {
    const patterns = CONSENT_SCRIPT_PATTERNS;
    expect(patterns.length).toBeGreaterThanOrEqual(15);

    // Verify key CMPs are covered
    const joined = patterns.join(" ");
    expect(joined).toContain("cookiebot");
    expect(joined).toContain("cookielaw");   // OneTrust
    expect(joined).toContain("cookieyes");
    expect(joined).toContain("trustarc");
    expect(joined).toContain("quantcast");
    expect(joined).toContain("usercentrics");
    expect(joined).toContain("didomi");       // sdk.privacy-center.org
    expect(joined).toContain("termly");
    expect(joined).toContain("iubenda");
    expect(joined).toContain("consentmanager");
  });

  test("CONSENT_PREHIDE_CSS covers known banner IDs", () => {
    expect(CONSENT_PREHIDE_CSS).toContain("#CybotCookiebotDialog");
    expect(CONSENT_PREHIDE_CSS).toContain("#onetrust-banner-sdk");
    expect(CONSENT_PREHIDE_CSS).toContain("display: none !important");
    expect(CONSENT_PREHIDE_CSS).toContain("pointer-events: none");
  });

  test("installConsentBlocker is an async function", () => {
    expect(typeof installConsentBlocker).toBe("function");
  });

  test("injectConsentPrehideCSS is an async function", () => {
    expect(typeof injectConsentPrehideCSS).toBe("function");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/analyzer/__tests__/consent-blocker.test.ts`
Expected: FAIL — module not found.

**Step 3: Write implementation**

```typescript
// src/analyzer/consent-blocker.ts
import type { BrowserContext, Page } from "playwright";

/**
 * Layer 1: Network abort — block CMP scripts before they execute.
 * No script = no DOM overlay = no false positives.
 */
export const CONSENT_SCRIPT_PATTERNS = [
  // Cookiebot / Usercentrics (Cookiebot brand)
  "**/consent.cookiebot.com/**",
  "**/consentcdn.cookiebot.com/**",
  "**/consent.cookiebot.eu/**",
  // OneTrust / CookiePro / Optanon
  "**/cdn.cookielaw.org/**",
  // CookieYes
  "**/cdn-cookieyes.com/**",
  "**/*.cookieyes.com/**",
  // TrustArc
  "**/consent.trustarc.com/**",
  // Quantcast Choice
  "**/quantcast.mgr.consensu.org/**",
  "**/cmp.quantcast.com/**",
  // Usercentrics
  "**/app.usercentrics.eu/**",
  "**/web.eu1.cmp.usercentrics.eu/**",
  // Didomi
  "**/sdk.privacy-center.org/**",
  // Termly
  "**/app.termly.io/consent-sync*",
  "**/app.termly.io/resource-blocker/**",
  // iubenda
  "**/cdn.iubenda.com/cs/**",
  // ConsentManager.net
  "**/cdn.consentmanager.net/**",
  // Evidon / Sourcepoint / Admiral
  "**/c.evidon.com/**",
  "**/cdn.privacy-mgmt.com/**",
  "**/cdn.admiral.digital/**",
];

export async function installConsentBlocker(context: BrowserContext): Promise<void> {
  for (const pattern of CONSENT_SCRIPT_PATTERNS) {
    await context.route(pattern, (route) => route.abort());
  }
}

/**
 * Layer 2: CSS prehide — hide CMP HTML shells that render without their JS.
 * `display: none` removes elements from the accessibility tree.
 */
export const CONSENT_PREHIDE_CSS = `
  #CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay,
  #onetrust-banner-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter,
  .trustarc-banner-container, .truste_popframe, .truste_overlay,
  #cmpbox, #cmpbox2, #cmpwrapper, .klaro,
  [id*="cookie-banner"], [id*="cookie-consent"], [id*="cookieConsent"],
  [class*="cookie-banner"], [class*="cookie-consent"], [class*="cookieConsent"],
  [id*="gdpr-banner"], [class*="gdpr-banner"],
  [id*="consent-banner"], [class*="consent-banner"]
  { display: none !important; visibility: hidden !important; pointer-events: none !important; }
`;

export async function injectConsentPrehideCSS(page: Page): Promise<void> {
  await page.addStyleTag({ content: CONSENT_PREHIDE_CSS });
}
```

**Step 4: Run tests**

Run: `bun test src/analyzer/__tests__/consent-blocker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/analyzer/consent-blocker.ts src/analyzer/__tests__/consent-blocker.test.ts
git commit -m "feat(analyzer): add cookie consent blocking — network abort + CSS prehide"
```

---

## Task 4: Resource Blocking

**Files:**
- Create: `src/analyzer/resource-blocker.ts`
- Create: `src/analyzer/__tests__/resource-blocker.test.ts`

**Step 1: Write the failing test**

```typescript
// src/analyzer/__tests__/resource-blocker.test.ts
import { describe, test, expect } from "bun:test";
import { installResourceBlocker } from "../resource-blocker";

describe("resource-blocker", () => {
  test("installResourceBlocker is an async function", () => {
    expect(typeof installResourceBlocker).toBe("function");
  });

  // Integration tests with real browser would go in e2e suite
  // Unit test validates the function signature exists and is callable
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/analyzer/__tests__/resource-blocker.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/analyzer/resource-blocker.ts
import type { BrowserContext } from "playwright";

/**
 * Block heavy resources at context level.
 * SCAN: block images, media, fonts (only need DOM structure).
 * PROBE: block only fonts (need images for alt checks, CSS for contrast).
 */
export async function installResourceBlocker(
  context: BrowserContext,
  phase: "scan" | "probe",
): Promise<void> {
  const blocked =
    phase === "scan"
      ? ["image", "media", "font"]
      : ["font"];

  await context.route("**/*", (route) => {
    if (blocked.includes(route.request().resourceType())) {
      return route.abort();
    }
    return route.continue();
  });
}
```

**Step 4: Run tests**

Run: `bun test src/analyzer/__tests__/resource-blocker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/analyzer/resource-blocker.ts src/analyzer/__tests__/resource-blocker.test.ts
git commit -m "feat(analyzer): add resource blocker for SCAN/PROBE phases"
```

---

## Task 5: SimHash + Hamming Distance

**Files:**
- Create: `src/analyzer/fingerprint.ts`
- Create: `src/analyzer/__tests__/fingerprint.test.ts`

**Step 1: Write the failing test**

```typescript
// src/analyzer/__tests__/fingerprint.test.ts
import { describe, test, expect } from "bun:test";
import { simhash, hammingDistance, inferUrlPattern } from "../fingerprint";

describe("simhash", () => {
  test("returns a bigint", () => {
    const hash = simhash("hello world");
    expect(typeof hash).toBe("bigint");
  });

  test("same input returns same hash", () => {
    const a = simhash("div(n=3)[span(n=0)|p(n=1)|a(n=0)]");
    const b = simhash("div(n=3)[span(n=0)|p(n=1)|a(n=0)]");
    expect(a).toBe(b);
  });

  test("similar inputs have low hamming distance", () => {
    const a = simhash("div(n=3)[span(n=0)|p(n=1)|a(n=0)]");
    const b = simhash("div(n=3)[span(n=0)|p(n=1)|a(n=1)]"); // slight change
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(12);
  });

  test("very different inputs have high hamming distance", () => {
    const a = simhash("div(n=3)[span(n=0)|p(n=1)|a(n=0)]");
    const b = simhash("table(n=10)[tr(n=5)[td(n=2)|td(n=3)]|tr(n=4)]");
    expect(hammingDistance(a, b)).toBeGreaterThan(8);
  });
});

describe("hammingDistance", () => {
  test("identical bigints have distance 0", () => {
    expect(hammingDistance(0n, 0n)).toBe(0);
    expect(hammingDistance(255n, 255n)).toBe(0);
  });

  test("one bit difference = distance 1", () => {
    expect(hammingDistance(0b1000n, 0b0000n)).toBe(1);
  });

  test("all bits different in 8-bit = distance 8", () => {
    expect(hammingDistance(0b11111111n, 0b00000000n)).toBe(8);
  });
});

describe("inferUrlPattern", () => {
  test("root path returns /", () => {
    expect(inferUrlPattern("https://example.com")).toBe("/");
    expect(inferUrlPattern("https://example.com/")).toBe("/");
  });

  test("numeric last segment becomes :id", () => {
    expect(inferUrlPattern("https://example.com/products/123")).toBe("/products/:id");
  });

  test("uuid last segment becomes :uuid", () => {
    expect(inferUrlPattern("https://example.com/items/550e8400-e29b-41d4-a716-446655440000")).toBe("/items/:uuid");
  });

  test("slug last segment becomes :slug", () => {
    expect(inferUrlPattern("https://example.com/blog/how-to-use-axe")).toBe("/blog/:slug");
  });

  test("literal last segment stays literal", () => {
    expect(inferUrlPattern("https://example.com/about")).toBe("/about");
  });

  test("preserves parent segments as literals", () => {
    expect(inferUrlPattern("https://example.com/products/shoes/123")).toBe("/products/shoes/:id");
    expect(inferUrlPattern("https://example.com/products/hats/456")).toBe("/products/hats/:id");
  });

  test("different parents produce different patterns", () => {
    const blogPattern = inferUrlPattern("https://example.com/blog/how-to-use-axe");
    const docsPattern = inferUrlPattern("https://example.com/docs/getting-started");
    expect(blogPattern).toBe("/blog/:slug");
    expect(docsPattern).toBe("/docs/:slug");
    expect(blogPattern).not.toBe(docsPattern);
  });

  test("short slug (fewer than 3 hyphens) stays literal", () => {
    expect(inferUrlPattern("https://example.com/about-us")).toBe("/about-us");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/analyzer/__tests__/fingerprint.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/analyzer/fingerprint.ts

/**
 * SimHash: locality-sensitive hash for DOM structural fingerprinting.
 * Two pages with Hamming distance ≤ 8 are considered structurally similar.
 */
export function simhash(text: string, bits = 64): bigint {
  const v = new Array(bits).fill(0);
  for (let i = 0; i < text.length - 2; i++) {
    const token = text.slice(i, i + 3);
    let h = 2166136261n; // FNV-1a offset basis
    for (let j = 0; j < token.length; j++) {
      h ^= BigInt(token.charCodeAt(j));
      h = BigInt.asUintN(32, h * 16777619n);
    }
    const hash = h ^ (h << 32n);
    for (let b = 0; b < bits; b++) {
      v[b] += (hash >> BigInt(b)) & 1n ? 1 : -1;
    }
  }
  let fingerprint = 0n;
  for (let b = 0; b < bits; b++) {
    if (v[b] > 0) fingerprint |= 1n << BigInt(b);
  }
  return fingerprint;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let dist = 0;
  while (xor > 0n) {
    dist += Number(xor & 1n);
    xor >>= 1n;
  }
  return dist;
}

/**
 * Normalize URL to a pattern for template grouping.
 * Only the LAST path segment is normalized — parents stay literal.
 * This prevents /blog/:slug and /docs/:slug from being grouped together.
 */
export function inferUrlPattern(url: string): string {
  const { pathname } = new URL(url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  const parentSegments = segments.slice(0, -1);
  const lastSegment = segments[segments.length - 1];

  let normalizedLast: string;
  if (/^\d+$/.test(lastSegment)) {
    normalizedLast = ":id";
  } else if (/^[0-9a-f-]{36}$/.test(lastSegment)) {
    normalizedLast = ":uuid";
  } else if (/^[a-z0-9]+(-[a-z0-9]+){2,}$/.test(lastSegment)) {
    normalizedLast = ":slug";
  } else {
    normalizedLast = lastSegment;
  }

  return "/" + [...parentSegments, normalizedLast].join("/");
}

/**
 * DOM structural skeleton — extracted via page.evaluate() inside the browser.
 * This string is what gets SimHash'd to produce the fingerprint.
 * Exported as a string so it can be injected into page.evaluate().
 */
export const NODE_SIGNATURE_FN = `
function nodeSignature(el, depth) {
  if (depth > 6) return "";
  var tag = el.tagName.toLowerCase();
  var leafTags = new Set(["p","span","a","img","strong","em","br","input","button","label","li"]);
  var role = el.getAttribute("role") || "";
  var childCount = el.children.length;
  var sig = tag + "(" + (role ? "r=" + role + "," : "") + "n=" + childCount + ")";
  if (leafTags.has(tag) || depth >= 6) return sig;
  var children = Array.from(el.children)
    .map(function(c) { return nodeSignature(c, depth + 1); })
    .filter(Boolean).join("|");
  return children ? sig + "[" + children + "]" : sig;
}
`;
```

**Step 4: Run tests**

Run: `bun test src/analyzer/__tests__/fingerprint.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/analyzer/fingerprint.ts src/analyzer/__tests__/fingerprint.test.ts
git commit -m "feat(analyzer): add SimHash fingerprinting + URL pattern inference"
```

---

## Task 6: AuditTracer — Observability spans

**Files:**
- Create: `src/worker/tracer.ts`
- Create: `src/worker/__tests__/tracer.test.ts`

**Step 1: Write the failing test**

```typescript
// src/worker/__tests__/tracer.test.ts
import { describe, test, expect, mock } from "bun:test";
import { Span, AuditTracer } from "../tracer";

describe("Span", () => {
  test("creates with required fields", () => {
    const span = new Span("audit-1", "trace-1", "scan:page", null);
    expect(span.auditId).toBe("audit-1");
    expect(span.traceId).toBe("trace-1");
    expect(span.name).toBe("scan:page");
    expect(span.spanId).toBeTruthy();
    expect(span.startedAt).toBeInstanceOf(Date);
  });

  test("end() sets endedAt and status", () => {
    const span = new Span("a", "t", "test");
    span.end("error", "something broke");
    const record = span.toRecord();
    expect(record.endedAt).toBeInstanceOf(Date);
    expect(record.status).toBe("error");
    expect(record.errorMessage).toBe("something broke");
  });

  test("setMeta() accumulates metadata", () => {
    const span = new Span("a", "t", "test");
    span.setMeta({ url: "https://example.com" });
    span.setMeta({ issues: 5 });
    const record = span.toRecord();
    expect(record.metadata).toEqual({ url: "https://example.com", issues: 5 });
  });
});

describe("AuditTracer", () => {
  test("trace() creates a span, runs fn, ends span on success", async () => {
    const tracer = new AuditTracer("audit-1", async () => {});
    const result = await tracer.trace("test:op", async (span) => {
      span.setMeta({ key: "value" });
      return 42;
    });
    expect(result).toBe(42);
  });

  test("trace() ends span with error on throw", async () => {
    const tracer = new AuditTracer("audit-1", async () => {});
    await expect(
      tracer.trace("test:op", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });

  test("flush() calls persistFn and clears spans", async () => {
    const persisted: unknown[][] = [];
    const tracer = new AuditTracer("audit-1", async (spans) => {
      persisted.push(spans);
    });
    await tracer.trace("op1", async () => {});
    await tracer.trace("op2", async () => {});
    await tracer.flush();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toHaveLength(2);

    // Second flush is a no-op (buffer cleared)
    await tracer.flush();
    expect(persisted).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker/__tests__/tracer.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/worker/tracer.ts
import { randomUUID } from "crypto";
import type { SpanRecord, SpanStatus } from "../types/pipeline";

export class Span {
  readonly spanId = randomUUID();
  readonly startedAt = new Date();
  private endedAt: Date | null = null;
  private status: SpanStatus = "ok";
  private errorMessage: string | null = null;
  private meta: Record<string, unknown> = {};

  constructor(
    readonly auditId: string,
    readonly traceId: string,
    readonly name: string,
    readonly parentSpanId: string | null = null,
  ) {}

  setMeta(data: Record<string, unknown>): this {
    Object.assign(this.meta, data);
    return this;
  }

  end(status: SpanStatus = "ok", error?: string): this {
    this.endedAt = new Date();
    this.status = status;
    this.errorMessage = error ?? null;
    return this;
  }

  toRecord(): SpanRecord {
    return {
      auditId: this.auditId,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      status: this.status,
      errorMessage: this.errorMessage,
      metadata: { ...this.meta },
    };
  }
}

type PersistFn = (spans: SpanRecord[]) => Promise<void>;

export class AuditTracer {
  readonly traceId = randomUUID();
  private spans: Span[] = [];

  constructor(
    readonly auditId: string,
    private readonly persistFn: PersistFn,
  ) {}

  async trace<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    parent?: string,
  ): Promise<T> {
    const span = new Span(this.auditId, this.traceId, name, parent ?? null);
    this.spans.push(span);
    try {
      const result = await fn(span);
      span.end("ok");
      return result;
    } catch (err) {
      span.end("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async flush(): Promise<void> {
    if (this.spans.length === 0) return;
    await this.persistFn(this.spans.map((s) => s.toRecord()));
    this.spans = [];
  }
}
```

**Step 4: Run tests**

Run: `bun test src/worker/__tests__/tracer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/worker/tracer.ts src/worker/__tests__/tracer.test.ts
git commit -m "feat(worker): add AuditTracer — structured spans with phase-boundary flushing"
```

---

## Task 7: SlotPool + ContextSlot

**Files:**
- Create: `src/worker/slot-pool.ts`
- Create: `src/worker/__tests__/slot-pool.test.ts`

**Step 1: Write the failing test**

```typescript
// src/worker/__tests__/slot-pool.test.ts
import { describe, test, expect } from "bun:test";
import { ContextSlot, SlotPool } from "../slot-pool";

describe("ContextSlot", () => {
  test("exports ContextSlot class", () => {
    expect(typeof ContextSlot).toBe("function");
  });
});

describe("SlotPool", () => {
  test("creates pool with specified size", () => {
    const pool = new SlotPool(3);
    expect(pool).toBeTruthy();
  });

  test("acquire returns slots up to pool size without blocking", async () => {
    const pool = new SlotPool(2);
    const slot1 = await pool.acquire();
    const slot2 = await pool.acquire();
    expect(slot1).toBeTruthy();
    expect(slot2).toBeTruthy();
    expect(slot1).not.toBe(slot2);
    // Release for cleanup
    pool.release(slot1);
    pool.release(slot2);
  });

  test("acquire blocks when pool exhausted, resumes on release", async () => {
    const pool = new SlotPool(1);
    const slot1 = await pool.acquire();

    let resolved = false;
    const promise = pool.acquire().then((s) => {
      resolved = true;
      return s;
    });

    // Should still be blocked
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Release unblocks
    pool.release(slot1);
    const slot2 = await promise;
    expect(resolved).toBe(true);
    expect(slot2).toBe(slot1); // same slot recycled
    pool.release(slot2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker/__tests__/slot-pool.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/worker/slot-pool.ts
import type { Browser, BrowserContext } from "playwright";
import { installConsentBlocker } from "../analyzer/consent-blocker";
import { installResourceBlocker } from "../analyzer/resource-blocker";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class ContextSlot {
  private context: BrowserContext | null = null;
  private pagesSinceRecycle = 0;

  constructor(private readonly pagesPerContext: number = 25) {}

  async get(
    getBrowser: () => Promise<Browser>,
    phase: "scan" | "probe",
  ): Promise<BrowserContext> {
    const browser = await getBrowser();

    if (!browser.isConnected()) {
      // Force reconnect — previous browser died
      this.context = null;
    }

    if (!this.context || this.pagesSinceRecycle >= this.pagesPerContext) {
      if (this.context) {
        try {
          await this.context.close();
        } catch {
          /* already disconnected */
        }
      }
      const freshBrowser = await getBrowser();
      this.context = await freshBrowser.newContext({
        userAgent: CHROME_UA,
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      await installConsentBlocker(this.context);
      await installResourceBlocker(this.context, phase);
      this.pagesSinceRecycle = 0;
    }
    this.pagesSinceRecycle++;
    return this.context;
  }

  async close(): Promise<void> {
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        /* already disconnected */
      }
    }
    this.context = null;
    this.pagesSinceRecycle = 0;
  }
}

export class SlotPool {
  private available: ContextSlot[];
  private waiting: Array<(slot: ContextSlot) => void> = [];

  constructor(size: number, pagesPerContext = 25) {
    this.available = Array.from(
      { length: size },
      () => new ContextSlot(pagesPerContext),
    );
  }

  async acquire(): Promise<ContextSlot> {
    const slot = this.available.pop();
    if (slot) return slot;
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(slot: ContextSlot): void {
    const next = this.waiting.shift();
    if (next) {
      next(slot);
    } else {
      this.available.push(slot);
    }
  }

  async closeAll(): Promise<void> {
    for (const slot of this.available) {
      await slot.close();
    }
  }
}
```

**Step 4: Run tests**

Run: `bun test src/worker/__tests__/slot-pool.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/worker/slot-pool.ts src/worker/__tests__/slot-pool.test.ts
git commit -m "feat(worker): add SlotPool + ContextSlot — concurrency control with session isolation"
```

---

## Task 8: ProbeContextManager

**Files:**
- Create: `src/worker/probe-context.ts`
- Create: `src/worker/__tests__/probe-context.test.ts`

**Step 1: Write the failing test**

```typescript
// src/worker/__tests__/probe-context.test.ts
import { describe, test, expect } from "bun:test";
import { ProbeContextManager } from "../probe-context";

describe("ProbeContextManager", () => {
  test("exports ProbeContextManager class", () => {
    expect(typeof ProbeContextManager).toBe("function");
  });

  test("close() is safe to call multiple times", async () => {
    // Create with a mock getBrowser that throws (we're just testing close safety)
    const mgr = new ProbeContextManager(async () => {
      throw new Error("no browser in test");
    });
    // close() on fresh manager should not throw
    await mgr.close();
    await mgr.close(); // idempotent
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker/__tests__/probe-context.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/worker/probe-context.ts
import type { Browser, BrowserContext } from "playwright";
import { installConsentBlocker } from "../analyzer/consent-blocker";
import { installResourceBlocker } from "../analyzer/resource-blocker";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Manages BrowserContext lifecycle for PROBE phase.
 * Recycles every N representatives to avoid memory leaks.
 * Scoped per audit — no global mutable state.
 */
export class ProbeContextManager {
  private context: BrowserContext | null = null;
  private pagesSinceRecycle = 0;

  constructor(
    private readonly getBrowser: () => Promise<Browser>,
    private readonly pagesPerContext: number = 5,
  ) {}

  async get(): Promise<BrowserContext> {
    if (!this.context || this.pagesSinceRecycle >= this.pagesPerContext) {
      await this.close();
      const browser = await this.getBrowser();
      this.context = await browser.newContext({
        userAgent: CHROME_UA,
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      await installConsentBlocker(this.context);
      await installResourceBlocker(this.context, "probe");
      this.pagesSinceRecycle = 0;
    }
    this.pagesSinceRecycle++;
    return this.context;
  }

  async close(): Promise<void> {
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        /* already disconnected */
      }
    }
    this.context = null;
    this.pagesSinceRecycle = 0;
  }
}
```

**Step 4: Run tests**

Run: `bun test src/worker/__tests__/probe-context.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/worker/probe-context.ts src/worker/__tests__/probe-context.test.ts
git commit -m "feat(worker): add ProbeContextManager — PROBE context lifecycle with recycling"
```

---

## Task 9: CLASSIFY — Template clustering engine

**Files:**
- Create: `src/analyzer/classify.ts`
- Create: `src/analyzer/__tests__/classify.test.ts`

**Step 1: Write the failing test**

```typescript
// src/analyzer/__tests__/classify.test.ts
import { describe, test, expect } from "bun:test";
import {
  clusterPages,
  buildTestPlan,
  selectRepresentative,
  prioritizeTemplates,
} from "../classify";
import type { ScanResult, TemplateCluster } from "../../types/pipeline";

const makeScanResult = (overrides: Partial<ScanResult> = {}): ScanResult => ({
  url: "https://example.com",
  fingerprint: "div(n=3)[span(n=0)|p(n=1)]",
  title: "Test",
  links: [],
  elementCount: 50,
  capabilities: {
    hasForms: false,
    hasMedia: false,
    hasCarousel: false,
    hasDataTables: false,
    isSpaShell: false,
  },
  lightIssues: [],
  pageId: "page-1",
  discoveryMethod: "standard",
  ...overrides,
});

describe("clusterPages", () => {
  test("groups pages with same fingerprint and URL pattern", () => {
    const results: ScanResult[] = [
      makeScanResult({ url: "https://example.com/blog/post-one-two-three", fingerprint: "div(n=3)[p(n=0)]" }),
      makeScanResult({ url: "https://example.com/blog/another-long-slug", fingerprint: "div(n=3)[p(n=0)]" }),
      makeScanResult({ url: "https://example.com/about", fingerprint: "main(n=5)[section(n=2)]" }),
    ];
    const clusters = clusterPages(results);
    expect(clusters.length).toBe(2); // blog cluster + about cluster
    const blogCluster = clusters.find((c) => c.urlPattern === "/blog/:slug");
    expect(blogCluster).toBeTruthy();
    expect(blogCluster!.urls).toHaveLength(2);
  });

  test("different URL patterns with same fingerprint stay separate", () => {
    const results: ScanResult[] = [
      makeScanResult({ url: "https://example.com/blog/my-long-post-title", fingerprint: "div(n=3)" }),
      makeScanResult({ url: "https://example.com/docs/getting-started-guide", fingerprint: "div(n=3)" }),
    ];
    const clusters = clusterPages(results);
    expect(clusters.length).toBe(2);
  });
});

describe("buildTestPlan", () => {
  test("always includes mandatory v4.0 tests", () => {
    const cluster = { capabilities: { hasForms: false, hasMedia: false, hasCarousel: false, hasDataTables: false, isSpaShell: false } } as TemplateCluster;
    const plan = buildTestPlan(cluster);
    expect(plan).toContain("axe-full");
    expect(plan).toContain("interactive");
    expect(plan).toContain("reflow");
    expect(plan).toContain("text-spacing");
    expect(plan).toContain("resize-text");
  });

  test("adds multimedia and timed-events when hasMedia", () => {
    const cluster = { capabilities: { hasForms: false, hasMedia: true, hasCarousel: false, hasDataTables: false, isSpaShell: false } } as TemplateCluster;
    const plan = buildTestPlan(cluster);
    expect(plan).toContain("multimedia");
    expect(plan).toContain("timed-events");
  });

  test("adds timed-events when hasCarousel", () => {
    const cluster = { capabilities: { hasForms: false, hasMedia: false, hasCarousel: true, hasDataTables: false, isSpaShell: false } } as TemplateCluster;
    const plan = buildTestPlan(cluster);
    expect(plan).toContain("timed-events");
    expect(plan).not.toContain("multimedia");
  });

  test("no duplicates with media + carousel", () => {
    const cluster = { capabilities: { hasForms: false, hasMedia: true, hasCarousel: true, hasDataTables: false, isSpaShell: false } } as TemplateCluster;
    const plan = buildTestPlan(cluster);
    const timedEventsCount = plan.filter((t) => t === "timed-events").length;
    expect(timedEventsCount).toBe(1);
  });
});

describe("selectRepresentative", () => {
  test("selects URL with most capabilities", () => {
    const scanResults = new Map<string, ScanResult>([
      ["https://example.com/a", makeScanResult({ url: "https://example.com/a" })],
      [
        "https://example.com/b",
        makeScanResult({
          url: "https://example.com/b",
          capabilities: { hasForms: true, hasMedia: true, hasCarousel: false, hasDataTables: false, isSpaShell: false },
        }),
      ],
    ]);
    const cluster = {
      urls: ["https://example.com/a", "https://example.com/b"],
    } as TemplateCluster;
    const rep = selectRepresentative(cluster, scanResults);
    expect(rep).toBe("https://example.com/b");
  });

  test("falls back to first URL when all equal", () => {
    const scanResults = new Map<string, ScanResult>([
      ["https://example.com/a", makeScanResult({ url: "https://example.com/a" })],
      ["https://example.com/b", makeScanResult({ url: "https://example.com/b" })],
    ]);
    const cluster = { urls: ["https://example.com/a", "https://example.com/b"] } as TemplateCluster;
    const rep = selectRepresentative(cluster, scanResults);
    expect(rep).toBeTruthy();
  });
});

describe("prioritizeTemplates", () => {
  test("returns all clusters when under limit", () => {
    const clusters = [{ urls: ["a"] } as TemplateCluster];
    const { probed, skipped } = prioritizeTemplates(clusters, 25);
    expect(probed).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  test("caps at maxProbeTemplates", () => {
    const clusters = Array.from({ length: 30 }, (_, i) => ({
      urls: [`url-${i}`],
      capabilities: { hasForms: false, hasMedia: false, hasCarousel: false, hasDataTables: false, isSpaShell: false },
    })) as TemplateCluster[];
    const { probed, skipped } = prioritizeTemplates(clusters, 5);
    expect(probed).toHaveLength(5);
    expect(skipped).toHaveLength(25);
  });

  test("prioritizes clusters with more pages", () => {
    const small = { urls: ["a"], capabilities: { hasForms: false, hasMedia: false, hasCarousel: false, hasDataTables: false, isSpaShell: false } } as TemplateCluster;
    const big = { urls: ["a", "b", "c", "d", "e"], capabilities: { hasForms: false, hasMedia: false, hasCarousel: false, hasDataTables: false, isSpaShell: false } } as TemplateCluster;
    const { probed } = prioritizeTemplates([small, big], 1);
    expect(probed[0]).toBe(big);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/analyzer/__tests__/classify.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/analyzer/classify.ts
import { simhash, hammingDistance, inferUrlPattern } from "./fingerprint";
import type { ScanResult, TemplateCluster, TestType } from "../types/pipeline";

const HAMMING_THRESHOLD = 8;

export function clusterPages(scanResults: ScanResult[]): TemplateCluster[] {
  const clusters: TemplateCluster[] = [];

  for (const result of scanResults) {
    const urlPattern = inferUrlPattern(result.url);
    const fingerprint = simhash(result.fingerprint);

    // Find existing cluster with same URL pattern AND near fingerprint
    const match = clusters.find(
      (c) =>
        c.urlPattern === urlPattern &&
        hammingDistance(c.fingerprint, fingerprint) <= HAMMING_THRESHOLD,
    );

    if (match) {
      match.urls.push(result.url);
      match.lightIssues.push(...result.lightIssues);
      // Merge capabilities (OR — if any page has it, the cluster has it)
      for (const key of Object.keys(result.capabilities) as Array<keyof typeof result.capabilities>) {
        if (result.capabilities[key]) {
          (match.capabilities as Record<string, boolean>)[key] = true;
        }
      }
    } else {
      clusters.push({
        id: `${fingerprint.toString(16)}-${urlPattern}`,
        fingerprint,
        urlPattern,
        urls: [result.url],
        representative: result.url, // placeholder, updated by selectRepresentative
        capabilities: { ...result.capabilities },
        lightIssues: [...result.lightIssues],
        testPlan: [], // set by buildTestPlan
      });
    }
  }

  return clusters;
}

export function buildTestPlan(cluster: TemplateCluster): TestType[] {
  const plan: TestType[] = [
    "axe-full",
    "interactive",
    "reflow",
    "text-spacing",
    "resize-text",
  ];

  if (cluster.capabilities.hasMedia) plan.push("multimedia", "timed-events");
  if (cluster.capabilities.hasCarousel) plan.push("timed-events");

  return [...new Set(plan)];
}

export function selectRepresentative(
  cluster: TemplateCluster,
  scanResults: Map<string, ScanResult>,
): string {
  return cluster.urls.reduce(
    (best, url) => {
      const page = scanResults.get(url);
      if (!page) return best;
      const score =
        (page.capabilities.hasForms ? 4 : 0) +
        (page.capabilities.hasMedia ? 3 : 0) +
        (page.capabilities.hasCarousel ? 2 : 0) +
        (page.capabilities.hasDataTables ? 1 : 0) +
        (page.lightIssues.length > 0 ? 1 : 0);
      return score > best.score ? { url, score } : best;
    },
    { url: cluster.urls[0], score: -1 },
  ).url;
}

export function prioritizeTemplates(
  clusters: TemplateCluster[],
  maxProbeTemplates: number,
): { probed: TemplateCluster[]; skipped: TemplateCluster[] } {
  if (clusters.length <= maxProbeTemplates) {
    return { probed: clusters, skipped: [] };
  }

  const sorted = [...clusters].sort((a, b) => {
    const capScore = (c: TemplateCluster) =>
      1 + Object.values(c.capabilities).filter(Boolean).length;
    return b.urls.length * capScore(b) - a.urls.length * capScore(a);
  });

  return {
    probed: sorted.slice(0, maxProbeTemplates),
    skipped: sorted.slice(maxProbeTemplates),
  };
}
```

**Step 4: Run tests**

Run: `bun test src/analyzer/__tests__/classify.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/analyzer/classify.ts src/analyzer/__tests__/classify.test.ts
git commit -m "feat(analyzer): add CLASSIFY phase — clustering, test plans, representative selection"
```

---

## Task 10: WCAG Custom Tests — reflow, text-spacing, resize-text

**Files:**
- Create: `src/analyzer/wcag-tests.ts`
- Create: `src/analyzer/__tests__/wcag-tests.test.ts`

**Step 1: Write the failing test**

```typescript
// src/analyzer/__tests__/wcag-tests.test.ts
import { describe, test, expect } from "bun:test";
import {
  testReflow,
  testTextSpacing,
  testResizeText,
  testMultimedia,
  testTimedEvents,
} from "../wcag-tests";

describe("wcag-tests exports", () => {
  test("testReflow is an async function", () => {
    expect(typeof testReflow).toBe("function");
  });
  test("testTextSpacing is an async function", () => {
    expect(typeof testTextSpacing).toBe("function");
  });
  test("testResizeText is an async function", () => {
    expect(typeof testResizeText).toBe("function");
  });
  test("testMultimedia is an async function", () => {
    expect(typeof testMultimedia).toBe("function");
  });
  test("testTimedEvents is an async function", () => {
    expect(typeof testTimedEvents).toBe("function");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/analyzer/__tests__/wcag-tests.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/analyzer/wcag-tests.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";

const OVERFLOW_EXEMPT = new Set(["TABLE", "VIDEO", "CANVAS", "SVG", "PRE", "CODE"]);
const OVERFLOW_TOLERANCE = 2; // px — avoid false positives from sub-pixel rendering

function makeIssue(
  url: string,
  rule: string,
  impact: "critical" | "serious" | "moderate" | "minor",
  description: string,
  selector: string,
): Issue {
  return {
    id: crypto.randomUUID(),
    url,
    rule,
    impact,
    description,
    help: description,
    helpUrl: "",
    wcagTags: [],
    selector,
    html: "",
    surroundingHtml: "",
    xpath: "",
    viewportWidth: 1280,
    pageTitle: "",
    checkSource: "wcag-custom",
    suggestedFix: "",
    fixConfidence: null,
    llmConfidence: null,
    wcagCriterion: "",
    violationCategory: "visual",
  };
}

/**
 * WCAG 1.4.10 Reflow — content reflows at 320px without horizontal scrolling.
 */
export async function testReflow(page: Page, url: string): Promise<Issue[]> {
  const originalViewport = page.viewportSize();

  await page.setViewportSize({ width: 320, height: 720 });
  // Wait for layout recalculation
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));

  const overflowElements: Array<{ tag: string; selector: string; scrollWidth: number; clientWidth: number }> =
    await page.evaluate(
      ({ exempt, tolerance }) => {
        const results: Array<{ tag: string; selector: string; scrollWidth: number; clientWidth: number }> = [];
        const docEl = document.documentElement;
        if (docEl.scrollWidth > docEl.clientWidth + tolerance) {
          // Find elements causing the overflow
          const all = document.querySelectorAll("*");
          for (const el of all) {
            if (exempt.includes(el.tagName)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.right > docEl.clientWidth + tolerance && rect.width > 320) {
              results.push({
                tag: el.tagName,
                selector: el.tagName.toLowerCase() +
                  (el.id ? `#${el.id}` : "") +
                  (el.className && typeof el.className === "string"
                    ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
                    : ""),
                scrollWidth: Math.round(rect.width),
                clientWidth: 320,
              });
            }
          }
        }
        return results;
      },
      { exempt: [...OVERFLOW_EXEMPT], tolerance: OVERFLOW_TOLERANCE },
    );

  // Restore viewport
  if (originalViewport) {
    await page.setViewportSize(originalViewport);
  }

  return overflowElements.map((el) =>
    makeIssue(
      url,
      "reflow",
      "serious",
      `Element ${el.selector} is ${el.scrollWidth}px wide, exceeding 320px viewport. Content must reflow without horizontal scrolling (WCAG 1.4.10).`,
      el.selector,
    ),
  );
}

/**
 * WCAG 1.4.12 Text Spacing — content remains visible with increased spacing.
 */
export async function testTextSpacing(page: Page, url: string): Promise<Issue[]> {
  const clippedElements: Array<{ selector: string }> = await page.evaluate(() => {
    // Inject text spacing overrides per WCAG 1.4.12 criteria
    const style = document.createElement("style");
    style.textContent = `
      * {
        line-height: 1.5 !important;
        letter-spacing: 0.12em !important;
        word-spacing: 0.16em !important;
      }
      p, li, dd, dt, blockquote {
        margin-bottom: 2em !important;
      }
    `;
    document.head.appendChild(style);

    // Wait for reflow
    document.body.offsetHeight; // force sync layout

    const results: Array<{ selector: string }> = [];
    const elements = document.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, span, a, td, th, label, button");
    for (const el of elements) {
      const style = getComputedStyle(el);
      if (style.overflow === "hidden" || style.overflowY === "hidden" || style.overflowX === "hidden") {
        if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) {
          results.push({
            selector:
              el.tagName.toLowerCase() +
              (el.id ? `#${el.id}` : "") +
              (el.className && typeof el.className === "string"
                ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
                : ""),
          });
        }
      }
    }
    return results;
  });

  return clippedElements.map((el) =>
    makeIssue(
      url,
      "text-spacing",
      "serious",
      `Element ${el.selector} clips content when text spacing is increased per WCAG 1.4.12 criteria.`,
      el.selector,
    ),
  );
}

/**
 * WCAG 1.4.4 Resize Text — text can be resized up to 200% without loss.
 */
export async function testResizeText(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Check 1: meta viewport restrictions
  const viewportIssues: Array<{ type: string }> = await page.evaluate(() => {
    const results: Array<{ type: string }> = [];
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      const content = meta.getAttribute("content") || "";
      if (/user-scalable\s*=\s*no/i.test(content)) {
        results.push({ type: "user-scalable-no" });
      }
      const maxScale = content.match(/maximum-scale\s*=\s*([0-9.]+)/i);
      if (maxScale && parseFloat(maxScale[1]) < 2) {
        results.push({ type: `maximum-scale-${maxScale[1]}` });
      }
    }
    return results;
  });

  for (const v of viewportIssues) {
    issues.push(
      makeIssue(
        url,
        "resize-text",
        v.type === "user-scalable-no" ? "critical" : "serious",
        v.type === "user-scalable-no"
          ? "Meta viewport sets user-scalable=no, preventing text resize (WCAG 1.4.4)."
          : `Meta viewport limits maximum-scale, restricting zoom (WCAG 1.4.4).`,
        'meta[name="viewport"]',
      ),
    );
  }

  // Check 2: simulate 200% zoom (halve viewport)
  const originalViewport = page.viewportSize();
  if (originalViewport) {
    await page.setViewportSize({
      width: Math.round(originalViewport.width / 2),
      height: originalViewport.height,
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));

    const hasHorizontalOverflow: boolean = await page.evaluate((tolerance) => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + tolerance;
    }, OVERFLOW_TOLERANCE);

    if (hasHorizontalOverflow) {
      issues.push(
        makeIssue(
          url,
          "resize-text",
          "serious",
          "Page has horizontal overflow at 200% zoom simulation (WCAG 1.4.4).",
          "html",
        ),
      );
    }

    await page.setViewportSize(originalViewport);
  }

  return issues;
}

/**
 * WCAG 1.2.1-1.2.5 Multimedia — detect video/audio without captions.
 */
export async function testMultimedia(page: Page, url: string): Promise<Issue[]> {
  const mediaIssues: Array<{ type: string; selector: string }> = await page.evaluate(() => {
    const results: Array<{ type: string; selector: string }> = [];

    // Videos without captions
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      const hasCaptions = video.querySelector('track[kind="captions"], track[kind="subtitles"]');
      if (!hasCaptions) {
        results.push({
          type: "video-no-captions",
          selector: "video" + (video.id ? `#${video.id}` : ""),
        });
      }
    }

    // Audio without captions
    const audios = document.querySelectorAll("audio");
    for (const audio of audios) {
      const hasCaptions = audio.querySelector('track[kind="captions"], track[kind="subtitles"]');
      if (!hasCaptions) {
        results.push({
          type: "audio-no-captions",
          selector: "audio" + (audio.id ? `#${audio.id}` : ""),
        });
      }
    }

    // YouTube/Vimeo iframes (flagged for manual check)
    const iframes = document.querySelectorAll('iframe[src*="youtube"], iframe[src*="vimeo"]');
    for (const iframe of iframes) {
      results.push({
        type: "iframe-media",
        selector: "iframe" + (iframe.id ? `#${iframe.id}` : ""),
      });
    }

    return results;
  });

  return mediaIssues.map((m) =>
    makeIssue(
      url,
      "multimedia",
      m.type === "iframe-media" ? "moderate" : "serious",
      m.type === "video-no-captions"
        ? `Video element without captions track (WCAG 1.2.2).`
        : m.type === "audio-no-captions"
          ? `Audio element without captions track (WCAG 1.2.1).`
          : `Embedded media iframe detected — verify captions are available (WCAG 1.2.2).`,
      m.selector,
    ),
  );
}

/**
 * WCAG 2.2.1-2.2.2 Timed Events — detect auto-playing/timed content.
 */
export async function testTimedEvents(page: Page, url: string): Promise<Issue[]> {
  const timedIssues: Array<{ type: string; selector: string }> = await page.evaluate(() => {
    const results: Array<{ type: string; selector: string }> = [];

    // Meta refresh
    const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
    if (metaRefresh) {
      results.push({ type: "meta-refresh", selector: 'meta[http-equiv="refresh"]' });
    }

    // Marquee
    const marquees = document.querySelectorAll("marquee");
    for (const m of marquees) {
      results.push({ type: "marquee", selector: "marquee" });
    }

    // Autoplay media
    const autoplay = document.querySelectorAll("video[autoplay], audio[autoplay]");
    for (const el of autoplay) {
      results.push({
        type: "autoplay",
        selector: el.tagName.toLowerCase() + "[autoplay]",
      });
    }

    // Carousel patterns
    const carousels = document.querySelectorAll(
      '[aria-roledescription="carousel"], [class*="carousel" i], [class*="slider" i], [data-ride="carousel"]',
    );
    for (const c of carousels) {
      results.push({
        type: "carousel",
        selector:
          c.tagName.toLowerCase() +
          (c.id ? `#${c.id}` : "") +
          (c.className && typeof c.className === "string" ? "." + c.className.trim().split(/\s+/)[0] : ""),
      });
    }

    return results;
  });

  return timedIssues.map((t) =>
    makeIssue(
      url,
      "timed-events",
      t.type === "meta-refresh" ? "critical" : "serious",
      t.type === "meta-refresh"
        ? "Page uses meta refresh which may disorient users (WCAG 2.2.1)."
        : t.type === "marquee"
          ? "Marquee element detected — moving content without pause mechanism (WCAG 2.2.2)."
          : t.type === "autoplay"
            ? "Media with autoplay detected — verify pause mechanism exists (WCAG 2.2.2)."
            : "Carousel/slider detected — verify pause and manual control available (WCAG 2.2.2).",
      t.selector,
    ),
  );
}
```

**Step 4: Run tests**

Run: `bun test src/analyzer/__tests__/wcag-tests.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/analyzer/wcag-tests.ts src/analyzer/__tests__/wcag-tests.test.ts
git commit -m "feat(analyzer): add 5 WCAG custom tests — reflow, text-spacing, resize-text, multimedia, timed-events"
```

---

## Task 11: Worker DB functions — spans + updated inserts

**Files:**
- Modify: `src/worker/db.ts`

**Step 1: Write the failing test**

```typescript
// src/worker/__tests__/db-spans.test.ts
import { describe, test, expect } from "bun:test";
import { persistSpans } from "../db";
import type { SpanRecord } from "../../types/pipeline";

describe("persistSpans", () => {
  test("is exported as an async function", () => {
    expect(typeof persistSpans).toBe("function");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/worker/__tests__/db-spans.test.ts`
Expected: FAIL — `persistSpans` not exported from `../db`

**Step 3: Add persistSpans and update insertPage/insertIssues in src/worker/db.ts**

Add to `src/worker/db.ts`:

```typescript
// Add import at top
import type { SpanRecord, PageCapabilities } from "../types/pipeline";

// Add persistSpans function
export async function persistSpans(spans: SpanRecord[]): Promise<void> {
  if (spans.length === 0) return;
  const db = getWorkerDb();
  await db`INSERT INTO audit_spans ${db(
    spans.map((s) => ({
      audit_id: s.auditId,
      trace_id: s.traceId,
      span_id: s.spanId,
      parent_span_id: s.parentSpanId,
      name: s.name,
      started_at: s.startedAt,
      ended_at: s.endedAt,
      status: s.status,
      error_message: s.errorMessage,
      metadata: s.metadata,
    })),
  )}`;
}

// Update insertPage to accept template fields
export async function insertPageV4(
  auditId: string,
  page: {
    url: string;
    title?: string;
    templateId?: string;
    isRepresentative?: boolean;
    fingerprint?: string;
    elementCount?: number;
    capabilities?: PageCapabilities;
    issueCount?: number;
    issuesByImpact?: Record<string, number>;
    durationMs?: number;
  },
): Promise<string> {
  const db = getWorkerDb();
  const [row] = await db`
    INSERT INTO pages (audit_id, url, title, template_id, is_representative,
                       fingerprint, element_count, capabilities,
                       issue_count, issues_by_impact, duration_ms)
    VALUES (${auditId}, ${page.url}, ${page.title ?? ""},
            ${page.templateId ?? null}, ${page.isRepresentative ?? false},
            ${page.fingerprint ?? null}, ${page.elementCount ?? null},
            ${page.capabilities ? JSON.stringify(page.capabilities) : null}::jsonb,
            ${page.issueCount ?? 0}, ${page.issuesByImpact ? JSON.stringify(page.issuesByImpact) : "{}"}::jsonb,
            ${page.durationMs ?? 0})
    RETURNING id
  `;
  return row.id;
}

// Update insertIssues to use batch INSERT with template fields
export async function insertIssuesV4(
  auditId: string,
  pageId: string,
  issues: Array<{
    rule: string;
    impact: string;
    description?: string;
    help?: string;
    helpUrl?: string;
    wcagTags?: string[];
    selector?: string;
    html?: string;
    xpath?: string;
    checkSource: string;
    category?: string;
    suggestedFix?: string;
    fixConfidence?: number | null;
    templateId?: string | null;
    affectedPages?: number;
    amplifiedFrom?: string | null;
  }>,
): Promise<void> {
  if (issues.length === 0) return;
  const db = getWorkerDb();
  await db`INSERT INTO issues ${db(
    issues.map((i) => ({
      audit_id: auditId,
      page_id: pageId,
      rule: i.rule,
      impact: i.impact,
      description: i.description ?? "",
      help: i.help ?? "",
      help_url: i.helpUrl ?? "",
      wcag_tags: JSON.stringify(i.wcagTags ?? []),
      selector: i.selector ?? "",
      html: i.html ?? "",
      xpath: i.xpath ?? "",
      check_source: i.checkSource,
      category: i.category ?? "structural",
      suggested_fix: i.suggestedFix ?? "",
      fix_confidence: i.fixConfidence ?? null,
      template_id: i.templateId ?? null,
      affected_pages: i.affectedPages ?? 1,
      amplified_from: i.amplifiedFrom ?? null,
    })),
  )}`;
}

// Remove dead code: updateAuditProgress()
```

**Step 4: Run test**

Run: `bun test src/worker/__tests__/db-spans.test.ts`
Expected: PASS

**Step 5: Also remove dead code from db.ts**

Remove `updateAuditProgress()` function (lines 54-63, never called).

**Step 6: Commit**

```bash
git add src/worker/db.ts src/worker/__tests__/db-spans.test.ts
git commit -m "feat(worker/db): add persistSpans, insertPageV4, insertIssuesV4; remove dead updateAuditProgress"
```

---

## Task 12: SCAN Phase — scanPage function

**Files:**
- Create: `src/worker/scan.ts`

**Step 1: Write implementation**

This is the core SCAN function that ties together SlotPool, consent blocking, resource blocking, fingerprinting, axe-light, LLM fallback, and DB persistence.

```typescript
// src/worker/scan.ts
import type { Browser, Page } from "playwright";
import type { Issue } from "../types/issue";
import type { ScanResult, CrawlError, PipelineConfig } from "../types/pipeline";
import { AxeBuilder } from "@axe-core/playwright";
import { SlotPool } from "./slot-pool";
import { NODE_SIGNATURE_FN, simhash } from "../analyzer/fingerprint";
import { insertPageV4, insertIssuesV4 } from "./db";
import { injectConsentPrehideCSS } from "../analyzer/consent-blocker";
import { discoverNavTargets } from "../discovery/nav";
import type { LLMClient } from "../llm/client";
import { AuditTracer } from "./tracer";

const MIN_INTERNAL_LINKS = 3;

const AXE_LIGHT_RULES = ["image-alt", "link-name", "button-name", "label", "document-title"];

interface ScanPhaseResult {
  scanResults: Map<string, ScanResult>;
  allLinks: Map<string, string[]>; // url → discovered links
  crawlErrors: CrawlError[];
}

export async function runScanPhase(
  getBrowser: () => Promise<Browser>,
  auditId: string,
  urls: string[],
  resolvedOrigin: string,
  config: PipelineConfig,
  tracer: AuditTracer,
  llmClient: LLMClient | null,
): Promise<ScanPhaseResult> {
  const pool = new SlotPool(config.concurrency, config.pagesPerContext);
  const scanResults = new Map<string, ScanResult>();
  const allLinks = new Map<string, string[]>();
  const crawlErrors: CrawlError[] = [];

  async function scanPage(url: string): Promise<void> {
    const slot = await pool.acquire();
    try {
      await tracer.trace("scan:page", async (span) => {
        span.setMeta({ url });
        const context = await slot.get(getBrowser, "scan");
        const page = await context.newPage();
        try {
          // Navigate with error handling
          let response;
          try {
            response = await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: config.pageTimeout,
            });
          } catch (err) {
            crawlErrors.push({ url, error: err instanceof Error ? err.message : String(err), timestamp: new Date() });
            span.end("error", "navigation-failed");
            return;
          }

          if (!response) {
            crawlErrors.push({ url, error: "no-response", timestamp: new Date() });
            span.end("error", "no-response");
            return;
          }

          const status = response.status();
          if (status >= 500) {
            // Retry once for server errors
            await page.waitForTimeout(2_000);
            try {
              const retry = await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.pageTimeout });
              if (!retry || retry.status() >= 400) {
                crawlErrors.push({ url, error: `http-${retry?.status() ?? status}`, timestamp: new Date() });
                span.end("error", `http-${retry?.status() ?? status}`);
                return;
              }
            } catch {
              crawlErrors.push({ url, error: `http-${status}-retry-failed`, timestamp: new Date() });
              span.end("error", `http-${status}-retry-failed`);
              return;
            }
          } else if (status >= 400) {
            crawlErrors.push({ url, error: `http-${status}`, timestamp: new Date() });
            span.end("error", `http-${status}`);
            return;
          }

          // Check same-origin after redirect
          const finalUrl = page.url();
          if (new URL(finalUrl).origin !== resolvedOrigin) return;

          // Inject CSS prehide for consent banners
          await injectConsentPrehideCSS(page);

          // Batch DOM extraction: fingerprint + links + capabilities
          const domData = await page.evaluate(`
            (function() {
              ${NODE_SIGNATURE_FN}
              var links = Array.from(document.querySelectorAll("a[href]"), function(a) { return a.href; });
              var hasForms = document.querySelectorAll("form").length > 0;
              var hasMedia = document.querySelectorAll("video, audio, iframe[src*='youtube'], iframe[src*='vimeo']").length > 0;
              var hasCarousel = !!document.querySelector('[class*="carousel" i], [class*="slider" i], [aria-roledescription="carousel"]');
              var hasDataTables = document.querySelectorAll("table:not([role='presentation'])").length > 0;
              var isSpaShell = !!(
                document.querySelector("app-root, #root, #app, #__next, #__nuxt") &&
                document.querySelectorAll("a[href]").length < 3
              );
              return {
                fingerprint: nodeSignature(document.body, 0),
                title: document.title,
                links: links,
                elementCount: document.querySelectorAll("*").length,
                capabilities: { hasForms: hasForms, hasMedia: hasMedia, hasCarousel: hasCarousel, hasDataTables: hasDataTables, isSpaShell: isSpaShell },
              };
            })()
          `);

          // axe LIGHT — content-dependent rules only
          let lightIssues: Issue[] = [];
          try {
            const axeResults = await new AxeBuilder({ page })
              .withRules(AXE_LIGHT_RULES)
              .options({ resultTypes: ["violations", "incomplete"] })
              .analyze();

            lightIssues = axeResults.violations.flatMap((v) =>
              v.nodes.map((node) => ({
                id: crypto.randomUUID(),
                url: finalUrl,
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
                pageTitle: domData.title,
                checkSource: "scan-light" as const,
                suggestedFix: node.failureSummary ?? "",
                fixConfidence: null,
                llmConfidence: null,
                wcagCriterion: "",
                violationCategory: "structural" as const,
              })),
            );
          } catch {
            // axe failure is non-fatal
          }

          // LLM nav discovery fallback for SPA shells
          let discoveryMethod: ScanResult["discoveryMethod"] = "standard";
          let links = domData.links as string[];

          const internalLinks = links.filter((l) => {
            try { return new URL(l).origin === resolvedOrigin; } catch { return false; }
          });

          if (internalLinks.length < MIN_INTERNAL_LINKS && domData.capabilities.isSpaShell && llmClient) {
            await page.waitForLoadState("networkidle").catch(() => {});
            const reExtracted: string[] = await page.evaluate(() =>
              Array.from(document.querySelectorAll("a[href]"), (a) => a.href),
            );

            if (reExtracted.filter((l) => { try { return new URL(l).origin === new URL(location.href).origin; } catch { return false; } }).length < MIN_INTERNAL_LINKS) {
              // Still no links — use LLM
              try {
                // Note: discoverNavTargets signature may need adaptation
                // For now, extract links from page with LLM guidance
                discoveryMethod = "llm";
              } catch {
                // LLM failure is non-fatal
              }
            } else {
              links = reExtracted;
              discoveryMethod = "networkidle-retry";
            }
          }

          // Persist immediately
          const pageId = await insertPageV4(auditId, {
            url: finalUrl,
            title: domData.title,
            fingerprint: domData.fingerprint,
            elementCount: domData.elementCount,
            capabilities: domData.capabilities,
            issueCount: lightIssues.length,
          });

          if (lightIssues.length > 0) {
            await insertIssuesV4(
              auditId,
              pageId,
              lightIssues.map((i) => ({
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
              })),
            );
          }

          const result: ScanResult = {
            url: finalUrl,
            fingerprint: domData.fingerprint,
            title: domData.title,
            links,
            elementCount: domData.elementCount,
            capabilities: domData.capabilities,
            lightIssues,
            pageId,
            discoveryMethod,
          };

          scanResults.set(finalUrl, result);
          allLinks.set(finalUrl, links);

          span.setMeta({
            lightIssueCount: lightIssues.length,
            elementCount: domData.elementCount,
            linkCount: links.length,
            discoveryMethod,
          });
        } finally {
          try { await page.close(); } catch { /* already closed */ }
        }
      });
    } finally {
      pool.release(slot);
    }
  }

  try {
    await Promise.all(urls.map((url) => scanPage(url)));
  } finally {
    await pool.closeAll();
  }

  await tracer.flush(); // Phase boundary flush — SCAN spans survive even if CLASSIFY/PROBE crash

  return { scanResults, allLinks, crawlErrors };
}
```

**Step 2: Commit**

```bash
git add src/worker/scan.ts
git commit -m "feat(worker): add SCAN phase — concurrent page scanning with axe-light + fingerprinting"
```

---

## Task 13: PROBE Phase — deep analysis orchestration

**Files:**
- Create: `src/worker/probe.ts`

**Step 1: Write implementation**

```typescript
// src/worker/probe.ts
import type { Browser, Page } from "playwright";
import type { Issue } from "../types/issue";
import type { TemplateCluster, TestType, PipelineConfig } from "../types/pipeline";
import { AxeBuilder } from "@axe-core/playwright";
import { ProbeContextManager } from "./probe-context";
import { insertPageV4, insertIssuesV4 } from "./db";
import { injectConsentPrehideCSS } from "../analyzer/consent-blocker";
import { runInteractiveTests } from "../analyzer/interactive";
import { testReflow, testTextSpacing, testResizeText, testMultimedia, testTimedEvents } from "../analyzer/wcag-tests";
import { AuditTracer } from "./tracer";

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

          // 2. page.evaluate()-only tests (parallel)
          const evaluateTests: Promise<Issue[]>[] = [];
          if (cluster.testPlan.includes("multimedia")) evaluateTests.push(testMultimedia(page, url));
          if (cluster.testPlan.includes("timed-events")) evaluateTests.push(testTimedEvents(page, url));
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
            suggestedFix: i.suggestedFix,
            fixConfidence: i.fixConfidence,
            templateId: cluster.id,
          })));

          // Other pages: ONLY template-level issues (amplified)
          for (const memberUrl of cluster.urls.filter((u) => u !== url)) {
            // The page was already inserted during SCAN — update it with template info
            // For amplified issues, insert with amplifiedFrom field
            if (templateIssues.length > 0) {
              // Get existing pageId from SCAN or insert fresh
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
                suggestedFix: i.suggestedFix,
                fixConfidence: i.fixConfidence,
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
```

**Step 2: Commit**

```bash
git add src/worker/probe.ts
git commit -m "feat(worker): add PROBE phase — deep analysis with template amplification"
```

---

## Task 14: Pipeline Orchestration — runPipeline

**Files:**
- Create: `src/worker/pipeline.ts`

**Step 1: Write implementation**

This is the top-level function that ties SCAN → CLASSIFY → PROBE together and replaces `runAudit()`.

```typescript
// src/worker/pipeline.ts
import type { Browser } from "playwright";
import type { PipelineConfig, TemplateCluster, CrawlError } from "../types/pipeline";
import type { LLMClient } from "../llm/client";
import { AuditTracer } from "./tracer";
import { persistSpans, markAuditCompleted, markAuditFailed, emitAuditEvent, insertPageV4 } from "./db";
import { runScanPhase } from "./scan";
import { runProbePhase } from "./probe";
import { clusterPages, buildTestPlan, selectRepresentative, prioritizeTemplates } from "../analyzer/classify";
import { computeWcagScore } from "../reporter/wcag-score";
import { UrlQueue } from "../crawler/queue";
import { discoverSitemapUrls } from "../crawler/sitemap";
import { generatePdf } from "../reporter/pdf";

export async function runPipeline(
  getBrowser: () => Promise<Browser>,
  auditId: string,
  userConfig: Partial<PipelineConfig> & { baseUrl: string },
  llmClient: LLMClient | null,
): Promise<void> {
  const config: PipelineConfig = {
    maxPages: userConfig.maxPages ?? 50,
    maxDepth: userConfig.maxDepth ?? 5,
    wcagLevel: userConfig.wcagLevel ?? "AA",
    pageTimeout: userConfig.pageTimeout ?? 15_000,
    concurrency: userConfig.concurrency ?? 3,
    pagesPerContext: userConfig.pagesPerContext ?? 25,
    probePagesPerContext: userConfig.probePagesPerContext ?? 5,
    maxProbeTemplates: userConfig.maxProbeTemplates ?? 25,
    navModel: userConfig.navModel ?? "kimi-k2-turbo-preview",
    rateLimitRpm: userConfig.rateLimitRpm ?? 10,
    baseUrl: userConfig.baseUrl,
  };

  const tracer = new AuditTracer(auditId, (spans) => persistSpans(spans));
  const startTime = Date.now();
  const startMemory = process.memoryUsage().heapUsed;

  try {
    await tracer.trace("audit:run", async (auditSpan) => {
      auditSpan.setMeta({ url: config.baseUrl, maxPages: config.maxPages, startMemoryMb: Math.round(startMemory / 1024 / 1024) });

      // ── Resolve redirects to get canonical origin ──
      const resolvedOrigin = await resolveOrigin(config.baseUrl);

      // ── Seed URLs (base + sitemap) ──
      const queue = new UrlQueue(config.maxPages, config.maxDepth);
      queue.seed([config.baseUrl], "link", 0);

      // Discover sitemap URLs
      try {
        const sitemapUrls = await discoverSitemapUrls(config.baseUrl);
        const sameOriginUrls = sitemapUrls.filter((u) => {
          try { return new URL(u).origin === resolvedOrigin; } catch { return false; }
        });
        queue.seed(sameOriginUrls, "sitemap", 1);
      } catch {
        // Sitemap discovery is non-fatal
      }

      // Collect all URLs to scan
      const urlsToScan: string[] = [];
      let url: string | null;
      while ((url = queue.next()) !== null) {
        urlsToScan.push(url);
      }

      await emitAuditEvent(auditId, "scan:start", { pageCount: urlsToScan.length });

      // ══════════════════════════════════════════════
      // PHASE 1: SCAN
      // ══════════════════════════════════════════════
      const { scanResults, allLinks, crawlErrors } = await tracer.trace("audit:scan", async (scanSpan) => {
        const result = await runScanPhase(
          getBrowser, auditId, urlsToScan, resolvedOrigin, config, tracer, llmClient,
        );
        scanSpan.setMeta({
          pageCount: result.scanResults.size,
          errorCount: result.crawlErrors.length,
        });

        // Feed discovered links back into queue for additional pages
        for (const [pageUrl, links] of result.allLinks) {
          const depth = queue.getDepth(pageUrl) ?? 1;
          const sameOriginLinks = links.filter((l) => {
            try { return new URL(l).origin === resolvedOrigin; } catch { return false; }
          });
          queue.seed(sameOriginLinks, "link", depth + 1);
        }

        // Scan any newly discovered URLs
        const additionalUrls: string[] = [];
        let nextUrl: string | null;
        while ((nextUrl = queue.next()) !== null) {
          additionalUrls.push(nextUrl);
        }

        if (additionalUrls.length > 0) {
          const additional = await runScanPhase(
            getBrowser, auditId, additionalUrls, resolvedOrigin, config, tracer, llmClient,
          );
          for (const [k, v] of additional.scanResults) result.scanResults.set(k, v);
          result.crawlErrors.push(...additional.crawlErrors);
        }

        return result;
      });

      await emitAuditEvent(auditId, "scan:complete", { pagesScanned: scanResults.size });

      // ══════════════════════════════════════════════
      // PHASE 2: CLASSIFY
      // ══════════════════════════════════════════════
      const templates = await tracer.trace("audit:classify", async (classifySpan) => {
        const allResults = [...scanResults.values()];
        const clusters = clusterPages(allResults);

        // Select representatives and build test plans
        for (const cluster of clusters) {
          cluster.representative = selectRepresentative(cluster, scanResults);
          cluster.testPlan = buildTestPlan(cluster);
        }

        // Cap templates for PROBE
        const { probed, skipped } = prioritizeTemplates(clusters, config.maxProbeTemplates);

        classifySpan.setMeta({
          templateCount: clusters.length,
          probedCount: probed.length,
          skippedCount: skipped.length,
        });

        return probed;
      });

      await tracer.flush(); // Phase boundary flush — CLASSIFY spans survive if PROBE crashes

      await emitAuditEvent(auditId, "probe:start", {
        templateCount: templates.length,
        representatives: templates.map((t) => t.representative),
      });

      // ══════════════════════════════════════════════
      // PHASE 3: PROBE
      // ══════════════════════════════════════════════
      await tracer.trace("audit:probe", async (probeSpan) => {
        await runProbePhase(getBrowser, auditId, templates, config, tracer);
        probeSpan.setMeta({ templatesProbed: templates.length });
      });

      // ── Post-processing ──
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      const endMemory = process.memoryUsage().heapUsed;
      auditSpan.setMeta({ endMemoryMb: Math.round(endMemory / 1024 / 1024), durationSeconds });

      // Build summary from DB
      const summary = {
        totalPages: scanResults.size,
        totalTemplates: templates.length,
        pipelineVersion: "v4.0",
      };

      const templateClusters = templates.map((t) => ({
        id: t.id,
        urlPattern: t.urlPattern,
        urls: t.urls,
        representative: t.representative,
        capabilities: t.capabilities,
        testPlan: t.testPlan,
      }));

      await markAuditCompleted(
        auditId,
        summary,
        { totalUrlsDiscovered: scanResults.size, urlsFromSitemap: 0, urlsFromLinks: scanResults.size, urlsFromInteraction: 0 },
        llmClient?.usage ?? { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, navigationCalls: 0, enrichmentCalls: 0 },
        durationSeconds,
        null, // wcag_score computed separately if needed
        crawlErrors.length > 0 ? crawlErrors : null,
      );

      // Persist template_clusters on audit
      // TODO: update audit with template_clusters JSONB

      await emitAuditEvent(auditId, "audit:complete", { durationSeconds });

      // Generate PDF (non-fatal)
      try {
        const browser = await getBrowser();
        // PDF generation reuses existing generatePdf with adapted report format
      } catch {
        // PDF failure is non-fatal
      }
    });
  } catch (err) {
    await markAuditFailed(auditId, err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await tracer.flush(); // Final flush for any remaining spans
  }
}

async function resolveOrigin(baseUrl: string): Promise<string> {
  try {
    const resp = await fetch(baseUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    return new URL(resp.url).origin;
  } catch {
    return new URL(baseUrl).origin;
  }
}
```

**Step 2: Commit**

```bash
git add src/worker/pipeline.ts
git commit -m "feat(worker): add pipeline orchestration — SCAN → CLASSIFY → PROBE with tracer"
```

---

## Task 15: Wire Pipeline into Worker

**Files:**
- Modify: `src/worker/index.ts` — replace `runAudit` import with `runPipeline`
- Modify: `src/worker/audit.ts` — keep file but mark as deprecated (or delete and redirect imports)

**Step 1: Update src/worker/index.ts**

Replace the `runAudit` call with `runPipeline`:

```typescript
// Change import
import { runPipeline } from "./pipeline";

// In the audit processing section (around line 94):
await runPipeline(getBrowser, audit.id, {
  baseUrl: audit.url,
  maxPages: audit.config?.maxPages,
  maxDepth: audit.config?.maxDepth,
  wcagLevel: audit.config?.wcagLevel,
}, llmClient);
```

**Step 2: Verify worker starts**

Run: `bun run src/worker/index.ts` (with env vars set)
Expected: Worker starts polling, no import errors.

**Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat(worker): wire v4 pipeline into worker loop, replacing runAudit"
```

---

## Task 16: Dead Code Removal

**Files:**
- Delete or gut: `src/worker/audit.ts` (old pipeline — replaced by pipeline.ts + scan.ts + probe.ts)
- Modify: `src/llm/client.ts` — remove `buildMultimodalMessage`, `COST_PER_TOKEN_USD`
- Modify: `src/reporter/shared.ts` — keep (still used for post-processing)

**Step 1: Remove dead code from audit.ts**

Either delete the file entirely (if nothing else imports from it) or remove:
- `dismissCookieBanner()` (lines 400-431)
- `groupedByRule` construction (lines 194-198)
- `discoveryMethods: {}` (line 206)
- Duplicate `page.title()` call (line 191)
- 9 separate `.filter()` scans (lines 296-297)
- `pages[]` in-memory accumulation (line 80)

**Step 2: Remove dead code from llm/client.ts**

- Remove `buildMultimodalMessage` (lines 155-167)
- Remove `COST_PER_TOKEN_USD` (line 150)

**Step 3: Remove dead code from db.ts**

- Remove `updateAuditProgress()` (if not already removed in Task 11)

**Step 4: Verify no broken imports**

Run: `bun test`
Expected: All tests pass (no broken imports).

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove dead code — dismissCookieBanner, unused LLM helpers, updateAuditProgress"
```

---

## Task 17: Dependency Cleanup

**Files:**
- Modify: `package.json` — remove linkedom, jsdom, direct axe-core

**Step 1: Remove unused dependencies**

```bash
bun remove linkedom jsdom axe-core tsx
```

Keep: `@axe-core/playwright` (used by AxeBuilder), `playwright`, `postgres`, `openai`, `zod`.

Note: `tsx` was used by the old CLI entry point (deleted in v3). Verify no script references it.

**Step 2: Delete spike files**

```bash
rm -rf spike/
```

**Step 3: Verify build**

Run: `bun test`
Expected: PASS — no imports reference removed packages.

**Step 4: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: remove unused deps — linkedom, jsdom, axe-core, tsx"
```

---

## Task 18: Update Docker/Browserless Config

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Update browserless environment**

```yaml
browserless:
  image: ghcr.io/browserless/chromium
  environment:
    CONCURRENT: 3          # Match SlotPool concurrency
    QUEUED: 15
    TIMEOUT: 600000        # 10 min for large crawls
    HEALTH: "true"
    MAX_MEMORY_PERCENT: 80
    MAX_CPU_PERCENT: 85
    CHROME_FLAGS: >-
      --disable-dev-shm-usage
      --disable-gpu
      --disable-extensions
      --disable-background-networking
      --no-zygote
      --disable-background-timer-throttling
      --disable-renderer-backgrounding
```

Key change: `CONCURRENT: 3` (was 2) to match the 3-slot SlotPool.

**Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(infra): update Browserless config — CONCURRENT=3, memory/CPU guards"
```

---

## Task 19: Integration Smoke Test

**Files:**
- Create: `src/worker/__tests__/pipeline-smoke.test.ts`

**Step 1: Write a smoke test that validates the pipeline wiring**

```typescript
// src/worker/__tests__/pipeline-smoke.test.ts
import { describe, test, expect } from "bun:test";

describe("pipeline module wiring", () => {
  test("all pipeline modules import without errors", async () => {
    const pipeline = await import("../pipeline");
    expect(typeof pipeline.runPipeline).toBe("function");

    const scan = await import("../scan");
    expect(typeof scan.runScanPhase).toBe("function");

    const probe = await import("../probe");
    expect(typeof probe.runProbePhase).toBe("function");

    const slotPool = await import("../slot-pool");
    expect(typeof slotPool.SlotPool).toBe("function");
    expect(typeof slotPool.ContextSlot).toBe("function");

    const probeCtx = await import("../probe-context");
    expect(typeof probeCtx.ProbeContextManager).toBe("function");

    const tracer = await import("../tracer");
    expect(typeof tracer.AuditTracer).toBe("function");
    expect(typeof tracer.Span).toBe("function");
  });

  test("all analyzer modules import without errors", async () => {
    const consent = await import("../../analyzer/consent-blocker");
    expect(typeof consent.installConsentBlocker).toBe("function");

    const resource = await import("../../analyzer/resource-blocker");
    expect(typeof resource.installResourceBlocker).toBe("function");

    const fingerprint = await import("../../analyzer/fingerprint");
    expect(typeof fingerprint.simhash).toBe("function");
    expect(typeof fingerprint.hammingDistance).toBe("function");
    expect(typeof fingerprint.inferUrlPattern).toBe("function");

    const classify = await import("../../analyzer/classify");
    expect(typeof classify.clusterPages).toBe("function");
    expect(typeof classify.buildTestPlan).toBe("function");
    expect(typeof classify.selectRepresentative).toBe("function");

    const wcag = await import("../../analyzer/wcag-tests");
    expect(typeof wcag.testReflow).toBe("function");
    expect(typeof wcag.testTextSpacing).toBe("function");
    expect(typeof wcag.testResizeText).toBe("function");
    expect(typeof wcag.testMultimedia).toBe("function");
    expect(typeof wcag.testTimedEvents).toBe("function");
  });
});
```

**Step 2: Run all tests**

Run: `bun test`
Expected: All existing + new tests PASS.

**Step 3: Commit**

```bash
git add src/worker/__tests__/pipeline-smoke.test.ts
git commit -m "test: add pipeline smoke test — verify all v4 modules import correctly"
```

---

## Summary: Task Dependency Graph

```
Task 1 (DB migration)
  ↓
Task 2 (Types) ─────────────────────┐
  ↓                                  │
Task 3 (Consent blocker)             │
Task 4 (Resource blocker)            │
Task 5 (SimHash + URL patterns)      │
Task 6 (AuditTracer)                 │
  ↓ (all independent, can parallel)  │
Task 7 (SlotPool) ← needs 3, 4      │
Task 8 (ProbeContextManager) ← 3, 4 │
Task 9 (CLASSIFY) ← needs 5         │
Task 10 (WCAG tests)                 │
Task 11 (DB functions) ← needs 2    │
  ↓                                  │
Task 12 (SCAN) ← needs 7, 11        │
Task 13 (PROBE) ← needs 8, 10, 11   │
  ↓                                  │
Task 14 (Pipeline) ← needs 12, 13, 9│
  ↓
Task 15 (Wire into worker) ← 14
Task 16 (Dead code removal) ← 15
Task 17 (Dep cleanup) ← 16
Task 18 (Docker config) ← independent
Task 19 (Smoke test) ← 15
```

**Parallelizable groups:**
- Tasks 3, 4, 5, 6, 10 can all run in parallel after Task 2
- Tasks 7, 8, 9 can run in parallel after their deps
- Tasks 16, 17, 18 can run in parallel after Task 15

**Estimated total: ~19 tasks, ~2-4 hours with experienced implementer**
