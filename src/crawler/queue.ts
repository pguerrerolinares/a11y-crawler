export type UrlOrigin = "link" | "sitemap" | "interaction";

export class UrlQueue {
  private pending: string[] = [];
  private visited = new Set<string>();
  private discovered = new Map<string, UrlOrigin>();

  constructor(private maxPages: number) {}

  seed(urls: string[], origin: UrlOrigin): void {
    for (const url of urls) {
      const normalized = this.normalize(url);
      if (normalized && !this.discovered.has(normalized)) {
        this.discovered.set(normalized, origin);
        this.pending.push(normalized);
      }
    }
  }

  next(): string | null {
    while (this.pending.length > 0) {
      const url = this.pending.shift()!;
      if (!this.visited.has(url) && this.visited.size < this.maxPages) {
        this.visited.add(url);
        return url;
      }
    }
    return null;
  }

  get stats() {
    return {
      totalDiscovered: this.discovered.size,
      totalVisited: this.visited.size,
      pendingCount: this.pending.filter((u) => !this.visited.has(u)).length,
      byOrigin: {
        sitemap: [...this.discovered.values()].filter((v) => v === "sitemap").length,
        link: [...this.discovered.values()].filter((v) => v === "link").length,
        interaction: [...this.discovered.values()].filter((v) => v === "interaction").length,
      },
    };
  }

  private normalize(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
        parsed.pathname = parsed.pathname.slice(0, -1);
      }
      parsed.hash = "";
      parsed.searchParams.sort();
      return parsed.href;
    } catch {
      return null;
    }
  }
}
