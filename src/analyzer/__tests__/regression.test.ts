import { describe, test, expect } from "bun:test";
import { matchTemplatesAcrossAudits, computeRegressionDiff } from "../regression";

describe("matchTemplatesAcrossAudits", () => {
  test("matches by URL pattern (pass 1)", () => {
    const current = [
      { id: "c1", fingerprint: "aa", urlPattern: "/products/:slug", urls: ["https://x.com/products/a"], representative: "https://x.com/products/a" },
    ];
    const previous = [
      { id: "p1", fingerprint: "bb", urlPattern: "/products/:slug", urls: ["https://x.com/products/b"], representative: "https://x.com/products/b" },
    ];
    const matches = matchTemplatesAcrossAudits(current, previous);
    expect(matches.get("c1")).toBe("p1");
  });

  test("matches by near-fingerprint when URL pattern differs (pass 2)", () => {
    const current = [
      { id: "c1", fingerprint: "00000000000000ff", urlPattern: "/blog/:slug", urls: ["https://x.com/blog/a"], representative: "https://x.com/blog/a" },
    ];
    const previous = [
      { id: "p1", fingerprint: "000000000000007f", urlPattern: "/news/:slug", urls: ["https://x.com/news/b"], representative: "https://x.com/news/b" },
    ];
    const matches = matchTemplatesAcrossAudits(current, previous);
    // Hamming distance between ff (255) and 7f (127) = 1 bit, well within ≤ 12
    expect(matches.get("c1")).toBe("p1");
  });

  test("matches by representative URL overlap (pass 3)", () => {
    const current = [
      { id: "c1", fingerprint: "ffffffffffffffff", urlPattern: "/unique-pattern", urls: ["https://x.com/shared-page", "https://x.com/other"], representative: "https://x.com/shared-page" },
    ];
    const previous = [
      { id: "p1", fingerprint: "0000000000000000", urlPattern: "/different-pattern", urls: ["https://x.com/shared-page", "https://x.com/old-other"], representative: "https://x.com/shared-page" },
    ];
    const matches = matchTemplatesAcrossAudits(current, previous);
    expect(matches.get("c1")).toBe("p1");
  });

  test("returns empty map when no matches", () => {
    const current = [
      { id: "c1", fingerprint: "ffffffffffffffff", urlPattern: "/a", urls: ["https://x.com/a"], representative: "https://x.com/a" },
    ];
    const previous = [
      { id: "p1", fingerprint: "0000000000000000", urlPattern: "/z", urls: ["https://x.com/z"], representative: "https://x.com/z" },
    ];
    const matches = matchTemplatesAcrossAudits(current, previous);
    expect(matches.size).toBe(0);
  });
});

describe("computeRegressionDiff", () => {
  test("computes new and resolved issues for matched templates", () => {
    const matched = new Map([["c1", "p1"]]);
    const currentIssuesByTemplate = new Map([
      ["c1", [{ rule: "color-contrast", impact: "serious" }, { rule: "target-size", impact: "serious" }]],
    ]);
    const previousIssuesByTemplate = new Map([
      ["p1", [{ rule: "color-contrast", impact: "serious" }, { rule: "reflow", impact: "serious" }]],
    ]);
    const currentTemplates = [{ id: "c1", urlPattern: "/products/:slug" }];
    const previousTemplates = [{ id: "p1", urlPattern: "/products/:slug" }];

    const diff = computeRegressionDiff(
      matched,
      currentIssuesByTemplate,
      previousIssuesByTemplate,
      currentTemplates,
      previousTemplates,
      "prev-audit-id",
      "2026-03-12T00:00:00Z",
      85,
      90,
    );

    expect(diff.matched).toHaveLength(1);
    expect(diff.matched[0].newIssues).toEqual([{ rule: "target-size", impact: "serious", count: 1 }]);
    expect(diff.matched[0].resolvedIssues).toEqual([{ rule: "reflow", impact: "serious", count: 1 }]);
    expect(diff.scoreChange).toBe(-5); // 85 - 90
    expect(diff.summary.totalNewIssues).toBe(1);
    expect(diff.summary.totalResolvedIssues).toBe(1);
  });
});
