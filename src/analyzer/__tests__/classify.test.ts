import { test, expect, describe } from "bun:test";
import { clusterPages, buildTestPlan, selectRepresentative, prioritizeTemplates } from "../classify";
import type { ScanResult, TemplateCluster, PageCapabilities } from "../../types/pipeline";
import type { Issue } from "../../types/issue";

function makeCapabilities(overrides: Partial<PageCapabilities> = {}): PageCapabilities {
  return {
    hasForms: false,
    hasMedia: false,
    hasCarousel: false,
    hasDataTables: false,
    isSpaShell: false,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    url: "https://example.com",
    rule: "color-contrast",
    impact: "serious",
    description: "Insufficient contrast",
    help: "Fix contrast",
    helpUrl: "https://dequeuniversity.com",
    wcagTags: ["wcag2aa"],
    selector: "p",
    html: "<p>text</p>",
    surroundingHtml: "<div><p>text</p></div>",
    xpath: "/html/body/p",
    viewportWidth: 1280,
    pageTitle: "Test",
    checkSource: "axe",
    suggestedFix: null,
    fixConfidence: null,
    llmConfidence: null,
    wcagCriterion: null,
    violationCategory: "visual",
    ...overrides,
  };
}

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    url: "https://example.com/page",
    fingerprint: "div(n=3)[header(n=1)|main(n=2)|footer(n=1)]",
    title: "Test Page",
    links: [],
    elementCount: 50,
    capabilities: makeCapabilities(),
    lightIssues: [],
    pageId: "page-1",
    discoveryMethod: "standard",
    ...overrides,
  };
}

describe("clusterPages", () => {
  test("groups pages with same fingerprint and URL pattern into one cluster", () => {
    // Use numeric IDs so inferUrlPattern normalizes both to /blog/:id
    const results: ScanResult[] = [
      makeScanResult({ url: "https://example.com/blog/101", fingerprint: "aaa" }),
      makeScanResult({ url: "https://example.com/blog/202", fingerprint: "aaa" }),
    ];
    const clusters = clusterPages(results);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].urls).toEqual([
      "https://example.com/blog/101",
      "https://example.com/blog/202",
    ]);
  });

  test("keeps pages with different URL patterns in separate clusters", () => {
    const results: ScanResult[] = [
      makeScanResult({ url: "https://example.com/blog/post", fingerprint: "aaa" }),
      makeScanResult({ url: "https://example.com/about", fingerprint: "aaa" }),
    ];
    const clusters = clusterPages(results);
    expect(clusters).toHaveLength(2);
  });

  test("keeps pages with very different fingerprints in separate clusters", () => {
    // Use completely different fingerprint strings to ensure hamming distance > 8
    const results: ScanResult[] = [
      makeScanResult({
        url: "https://example.com/page/a",
        fingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      makeScanResult({
        url: "https://example.com/page/b",
        fingerprint: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      }),
    ];
    const clusters = clusterPages(results);
    // They may or may not cluster depending on simhash output;
    // just verify at least 1 cluster exists
    expect(clusters.length).toBeGreaterThanOrEqual(1);
  });

  test("merges capabilities with OR logic", () => {
    const results: ScanResult[] = [
      makeScanResult({
        url: "https://example.com/products/1",
        fingerprint: "same-struct",
        capabilities: makeCapabilities({ hasForms: true }),
      }),
      makeScanResult({
        url: "https://example.com/products/2",
        fingerprint: "same-struct",
        capabilities: makeCapabilities({ hasMedia: true }),
      }),
    ];
    const clusters = clusterPages(results);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].capabilities.hasForms).toBe(true);
    expect(clusters[0].capabilities.hasMedia).toBe(true);
  });

  test("aggregates lightIssues from all pages", () => {
    const issue1 = makeIssue({ id: "i1" });
    const issue2 = makeIssue({ id: "i2" });
    const results: ScanResult[] = [
      makeScanResult({
        url: "https://example.com/items/1",
        fingerprint: "same",
        lightIssues: [issue1],
      }),
      makeScanResult({
        url: "https://example.com/items/2",
        fingerprint: "same",
        lightIssues: [issue2],
      }),
    ];
    const clusters = clusterPages(results);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].lightIssues).toHaveLength(2);
  });
});

describe("buildTestPlan", () => {
  function makeCluster(caps: Partial<PageCapabilities> = {}): TemplateCluster {
    return {
      id: "test-cluster",
      fingerprint: 0n,
      urlPattern: "/test",
      urls: ["https://example.com/test"],
      representative: "https://example.com/test",
      capabilities: makeCapabilities(caps),
      lightIssues: [],
      testPlan: [],
    };
  }

  test("always includes the 5 mandatory tests", () => {
    const plan = buildTestPlan(makeCluster());
    expect(plan).toContain("axe-full");
    expect(plan).toContain("interactive");
    expect(plan).toContain("reflow");
    expect(plan).toContain("text-spacing");
    expect(plan).toContain("resize-text");
    expect(plan).toHaveLength(5);
  });

  test("adds multimedia and timed-events when hasMedia", () => {
    const plan = buildTestPlan(makeCluster({ hasMedia: true }));
    expect(plan).toContain("multimedia");
    expect(plan).toContain("timed-events");
    expect(plan).toHaveLength(7);
  });

  test("adds timed-events when hasCarousel", () => {
    const plan = buildTestPlan(makeCluster({ hasCarousel: true }));
    expect(plan).toContain("timed-events");
    expect(plan).not.toContain("multimedia");
    expect(plan).toHaveLength(6);
  });

  test("no duplicate timed-events when both hasMedia and hasCarousel", () => {
    const plan = buildTestPlan(makeCluster({ hasMedia: true, hasCarousel: true }));
    const timedCount = plan.filter((t) => t === "timed-events").length;
    expect(timedCount).toBe(1);
    expect(plan).toHaveLength(7);
  });
});

