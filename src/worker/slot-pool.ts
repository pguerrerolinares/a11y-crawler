import type { Browser, BrowserContext } from "playwright";
import { installConsentBlocker } from "../analyzer/consent-blocker";
import { installResourceBlocker } from "../analyzer/resource-blocker";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class ContextSlot {
  private context: BrowserContext | null = null;
  private pagesSinceRecycle = 0;

  constructor(private readonly pagesPerContext: number = 25) {}

  async get(
    getBrowser: () => Promise<Browser>,
    phase: "scan" | "probe",
  ): Promise<BrowserContext> {
    const browser = await getBrowser();
    if (!browser.isConnected()) {
      this.context = null;
    }
    if (!this.context || this.pagesSinceRecycle >= this.pagesPerContext) {
      if (this.context) {
        try { await this.context.close(); } catch { /* disconnected */ }
        if (typeof Bun !== 'undefined') Bun.gc(false);
      }
      const freshBrowser = await getBrowser();
      this.context = await freshBrowser.newContext({
        userAgent: CHROME_UA,
        viewport: { width: 1280, height: 720 },
        locale: "en-US",
      });
      await installConsentBlocker(this.context);
      await installResourceBlocker(this.context, phase);
      this.pagesSinceRecycle = 0;
    }
    this.pagesSinceRecycle++;
    return this.context;
  }

  async close(): Promise<void> {
    if (this.context) {
      try { await this.context.close(); } catch { /* disconnected */ }
    }
    this.context = null;
    this.pagesSinceRecycle = 0;
  }
}

export class SlotPool {
  private available: ContextSlot[];
  private waiting: Array<(slot: ContextSlot) => void> = [];

  constructor(size: number, pagesPerContext = 25) {
    this.available = Array.from(
      { length: size },
      () => new ContextSlot(pagesPerContext),
    );
  }

  async acquire(): Promise<ContextSlot> {
    const slot = this.available.pop();
    if (slot) return slot;
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(slot: ContextSlot): void {
    const next = this.waiting.shift();
    if (next) { next(slot); } else { this.available.push(slot); }
  }

  async closeAll(): Promise<void> {
    for (const slot of this.available) { await slot.close(); }
  }
}
