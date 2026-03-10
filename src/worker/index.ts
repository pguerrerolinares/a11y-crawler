import { chromium } from "playwright";
import { initWorkerDb, claimNextAudit, markAuditFailed } from "./db.ts";
import { runAudit } from "./audit.ts";
import type { Browser } from "playwright";

const POLL_INTERVAL_MS = 5000;
const BROWSERLESS_URL = process.env.BROWSERLESS_URL || "ws://browserless:3000/chromium/playwright";
const MAX_RETRIES = 5;

async function connectWithRetry(url: string): Promise<Browser> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const browser = await chromium.connect(url);
      console.log(`Connected to Browserless at ${url}`);
      return browser;
    } catch (err) {
      const waitMs = Math.pow(2, attempt) * 1000;
      console.warn(
        `Browserless connection failed (attempt ${attempt + 1}/${MAX_RETRIES}):`,
        err instanceof Error ? err.message : err,
      );
      if (attempt < MAX_RETRIES - 1) {
        console.log(`Retrying in ${waitMs}ms...`);
        await Bun.sleep(waitMs);
      }
    }
  }
  throw new Error(`Failed to connect to Browserless at ${url} after ${MAX_RETRIES} attempts`);
}

async function main() {
  console.log("=== A11y Crawler Worker ===");

  // Initialize DB
  initWorkerDb();
  console.log("Database connected");

  // Connect to Browserless
  let browser = await connectWithRetry(BROWSERLESS_URL);

  // Reconnect on disconnect
  browser.on("disconnected", async () => {
    console.warn("Browserless disconnected, reconnecting...");
    try {
      browser = await connectWithRetry(BROWSERLESS_URL);
    } catch (err) {
      console.error("Failed to reconnect to Browserless:", err);
      process.exit(1);
    }
  });

  // Graceful shutdown
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log("\nShutting down worker...");
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("Worker ready. Polling for audits...\n");

  // Main loop
  while (!stopping) {
    try {
      const audit = await claimNextAudit();

      if (!audit) {
        await Bun.sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(`\n${"=".repeat(60)}`);
      console.log(`Starting audit ${audit.id}: ${audit.url}`);
      console.log(`${"=".repeat(60)}\n`);

      try {
        await runAudit(browser, audit.id, {
          baseUrl: audit.url,
          ...audit.config,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Audit ${audit.id} failed:`, message);
        await markAuditFailed(audit.id, message);
      }

    } catch (err) {
      // DB polling error — log and continue
      console.error("Worker loop error:", err instanceof Error ? err.message : err);
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  // Cleanup
  await browser.close();
  console.log("Worker stopped gracefully");
  process.exit(0);
}

main().catch((err) => {
  console.error("Worker fatal error:", err);
  process.exit(1);
});
