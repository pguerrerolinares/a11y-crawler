import { describe, test, expect } from "bun:test";
import { stripHtmlNoise } from "../pruned-html.ts";

describe("stripHtmlNoise", () => {
  test("removes script tags", () => {
    const html = `<nav><a href="/">Home</a><script>alert(1)</script></nav>`;
    expect(stripHtmlNoise(html)).not.toContain("<script>");
    expect(stripHtmlNoise(html)).toContain('<a href="/">Home</a>');
  });

  test("removes style tags", () => {
    const html = `<nav><style>.foo{color:red}</style><a href="/">Home</a></nav>`;
    expect(stripHtmlNoise(html)).not.toContain("<style>");
  });

  test("removes data-* attributes except data-testid", () => {
    const html = `<a href="/" data-analytics="click" data-testid="home">Home</a>`;
    const result = stripHtmlNoise(html);
    expect(result).not.toContain("data-analytics");
    expect(result).toContain("data-testid");
  });

  test("removes inline styles", () => {
    const html = `<a href="/" style="color: red; font-size: 14px">Home</a>`;
    expect(stripHtmlNoise(html)).not.toContain("style=");
  });

  test("removes SVG content", () => {
    const html = `<nav><svg><path d="M0 0"/></svg><a href="/">Home</a></nav>`;
    expect(stripHtmlNoise(html)).not.toContain("<svg>");
  });

  test("removes HTML comments", () => {
    const html = `<nav><!-- comment --><a href="/">Home</a></nav>`;
    expect(stripHtmlNoise(html)).not.toContain("comment");
  });
});
