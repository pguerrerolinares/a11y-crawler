import { test, expect, describe } from "bun:test";
import { renderPdf } from "../typst-renderer";

describe("renderPdf", () => {
  test("produces a valid PDF buffer from sample data", async () => {
    const sampleData = {
      meta: {
        baseUrl: "https://example.com",
        date: "2026-03-23",
        wcagLevel: "AA",
        toolVersions: { crawler: "2.0.0", axeCore: "4.10.0" },
        totalDurationSeconds: 68,
        detailLevel: "standard",
      },
      score: { value: 72, totalIssues: 45, totalPages: 10,
        issuesByImpact: { critical: 2, serious: 8, moderate: 20, minor: 15 } },
      complianceTable: [
        { criterion: "1.4.3", name: "Contrast (Minimum)", level: "AA", status: "fail", issueCount: 12 },
      ],
      categories: [],
      analyzedUrls: [{ url: "https://example.com/", issueCount: 15 }],
    };

    const buffer = await renderPdf(sampleData as any);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    // PDF magic bytes
    expect(buffer.slice(0, 5).toString()).toBe("%PDF-");
  }, 30000);
});
