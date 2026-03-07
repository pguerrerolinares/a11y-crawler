import { describe, test, expect } from "bun:test";
import { parseNavTargets, buildNavPrompt } from "../nav.ts";

describe("parseNavTargets", () => {
  test("parses valid JSON response", () => {
    const response = `[
      {"selector": "button#menu", "description": "Main menu toggle", "expectedBehavior": "expand", "confidence": 0.9},
      {"selector": "a.dropdown", "description": "Services dropdown", "expectedBehavior": "reveal", "confidence": 0.8}
    ]`;
    const targets = parseNavTargets(response);
    expect(targets).toHaveLength(2);
    expect(targets[0].selector).toBe("button#menu");
    expect(targets[0].expectedBehavior).toBe("expand");
  });

  test("returns empty array for invalid JSON", () => {
    expect(parseNavTargets("not json")).toEqual([]);
    expect(parseNavTargets("")).toEqual([]);
  });

  test("filters out targets with confidence < 0.5", () => {
    const response = `[
      {"selector": "a.link", "description": "Low conf", "expectedBehavior": "navigate", "confidence": 0.3}
    ]`;
    expect(parseNavTargets(response)).toEqual([]);
  });

  test("limits to 10 targets max", () => {
    const targets = Array.from({ length: 15 }, (_, i) => ({
      selector: `a#link-${i}`,
      description: `Link ${i}`,
      expectedBehavior: "navigate",
      confidence: 0.9,
    }));
    const result = parseNavTargets(JSON.stringify(targets));
    expect(result).toHaveLength(10);
  });
});

describe("buildNavPrompt", () => {
  test("includes URL and representation content", () => {
    const prompt = buildNavPrompt("https://example.com", "Example", {
      tier: "aria-snapshot",
      content: "- navigation:\n  - link 'Home'",
      tokenEstimate: 20,
      tierReason: "test",
    });
    expect(prompt.user).toContain("https://example.com");
    expect(prompt.user).toContain("aria-snapshot");
    expect(prompt.user).toContain("- navigation:");
  });
});
