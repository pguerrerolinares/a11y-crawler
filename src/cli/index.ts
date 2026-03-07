// src/cli/index.ts
import { parseArgs } from "util";
import { audit } from "../orchestrator.ts";
import { writeReport } from "../reporter/json.ts";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: "string" },
      output: { type: "string", short: "o", default: "report.json" },
      "api-key": { type: "string" },
      "max-pages": { type: "string", default: "100" },
      "max-depth": { type: "string", default: "5" },
      "nav-model": { type: "string", default: "kimi-k2-turbo-preview" },
      "enrich-model": { type: "string", default: "kimi-latest" },
      "enrich-visual-model": { type: "string", default: "kimi-k2.5" },
      "api-base-url": { type: "string", default: "https://api.moonshot.ai/v1" },
      wcag: { type: "string", default: "AA" },
      concurrency: { type: "string", default: "3" },
      "no-sitemap": { type: "boolean", default: false },
      "no-enrich": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || !values.url) {
    console.log(`
a11y-crawler-v2 - AI-powered accessibility auditor

USAGE:
  bun run src/cli/index.ts --url <url> [options]

OPTIONS:
  --url <url>                   Target URL (required)
  --api-key <key>               LLM API key (or set LLM_API_KEY env var)
  --output, -o <file>           Output file (default: report.json)
  --max-pages <n>               Max pages to discover (default: 100)
  --max-depth <n>               Max crawl depth (default: 5)
  --nav-model <model>           Nav discovery model (default: kimi-k2-turbo-preview)
  --enrich-model <model>        Enrichment model (default: kimi-latest)
  --enrich-visual-model <model> Visual enrichment model (default: kimi-k2.5)
  --api-base-url <url>          LLM API base URL (default: https://api.moonshot.ai/v1)
  --wcag <level>                WCAG level: A, AA, AAA (default: AA)
  --concurrency <n>             Parallel pages (default: 3)
  --no-sitemap                  Skip sitemap discovery
  --no-enrich                   Skip LLM fix suggestions
  --help, -h                    Show help
    `);
    process.exit(values.help ? 0 : 1);
  }

  const apiKey = values["api-key"] || process.env.LLM_API_KEY;
  if (!apiKey) {
    console.error("Error: --api-key or LLM_API_KEY env var required");
    process.exit(1);
  }

  console.log(`\nA11y Crawler v2`);
  console.log(`Target: ${values.url}`);
  console.log(`WCAG Level: ${values.wcag}`);
  console.log(`Max Pages: ${values["max-pages"]}`);
  console.log(`Nav model: ${values["nav-model"]}`);
  console.log(`Enrich model: ${values["enrich-model"]} / ${values["enrich-visual-model"]} (visual)\n`);

  const report = await audit({
    baseUrl: values.url,
    apiKey,
    maxPages: parseInt(values["max-pages"]!, 10),
    maxDepth: parseInt(values["max-depth"]!, 10),
    navModel: values["nav-model"]!,
    enrichModel: values["enrich-model"]!,
    enrichVisualModel: values["enrich-visual-model"]!,
    apiBaseUrl: values["api-base-url"]!,
    wcagLevel: values.wcag as "A" | "AA" | "AAA",
    concurrency: parseInt(values.concurrency!, 10),
    skipSitemap: values["no-sitemap"]!,
    enrichImpactThreshold: values["no-enrich"] ? [] : ["critical", "serious"],
  });

  await writeReport(report, values.output!);

  console.log(`\n=== Results ===`);
  console.log(`Pages analyzed: ${report.summary.totalPages}`);
  console.log(`Total issues: ${report.summary.totalIssues}`);
  console.log(`  Critical: ${report.summary.issuesByImpact.critical}`);
  console.log(`  Serious:  ${report.summary.issuesByImpact.serious}`);
  console.log(`  Moderate: ${report.summary.issuesByImpact.moderate}`);
  console.log(`  Minor:    ${report.summary.issuesByImpact.minor}`);
  console.log(`Shared issues: ${report.sharedIssues.length}`);
  console.log(`Duration: ${report.meta.totalDurationSeconds}s`);
  console.log(`\nReport saved to: ${values.output}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
