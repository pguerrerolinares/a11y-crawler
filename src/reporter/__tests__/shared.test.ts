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
