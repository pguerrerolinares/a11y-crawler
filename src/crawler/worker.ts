import { SQL } from "bun";
import { audit } from "../orchestrator.ts";
import { writeReportToPostgres } from "../reporter/postgres.ts";
import type { ProgressCallback } from "../types/events.ts";

const auditId = process.argv[2];
const configJson = process.argv[3];

if (!auditId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(auditId)) {
  console.error("Invalid or missing audit ID (expected UUID)");
  process.exit(1);
}

if (!auditId || !configJson) {
  console.error("Usage: bun run src/crawler/worker.ts <auditId> <configJson>");
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = new SQL(dbUrl);

const rawConfig = JSON.parse(configJson);
const crawlConfig = {
  baseUrl: rawConfig.url,
  apiKey: process.env.LLM_API_KEY || "",
  apiBaseUrl: process.env.LLM_API_BASE_URL || "https://api.moonshot.ai/v1",
  wcagLevel: rawConfig.wcagLevel || "AA",
  maxPages: rawConfig.maxPages || 100,
  maxDepth: rawConfig.maxDepth || 5,
  concurrency: rawConfig.concurrency || 2,
  skipSitemap: rawConfig.skipSitemap || false,
} as const;

await db`UPDATE audits SET status = 'running', started_at = NOW() WHERE id = ${auditId}`;

const onProgress: ProgressCallback = async (event) => {
  await db`
    INSERT INTO audit_events (audit_id, event_type, data)
    VALUES (${auditId}, ${event.type}, ${event.data})
  `;
  await db`SELECT pg_notify('audit_progress', ${auditId})`;
};

try {
  const report = await audit(crawlConfig, onProgress);
  await writeReportToPostgres(db, auditId, report);
  console.log(`Audit ${auditId} completed: ${report.summary.totalPages} pages, ${report.summary.totalIssues} issues`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await db`UPDATE audits SET status = 'failed', finished_at = NOW(), error = ${message} WHERE id = ${auditId}`;
  console.error(`Audit ${auditId} failed: ${message}`);
  process.exit(1);
} finally {
  process.exit(0);
}
