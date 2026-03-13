import type { Browser, BrowserContext } from "playwright";
import { installConsentBlocker } from "../analyzer/consent-blocker";
import { installResourceBlocker } from "../analyzer/resource-blocker";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class ProbeContextManager {
  private context: BrowserContext | null = null;
  private pagesSinceRecycle = 0;

  constructor(
    private readonly getBrowser: () => Promise<Browser>,
    private readonly pagesPerContext: number = 5,
  ) {}

  async get(): Promise<BrowserContext> {
    if (!this.context || this.pagesSinceRecycle >= this.pagesPerContext) {
      await this.close();
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
    this.pagesSinceRecycle++;
    return this.context;
  }

  async close(): Promise<void> {
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        /* already disconnected */
      }
    }
    this.context = null;
    this.pagesSinceRecycle = 0;
  }
}
