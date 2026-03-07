import { describe, test, expect } from "bun:test";
import { parseSitemapXml } from "../sitemap.ts";

describe("parseSitemapXml", () => {
  test("extracts URLs from sitemap XML", () => {
    const xml = `<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/page1</loc></url>
      <url><loc>https://example.com/page2</loc></url>
    </urlset>`;
    expect(parseSitemapXml(xml)).toEqual([
      "https://example.com/page1",
      "https://example.com/page2",
    ]);
  });

  test("handles empty sitemap", () => {
    const xml = `<?xml version="1.0"?><urlset></urlset>`;
    expect(parseSitemapXml(xml)).toEqual([]);
  });

  test("handles whitespace in loc elements", () => {
    const xml = `<urlset><url><loc>
      https://example.com/page1
    </loc></url></urlset>`;
    expect(parseSitemapXml(xml)).toEqual(["https://example.com/page1"]);
  });
});
