export interface CreateAuditRequest {
  url: string;
  wcagLevel?: "A" | "AA" | "AAA";
  maxPages?: number;
  maxDepth?: number;
  concurrency?: number;
  skipSitemap?: boolean;
  noEnrich?: boolean;
}

export interface RegressionDiff {
  previousAuditId: string;
  previousAuditDate: string;
  matched: Array<{
    currentTemplateId: string;
    previousTemplateId: string;
    matchMethod: "url-pattern" | "fingerprint-near" | "representative-url";
    newIssues: Array<{ rule: string; impact: string; count: number }>;
    resolvedIssues: Array<{ rule: string; impact: string; count: number }>;
  }>;
  unmatchedNew: string[];
  unmatchedRemoved: string[];
  scoreChange: number | null;
  summary: {
    totalNewIssues: number;
    totalResolvedIssues: number;
    newTemplates: number;
    removedTemplates: number;
  };
}

export interface AuditResponse {
  id: string;
  url: string;
  config: Record<string, unknown> | null;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  summary: { totalIssues?: number; totalPages?: number; issuesByImpact?: Record<string, number> } | null;
  discovery: Record<string, unknown> | null;
  llmUsage: Record<string, unknown> | null;
  wcagScore: number | null;
  durationSeconds: number | null;
  crawlErrors: Array<{ url: string; phase: string; message: string; timestamp: string }> | null;
  templateClusters: unknown[] | null;
  regression: RegressionDiff | null;
  detectedRules?: string[];
}

export interface PageResponse {
  id: string;
  auditId: string;
  url: string;
  title: string | null;
  issueCount: number;
  issuesByImpact: Record<string, number> | null;
  durationMs: number | null;
  createdAt: string;
}

export interface IssueResponse {
  id: string;
  pageId: string;
  auditId: string;
  pageUrl: string | null;
  rule: string;
  impact: string;
  description: string | null;
  help: string | null;
  helpUrl: string | null;
  selector: string | null;
  html: string | null;
  category: string | null;
  suggestedFix: string | null;
  checkSource: string;
  wcagTags?: string[];
  llmConfidence: string | null;
  wcagCriterion: string | null;
  createdAt: string;
}

export interface SharedIssueResponse {
  rule: string;
  impact: string;
  pageCount: number;
  pageUrls: string[];
  suggestedFix: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface LogEntry {
  id: number;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip: string;
  responseSize: number | null;
  contentType: string | null;
  createdAt: string;
  hasQueryParams: boolean;
  hasRequestBody: boolean;
  hasResponseBody: boolean;
}

export interface LogDetail extends LogEntry {
  userAgent: string | null;
  requestBody: Record<string, unknown> | null;
  responseBody: string | null;
  queryParams: Record<string, string> | null;
  error: string | null;
}

const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  audits: {
    list: (params?: string) => request<PaginatedResponse<AuditResponse>>(`/audits${params ? `?${params}` : ""}`),
    get: (id: string) => request<AuditResponse>(`/audits/${id}`),
    create: (body: CreateAuditRequest) => request<AuditResponse>("/audits", { method: "POST", body: JSON.stringify(body) }),
    delete: (id: string) => request<void>(`/audits/${id}`, { method: "DELETE" }),
  },
  pages: {
    list: (auditId: string, params?: string) => request<PaginatedResponse<PageResponse>>(`/audits/${auditId}/pages${params ? `?${params}` : ""}`),
    get: (id: string) => request<PageResponse>(`/pages/${id}`),
  },
  issues: {
    byAudit: (auditId: string, params?: string) => request<PaginatedResponse<IssueResponse>>(`/audits/${auditId}/issues${params ? `?${params}` : ""}`),
    byPage: (pageId: string, params?: string) => request<PaginatedResponse<IssueResponse>>(`/pages/${pageId}/issues${params ? `?${params}` : ""}`),
    shared: (auditId: string) => request<{ data: SharedIssueResponse[] }>(`/audits/${auditId}/shared`),
  },
  logs: {
    list: (params?: string) => request<PaginatedResponse<LogEntry>>(`/logs${params ? `?${params}` : ""}`),
    get: (id: number) => request<LogDetail>(`/logs/${id}`),
  },
};
