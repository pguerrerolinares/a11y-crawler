import { describe, test, expect } from "bun:test";
import { countNavNodes } from "../aria.ts";

describe("countNavNodes", () => {
  test("counts navigation-related lines in ARIA YAML", () => {
    const yaml = `- navigation "Main Menu":
  - link "Home"
  - button "Services" [expanded=false]
  - link "About Us"
  - link "Contact"
- contentinfo "Footer":
  - link "Privacy"`;
    expect(countNavNodes(yaml)).toBe(6); // nav, 4 links (incl. footer), 1 button
  });

  test("returns 0 for empty content", () => {
    expect(countNavNodes("")).toBe(0);
  });

  test("counts buttons and links without navigation parent", () => {
    const yaml = `- banner:
  - link "Logo"
  - button "Menu"`;
    expect(countNavNodes(yaml)).toBe(2);
  });
});
