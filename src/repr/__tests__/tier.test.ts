import { describe, test, expect } from "bun:test";
import { selectTier, truncateToTokenBudget } from "../tier.ts";

describe("selectTier", () => {
  test("selects aria-snapshot when nav nodes >= 3", () => {
    const ariaYaml = `- navigation "Main":
  - link "Home"
  - link "About"
  - button "Services"`;
    const prunedHtml = "";
    const result = selectTier(ariaYaml, prunedHtml);
    expect(result.tier).toBe("aria-snapshot");
    expect(result.content).toBe(ariaYaml);
  });

  test("falls back to pruned-html when aria is sparse", () => {
    const ariaYaml = `- banner:
  - img "Logo"`;
    const prunedHtml = `<nav><a href="/">Home</a><a href="/about">About Us</a><a href="/services">Services</a><a href="/contact">Contact</a></nav>`;
    const result = selectTier(ariaYaml, prunedHtml);
    expect(result.tier).toBe("pruned-html");
  });

  test("falls back to css-heuristic when both are empty", () => {
    const result = selectTier("", "");
    expect(result.tier).toBe("css-heuristic");
  });
});

describe("truncateToTokenBudget", () => {
  test("returns content unchanged when under budget", () => {
    const content = "hello world";
    expect(truncateToTokenBudget(content, 100)).toBe(content);
  });

  test("truncates content that exceeds budget", () => {
    const content = "a".repeat(4000); // ~1000 tokens
    const result = truncateToTokenBudget(content, 100); // max 100 tokens = 400 chars
    expect(result.length).toBeLessThanOrEqual(400 + " [truncated]".length);
    expect(result).toContain("[truncated]");
  });

  test("adds truncated marker", () => {
    const content = "a".repeat(800); // 200 tokens
    const result = truncateToTokenBudget(content, 50); // max 50 tokens = 200 chars
    expect(result).toContain("[truncated]");
  });
});

describe("selectTier token budget", () => {
  test("truncates aria-snapshot content exceeding 800 tokens", () => {
    const bigAria = `- navigation "Main":\n` + `  - link "item"\n`.repeat(200);
    const result = selectTier(bigAria, "");
    expect(result.tier).toBe("aria-snapshot");
    expect(result.content).toContain("[truncated]");
    expect(result.tokenEstimate).toBeLessThanOrEqual(830);
  });

  test("truncates pruned-html content exceeding 5000 tokens", () => {
    const bigHtml = "<nav>" + "<a href='/page'>link</a>".repeat(2000) + "</nav>";
    const result = selectTier("", bigHtml);
    expect(result.tier).toBe("pruned-html");
    expect(result.content).toContain("[truncated]");
  });
});
