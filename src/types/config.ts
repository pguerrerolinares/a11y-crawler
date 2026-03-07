// src/types/config.ts
import type { ImpactLevel } from "./issue.ts";

export interface CrawlConfig {
  /** Target base URL */
  baseUrl: string;
  /** Moonshot API key */
  apiKey: string;
  /** LLM model for navigation discovery (default: "kimi-k2-turbo-preview") */
  navModel: string;
  /** LLM model for issue enrichment, non-visual (default: "kimi-latest") */
  enrichModel: string;
  /** LLM model for visual issue enrichment (default: "kimi-k2.5") */
  enrichVisualModel: string;
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
  /** Max LLM requests per minute per client (default: 10) */
  rateLimitRpm: number;
}

export const DEFAULT_CONFIG: Omit<CrawlConfig, "baseUrl" | "apiKey"> = {
  navModel: "kimi-k2-turbo-preview",
  enrichModel: "kimi-latest",
  enrichVisualModel: "kimi-k2.5",
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
