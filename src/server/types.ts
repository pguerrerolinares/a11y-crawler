import { z } from "zod";

// Request schemas
export const CreateAuditSchema = z.object({
  url: z.url(),
  wcagLevel: z.enum(["A", "AA", "AAA"]).default("AA"),
  maxPages: z.number().int().min(1).max(500).default(100),
  maxDepth: z.number().int().min(1).max(10).default(5),
  concurrency: z.number().int().min(1).max(5).default(2),
  skipSitemap: z.boolean().default(false),
  noEnrich: z.boolean().default(false),
});

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const IssueFilterSchema = PaginationSchema.extend({
  impact: z.string().optional(),
  rule: z.string().optional(),
  category: z.string().optional(),
});

export const LogFilterSchema = PaginationSchema.extend({
  path: z.string().optional(),
  method: z.string().optional(),         // comma-separated: "GET,POST"
  status: z.string().refine(
    (v) => /^[1-5]xx$/.test(v) || /^\d{3}$/.test(v),
    { message: "status must be a 3-digit code or range like 2xx" }
  ).optional(),         // exact "404" or range "4xx"
  ip: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),  // ISO datetime
  to: z.string().datetime({ offset: true }).optional(),    // ISO datetime
  minDuration: z.coerce.number().optional(), // minimum ms
});

// Response types
export interface AuditResponse {
  id: string;
  url: string;
  config: Record<string, unknown> | null;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  summary: Record<string, unknown> | null;
  discovery: Record<string, unknown> | null;
  llmUsage: Record<string, unknown> | null;
}

export interface PageResponse {
  id: string;
  auditId: string;
  url: string;
  title: string | null;
  statusCode: number | null;
  issueCount: number;
  issuesByImpact: Record<string, number> | null;
  durationMs: number | null;
  createdAt: string;
}

export interface IssueResponse {
  id: string;
  pageId: string;
  auditId: string;
  rule: string;
  impact: string;
  description: string | null;
  help: string | null;
  helpUrl: string | null;
  wcagTags: string[];
  selector: string | null;
  html: string | null;
  xpath: string | null;
  checkSource: string;
  category: string | null;
  suggestedFix: string | null;
  fixConfidence: string | null;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// WebSocket event types
export interface WsEvent {
  type: "page_analyzed" | "progress" | "completed" | "error";
  data: Record<string, unknown>;
}
