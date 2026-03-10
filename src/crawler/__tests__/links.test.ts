import { test, expect, describe } from "bun:test";
import { filterLinks } from "../links.ts";

describe("filterLinks", () => {
  const baseOrigin = "https://example.com";

  test("keeps same-origin links", () => {
    const links = ["https://example.com/about", "https://example.com/contact"];
    expect(filterLinks(links, baseOrigin)).toEqual(links);
  });

  test("rejects cross-origin links", () => {
    const links = ["https://other.com/page", "https://example.com/about"];
    expect(filterLinks(links, baseOrigin)).toEqual(["https://example.com/about"]);
  });

  test("rejects blacklisted URLs (files, mailto, etc.)", () => {
    const links = [
      "https://example.com/file.pdf",
      "https://example.com/image.jpg",
      "mailto:test@example.com",
      "https://example.com/valid-page",
    ];
    expect(filterLinks(links, baseOrigin)).toEqual(["https://example.com/valid-page"]);
  });

  test("rejects invalid URLs gracefully", () => {
    const links = ["not-a-url", "", "https://example.com/valid"];
    expect(filterLinks(links, baseOrigin)).toEqual(["https://example.com/valid"]);
  });

  test("handles empty array", () => {
    expect(filterLinks([], baseOrigin)).toEqual([]);
  });
});