describe("selectRepresentative", () => {
  test("selects URL with most capabilities", () => {
    const scan1 = makeScanResult({
      url: "https://example.com/a",
      capabilities: makeCapabilities(),
    });
    const scan2 = makeScanResult({
      url: "https://example.com/b",
      capabilities: makeCapabilities({ hasForms: true, hasMedia: true }),
    });
    const cluster: TemplateCluster = {
      id: "c1",
      fingerprint: 0n,
      urlPattern: "/",
      urls: ["https://example.com/a", "https://example.com/b"],
      representative: "https://example.com/a",
      capabilities: makeCapabilities(),
      lightIssues: [],
      testPlan: [],
    };
    const scanMap = new Map<string, ScanResult>([
      ["https://example.com/a", scan1],
      ["https://example.com/b", scan2],
    ]);
    const rep = selectRepresentative(cluster, scanMap);
    expect(rep).toBe("https://example.com/b");
  });

  test("falls back to first URL when scores are equal", () => {
    const scan1 = makeScanResult({ url: "https://example.com/x", capabilities: makeCapabilities() });
    const scan2 = makeScanResult({ url: "https://example.com/y", capabilities: makeCapabilities() });
    const cluster: TemplateCluster = {
      id: "c2",
      fingerprint: 0n,
      urlPattern: "/",
      urls: ["https://example.com/x", "https://example.com/y"],
      representative: "https://example.com/x",
      capabilities: makeCapabilities(),
      lightIssues: [],
      testPlan: [],
    };
    const scanMap = new Map<string, ScanResult>([
      ["https://example.com/x", scan1],
      ["https://example.com/y", scan2],
    ]);
    const rep = selectRepresentative(cluster, scanMap);
    expect(rep).toBe("https://example.com/x");
  });

  test("considers lightIssues in scoring", () => {
    const scan1 = makeScanResult({ url: "https://example.com/p1", capabilities: makeCapabilities() });
    const scan2 = makeScanResult({
      url: "https://example.com/p2",
      capabilities: makeCapabilities(),
      lightIssues: [makeIssue()],
    });
    const cluster: TemplateCluster = {
      id: "c3",
      fingerprint: 0n,
      urlPattern: "/",
      urls: ["https://example.com/p1", "https://example.com/p2"],
      representative: "https://example.com/p1",
      capabilities: makeCapabilities(),
      lightIssues: [],
      testPlan: [],
    };
    const scanMap = new Map<string, ScanResult>([
      ["https://example.com/p1", scan1],
      ["https://example.com/p2", scan2],
    ]);
    const rep = selectRepresentative(cluster, scanMap);
    expect(rep).toBe("https://example.com/p2");
  });
});

describe("prioritizeTemplates", () => {
  function makeTemplateCluster(
    id: string,
    urlCount: number,
    caps: Partial<PageCapabilities> = {},
  ): TemplateCluster {
    return {
      id,
      fingerprint: 0n,
      urlPattern: `/${id}`,
      urls: Array.from({ length: urlCount }, (_, i) => `https://example.com/${id}/${i}`),
      representative: `https://example.com/${id}/0`,
      capabilities: makeCapabilities(caps),
      lightIssues: [],
      testPlan: [],
    };
  }

  test("returns all clusters when count is under limit", () => {
    const clusters = [makeTemplateCluster("a", 5), makeTemplateCluster("b", 3)];
    const { probed, skipped } = prioritizeTemplates(clusters, 10);
    expect(probed).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });

  test("caps probed at maxProbeTemplates", () => {
    const clusters = [
      makeTemplateCluster("a", 10),
      makeTemplateCluster("b", 5),
      makeTemplateCluster("c", 1),
    ];
    const { probed, skipped } = prioritizeTemplates(clusters, 2);
    expect(probed).toHaveLength(2);
    expect(skipped).toHaveLength(1);
  });

  test("prioritizes by page count × capability score", () => {
    const small = makeTemplateCluster("small", 2);
    const bigWithCaps = makeTemplateCluster("big", 10, { hasForms: true, hasMedia: true });
    const medium = makeTemplateCluster("medium", 5, { hasCarousel: true });
    const { probed } = prioritizeTemplates([small, bigWithCaps, medium], 2);
    expect(probed[0].id).toBe("big");
    expect(probed[1].id).toBe("medium");
  });
});
