export type UrlOrigin = "link" | "sitemap" | "interaction";

export class UrlQueue {
  private pending: Array<{ url: string; depth: number }> = [];
  private visited = new Set<string>();
  private discovered = new Map<string, UrlOrigin>();
  private depthMap = new Map<string, number>();
  private originCounts = { sitemap: 0, link: 0, interaction: 0 };

  constructor(
    private maxPages: number,
    private maxDepth: number = Infinity,
  ) {}

  seed(urls: string[], origin: UrlOrigin, depth: number = 0): void {
    for (const url of urls) {
      const normalized = this.normalize(url);
      if (normalized && !this.discovered.has(normalized)) {
        this.discovered.set(normalized, origin);
        this.depthMap.set(normalized, depth);
        this.originCounts[origin]++;
        this.pending.push({ url: normalized, depth });
      }
    }
  }

  next(): string | null {
    while (this.pending.length > 0) {
      const entry = this.pending.shift()!;
      if (
        !this.visited.has(entry.url) &&
        this.visited.size < this.maxPages &&
        entry.depth <= this.maxDepth
      ) {
        this.visited.add(entry.url);
        return entry.url;
      }
    }
    return null;
  }

  /** Get the depth of a visited URL (for seeding child URLs at depth+1). */
  getDepth(url: string): number {
    const normalized = this.normalize(url);
    return normalized ? (this.depthMap.get(normalized) ?? 0) : 0;
  }

  get stats() {
    return {
      totalDiscovered: this.discovered.size,
      totalVisited: this.visited.size,
      pendingCount: this.pending.filter((e) => !this.visited.has(e.url)).length,
      byOrigin: { ...this.originCounts },
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
