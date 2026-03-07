import { describe, test, expect } from "bun:test";
import { selectTier } from "../tier.ts";

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
