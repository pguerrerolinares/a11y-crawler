// Re-export for convenience
import type { ImpactLevel } from "./issue.ts";

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
  /** Moonshot API base URL (default: "https://api.moonshot.ai/v1") */
  apiBaseUrl: string;
  /** Max LLM requests per minute (default: 10) */
  rateLimitRpm: number;
}

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
  apiBaseUrl: "https://api.moonshot.ai/v1",
  rateLimitRpm: 10,
};
