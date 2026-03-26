import type { Browser, BrowserContext, Page } from "playwright";
import { installConsentBlocker } from "../analyzer/consent-blocker";
import { installResourceBlocker } from "../analyzer/resource-blocker";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface PageLease {
  page: Page;
  release: () => Promise<void>;
}

export class ProbeContextManager {
  private context: BrowserContext | null = null;
  private pagesSinceRecycle = 0;
  private activePages = 0;

  constructor(
    private readonly getBrowser: () => Promise<Browser>,
    private readonly pagesPerContext: number = 5,
  ) {}

  /**
   * Lease a page from the managed context.
   * Returns { page, release } — caller MUST call release() when done.
   * Context recycling only happens when activePages === 0 AND pagesPerContext exceeded.
   */
  async lease(): Promise<PageLease> {
    // Only recycle when no active pages AND limit exceeded
    if (this.activePages === 0 && this.pagesSinceRecycle >= this.pagesPerContext) {
      await this.recycleContext();
    }

    const context = await this.getOrCreateContext();
    const page = await context.newPage();
    this.activePages++;
    this.pagesSinceRecycle++;

    let released = false;
    return {
      page,
      release: async () => {
        if (released) return; // Idempotent — safe to call multiple times
        released = true;
        try { await page.close(); } catch { /* already closed */ }
        this.activePages = Math.max(0, this.activePages - 1);
      },
    };
  }

  // NOTE: Legacy get() removed. All callers must use lease().
  // This prevents mixed get()/lease() usage which could recycle
  // the context while leased pages are still active.

  async close(): Promise<void> {
    if (this.context) {
      try { await this.context.close(); } catch { /* already disconnected */ }
    }
    this.context = null;
    this.pagesSinceRecycle = 0;
    this.activePages = 0;
  }

  private async getOrCreateContext(): Promise<BrowserContext> {
    if (!this.context) {
      const browser = await this.getBrowser();
      this.context = await browser.newContext({
        userAgent: CHROME_UA,
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      await installConsentBlocker(this.context);
      await installResourceBlocker(this.context, "probe");
      this.pagesSinceRecycle = 0;
    }
    return this.context;
  }

  private async recycleContext(): Promise<void> {
    if (this.context) {
      try { await this.context.close(); } catch { /* already disconnected */ }
    }
    this.context = null;
    this.pagesSinceRecycle = 0;
  }
}
