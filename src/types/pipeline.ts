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
  fingerprint: string;
  title: string;
  links: string[];
  elementCount: number;
  capabilities: PageCapabilities;
  lightIssues: Issue[];
  pageId: string;
  discoveryMethod: "standard" | "networkidle-retry" | "llm";
}

export type TestType =
  | "axe-full"
  | "interactive"
  | "reflow"
  | "text-spacing"
  | "resize-text"
  | "multimedia"
  | "timed-events"
  | "target-size"
  | "error-identification";

export interface TemplateCluster {
  id: string;
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
