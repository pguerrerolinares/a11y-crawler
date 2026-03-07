import { describe, test, expect } from "bun:test";
import { countNavNodes, removeDialogs } from "../aria.ts";

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

describe("removeDialogs", () => {
  test("removes top-level dialog block", () => {
    const yaml = `- dialog "Cookie consent":
  - button "Accept"
  - button "Reject"
- banner:
  - link "Home"
  - button "Menu"`;
    const result = removeDialogs(yaml);
    expect(result).not.toContain("dialog");
    expect(result).not.toContain("Cookie consent");
    expect(result).toContain("banner");
    expect(result).toContain("link");
  });

  test("keeps content when no dialog present", () => {
    const yaml = `- banner:
  - link "Home"
  - button "Menu"
- main:
  - heading "Welcome"`;
    expect(removeDialogs(yaml)).toBe(yaml);
  });

  test("removes multiple dialogs", () => {
    const yaml = `- dialog "First":
  - button "OK"
- dialog "Second":
  - button "Close"
- banner:
  - link "Home"`;
    const result = removeDialogs(yaml);
    expect(result).not.toContain("dialog");
    expect(result).toContain("banner");
  });

  test("handles empty string", () => {
    expect(removeDialogs("")).toBe("");
  });
});
