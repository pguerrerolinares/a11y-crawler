export interface CrawlConfig {
  /** Target base URL */
  baseUrl: string;
  /** Moonshot API key */
  apiKey: string;
  /** LLM model for navigation discovery (default: "kimi-k2-turbo-preview") */
  navModel: string;
  /** Max pages to crawl (default: 50) */
  maxPages: number;
  /** Max crawl depth from seed (default: 5) */
  maxDepth: number;
  /** Per-page timeout in ms (default: 30000) */
  pageTimeout: number;
  /** WCAG conformance level (default: "AA") */
  wcagLevel: "A" | "AA" | "AAA";
  /** Skip sitemap.xml discovery (default: false) */
  skipSitemap: boolean;
  /** URL patterns to exclude (regex strings) */
  excludePatterns: string[];
  /** Moonshot API base URL (default: "https://api.moonshot.ai/v1") */
  apiBaseUrl: string;
  /** Max LLM requests per minute per client (default: 10) */
  rateLimitRpm: number;
  /** Max nav targets to interact with per page (default: 3) */
  maxNavTargets: number;
}

export const DEFAULT_CONFIG: Omit<CrawlConfig, "baseUrl" | "apiKey"> = {
  navModel: "kimi-k2-turbo-preview",
  maxPages: 50,
  maxDepth: 5,
  pageTimeout: 30000,
  wcagLevel: "AA",
  skipSitemap: false,
  excludePatterns: [],
  apiBaseUrl: "https://api.moonshot.ai/v1",
  rateLimitRpm: 10,
  maxNavTargets: 3,
};
