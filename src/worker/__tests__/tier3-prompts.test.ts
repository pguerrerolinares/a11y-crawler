import { test, expect } from "bun:test";
import { TIER3_PROMPTS, renderPrompt, parseTier3Response } from "../tier3-prompts";

test("renderPrompt substitutes elements placeholder", () => {
  const result = renderPrompt("color-use-link", "[Image 1] Navigation link in header");
  expect(result).toContain("[Image 1] Navigation link in header");
  expect(result).not.toContain("{{elements}}");
});

test("parseTier3Response parses valid JSON array", () => {
  const json = JSON.stringify([
    { element: 1, hasViolation: true, confidence: "high", reasoning: "No underline visible" }
  ]);
  const results = parseTier3Response(json);
  expect(results.length).toBe(1);
  expect(results[0].hasViolation).toBe(true);
  expect(results[0].confidence).toBe("high");
});

test("parseTier3Response handles malformed JSON gracefully", () => {
  const results = parseTier3Response("not valid json");
  expect(results).toEqual([]);
});
