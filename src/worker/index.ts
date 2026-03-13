import { chromium } from "playwright";
import { initWorkerDb, claimNextAudit, markAuditFailed } from "./db.ts";
import { runPipeline } from "./pipeline";
import { LLMClient } from "../llm/client";
import type { Browser } from "playwright";

const POLL_INTERVAL_MS = 5000;
const BROWSERLESS_URL = process.env.BROWSERLESS_URL;
const MAX_RETRIES = 5;

async function launchBrowser(): Promise<Browser> {
  if (!BROWSERLESS_URL) {
    // Local dev: launch Chromium directly
    const browser = await chromium.launch({ headless: true });
    console.log("Launched local Chromium");
    return browser;
  }

  // Production: connect to Browserless with retry
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const browser = await chromium.connect(BROWSERLESS_URL);
      console.log(`Connected to Browserless at ${BROWSERLESS_URL}`);
      return browser;
    } catch (err) {
      const waitMs = Math.pow(2, attempt) * 1000;
      console.warn(
        `Browserless connection failed (attempt ${attempt + 1}/${MAX_RETRIES}):`,
        err instanceof Error ? err.message : err,
      );
      if (attempt < MAX_RETRIES - 1) {
        console.log(`Retrying in ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }
  throw new Error(`Failed to connect to Browserless at ${BROWSERLESS_URL} after ${MAX_RETRIES} attempts`);
}

async function main() {
  console.log("=== A11y Crawler Worker ===");

  // Initialize DB (runs migrations if needed)
  await initWorkerDb();
  console.log("Database connected");

  // Launch browser (local Chromium or remote Browserless)
  let browser = await launchBrowser();

  // Reconnect on disconnect
  browser.on("disconnected", async () => {
    console.warn("Browser disconnected, reconnecting...");
    try {
      browser = await launchBrowser();
    } catch (err) {
      console.error("Failed to reconnect browser:", err);
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
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      console.log(`\n${"=".repeat(60)}`);
      console.log(`Starting audit ${audit.id}: ${audit.url}`);
      console.log(`${"=".repeat(60)}\n`);

      try {
        const getBrowser = async () => {
          if (!browser.isConnected()) {
            console.warn("Browser not connected, reconnecting...");
            browser = await launchBrowser();
          }
          return browser;
        };
        const llmClient = process.env.LLM_API_KEY
          ? new LLMClient({
              apiKey: process.env.LLM_API_KEY,
              baseUrl: process.env.LLM_BASE_URL ?? "https://api.moonshot.ai/v1",
              model: process.env.LLM_MODEL ?? "kimi-k2-turbo-preview",
              rateLimitRpm: 10,
            })
          : null;
        await runPipeline(getBrowser, audit.id, {
          baseUrl: audit.url,
          maxPages: audit.config?.maxPages as number | undefined,
          maxDepth: audit.config?.maxDepth as number | undefined,
          wcagLevel: audit.config?.wcagLevel as "A" | "AA" | "AAA" | undefined,
        }, llmClient);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Audit ${audit.id} failed:`, message);
        await markAuditFailed(audit.id, message);
      }

    } catch (err) {
      // DB polling error — log and continue
      console.error("Worker loop error:", err instanceof Error ? err.message : err);
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
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
