export interface CrawlEvent {
  type: "page_analyzed" | "progress" | "error" | "completed";
  data: Record<string, unknown>;
}

export type ProgressCallback = (event: CrawlEvent) => void | Promise<void>;
