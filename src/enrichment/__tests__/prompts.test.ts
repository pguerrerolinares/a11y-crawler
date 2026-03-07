import { describe, test, expect } from "bun:test";
import { getPromptForCategory, parseFixes } from "../prompts.ts";

describe("getPromptForCategory", () => {
  test("returns structural prompt for structural category", () => {
    const prompt = getPromptForCategory("structural");
    expect(prompt).toContain("document structure");
  });

  test("returns interactive prompt for interactive category", () => {
    const prompt = getPromptForCategory("interactive");
    expect(prompt).toContain("interactive elements");
  });

  test("returns visual prompt for visual category", () => {
    const prompt = getPromptForCategory("visual");
    expect(prompt).toContain("visual presentation");
  });
});

describe("parseFixes", () => {
  test("parses valid JSON fix response", () => {
    const response = `[
      {"issueId": "axe-color-contrast-abc", "suggestedFix": "<p style='color: #333'>Text</p>"}
    ]`;
    const fixes = parseFixes(response);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].issueId).toBe("axe-color-contrast-abc");
  });

  test("returns empty array for invalid JSON", () => {
    expect(parseFixes("not json")).toEqual([]);
  });
});
