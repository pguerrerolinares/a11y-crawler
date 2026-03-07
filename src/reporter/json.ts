import type { SiteReport } from "../types/report.ts";

/**
 * Write the full report as JSON.
 */
export async function writeReport(
  report: SiteReport,
  outputPath: string,
): Promise<void> {
  const json = JSON.stringify(report, null, 2);
  await Bun.write(outputPath, json);
}
