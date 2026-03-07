import { describe, test, expect } from "bun:test";
import { formatElementList } from "../heuristic.ts";

describe("formatElementList", () => {
  test("formats links and buttons into readable list", () => {
    const elements = [
      { tag: "a", text: "Home", href: "/", selector: "a.nav-link" },
      { tag: "button", text: "Services", href: null, selector: "button#services" },
    ];
    const result = formatElementList(elements);
    expect(result).toContain("link: 'Home' -> /");
    expect(result).toContain("button: 'Services'");
  });

  test("handles empty list", () => {
    expect(formatElementList([])).toBe("");
  });
});
