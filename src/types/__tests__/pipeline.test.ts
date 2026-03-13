import { test, expect } from "bun:test";
import type {
  ScanResult,
  TemplateCluster,
  TestType,
  SpanRecord,
  PipelineConfig,
} from "../pipeline";
import { DEFAULT_PIPELINE_CONFIG } from "../pipeline";

test("ScanResult can be constructed with all fields", () => {
  const result: ScanResult = {
    url: "https://example.com",
    fingerprint: "abc123",
    title: "Example Page",
    links: ["https://example.com/about", "https://example.com/contact"],
    elementCount: 42,
    capabilities: {
      hasForms: true,
      hasMedia: false,
      hasCarousel: false,
      hasDataTables: true,
      isSpaShell: false,
    },
    lightIssues: [],
    pageId: "page-001",
    discoveryMethod: "standard",
  };

  expect(result.url).toBe("https://example.com");
  expect(result.fingerprint).toBe("abc123");
  expect(result.title).toBe("Example Page");
  expect(result.links).toHaveLength(2);
  expect(result.elementCount).toBe(42);
  expect(result.capabilities.hasForms).toBe(true);
  expect(result.capabilities.hasDataTables).toBe(true);
  expect(result.lightIssues).toHaveLength(0);
  expect(result.pageId).toBe("page-001");
  expect(result.discoveryMethod).toBe("standard");
});

test("TemplateCluster can be constructed with bigint fingerprint", () => {
  const cluster: TemplateCluster = {
    id: "cluster-1",
    fingerprint: 9007199254740993n,
    urlPattern: "/products/:id",
    urls: ["https://example.com/products/1", "https://example.com/products/2"],
    representative: "https://example.com/products/1",
    capabilities: {
      hasForms: false,
      hasMedia: false,
      hasCarousel: false,
      hasDataTables: false,
      isSpaShell: false,
    },
    lightIssues: [],
    testPlan: ["axe-full", "interactive"],
  };

  expect(cluster.fingerprint).toBe(9007199254740993n);
  expect(typeof cluster.fingerprint).toBe("bigint");
  expect(cluster.urls).toHaveLength(2);
  expect(cluster.testPlan).toContain("axe-full");
});

test("TestType union has 7 values for v4.0", () => {
  const allTestTypes: TestType[] = [
    "axe-full",
    "interactive",
    "reflow",
    "text-spacing",
    "resize-text",
    "multimedia",
    "timed-events",
  ];

  expect(allTestTypes).toHaveLength(7);
  // Verify uniqueness
  expect(new Set(allTestTypes).size).toBe(7);
});

test("SpanRecord has all fields", () => {
  const span: SpanRecord = {
    auditId: "audit-1",
    traceId: "trace-abc",
    spanId: "span-001",
    parentSpanId: null,
    name: "scan-page",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    endedAt: new Date("2026-01-01T00:00:05Z"),
    status: "ok",
    errorMessage: null,
    metadata: { url: "https://example.com", attempt: 1 },
  };

  expect(span.auditId).toBe("audit-1");
  expect(span.traceId).toBe("trace-abc");
  expect(span.spanId).toBe("span-001");
  expect(span.parentSpanId).toBeNull();
  expect(span.name).toBe("scan-page");
  expect(span.startedAt).toBeInstanceOf(Date);
  expect(span.endedAt).toBeInstanceOf(Date);
  expect(span.status).toBe("ok");
  expect(span.errorMessage).toBeNull();
  expect(span.metadata).toHaveProperty("url");

  // Verify error variant
  const errorSpan: SpanRecord = {
    ...span,
    status: "error",
    errorMessage: "Navigation timeout",
    endedAt: null,
  };
  expect(errorSpan.status).toBe("error");
  expect(errorSpan.errorMessage).toBe("Navigation timeout");
  expect(errorSpan.endedAt).toBeNull();
});

test("DEFAULT_PIPELINE_CONFIG has expected defaults", () => {
  expect(DEFAULT_PIPELINE_CONFIG.maxPages).toBe(50);
  expect(DEFAULT_PIPELINE_CONFIG.maxDepth).toBe(5);
  expect(DEFAULT_PIPELINE_CONFIG.wcagLevel).toBe("AA");
  expect(DEFAULT_PIPELINE_CONFIG.pageTimeout).toBe(15_000);
  expect(DEFAULT_PIPELINE_CONFIG.concurrency).toBe(3);
  expect(DEFAULT_PIPELINE_CONFIG.pagesPerContext).toBe(25);
  expect(DEFAULT_PIPELINE_CONFIG.probePagesPerContext).toBe(5);
  expect(DEFAULT_PIPELINE_CONFIG.maxProbeTemplates).toBe(25);
  expect(DEFAULT_PIPELINE_CONFIG.navModel).toBe("kimi-k2-turbo-preview");
  expect(DEFAULT_PIPELINE_CONFIG.rateLimitRpm).toBe(10);
});
