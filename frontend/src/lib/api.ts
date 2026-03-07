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
    list: (params?: string) => request<any>(`/audits${params ? `?${params}` : ""}`),
    get: (id: string) => request<any>(`/audits/${id}`),
    create: (body: any) => request<any>("/audits", { method: "POST", body: JSON.stringify(body) }),
    delete: (id: string) => request<void>(`/audits/${id}`, { method: "DELETE" }),
  },
  pages: {
    list: (auditId: string, params?: string) => request<any>(`/audits/${auditId}/pages${params ? `?${params}` : ""}`),
    get: (id: string) => request<any>(`/pages/${id}`),
  },
  issues: {
    byAudit: (auditId: string, params?: string) => request<any>(`/audits/${auditId}/issues${params ? `?${params}` : ""}`),
    byPage: (pageId: string, params?: string) => request<any>(`/pages/${pageId}/issues${params ? `?${params}` : ""}`),
    shared: (auditId: string) => request<any>(`/audits/${auditId}/shared`),
  },
  logs: {
    list: (params?: string) => request<any>(`/logs${params ? `?${params}` : ""}`),
  },
};
