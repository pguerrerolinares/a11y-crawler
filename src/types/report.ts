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
