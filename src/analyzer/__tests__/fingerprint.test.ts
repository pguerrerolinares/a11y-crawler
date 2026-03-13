import { test, expect, describe } from "bun:test";
import {
  simhash,
  hammingDistance,
  inferUrlPattern,
  NODE_SIGNATURE_FN,
} from "../fingerprint";

describe("simhash", () => {
  test("returns a bigint", () => {
    expect(typeof simhash("hello world")).toBe("bigint");
  });

  test("same input produces same hash", () => {
    const a = simhash("the quick brown fox jumps over the lazy dog");
    const b = simhash("the quick brown fox jumps over the lazy dog");
    expect(a).toBe(b);
  });

  test("similar inputs have low hamming distance (≤12)", () => {
    const a = simhash("the quick brown fox jumps over the lazy dog");
    const b = simhash("the quick brown fox leaps over the lazy dog");
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(12);
  });

  test("very different inputs have high hamming distance (>8)", () => {
    const a = simhash("header nav main footer sidebar article section div");
    const b = simhash("12345 67890 !@#$% ^&*() abcdef zyxwvu qwerty");
    expect(hammingDistance(a, b)).toBeGreaterThan(8);
  });
});

describe("hammingDistance", () => {
  test("identical values return 0", () => {
    expect(hammingDistance(0b1010n, 0b1010n)).toBe(0);
  });

  test("one bit difference returns 1", () => {
    expect(hammingDistance(0b1010n, 0b1011n)).toBe(1);
  });

  test("all bits different in 8-bit range returns 8", () => {
    expect(hammingDistance(0b00000000n, 0b11111111n)).toBe(8);
  });
});

describe("inferUrlPattern", () => {
  test("root path returns '/'", () => {
    expect(inferUrlPattern("https://example.com/")).toBe("/");
    expect(inferUrlPattern("https://example.com")).toBe("/");
  });

  test("numeric last segment becomes ':id'", () => {
    expect(inferUrlPattern("https://example.com/posts/42")).toBe("/posts/:id");
  });

  test("uuid last segment becomes ':uuid'", () => {
    expect(
      inferUrlPattern(
        "https://example.com/items/550e8400-e29b-41d4-a716-446655440000"
      )
    ).toBe("/items/:uuid");
  });

  test("slug with 3+ hyphenated parts becomes ':slug'", () => {
    expect(
      inferUrlPattern("https://example.com/blog/my-great-blog-post")
    ).toBe("/blog/:slug");
  });

  test("literal segment stays literal", () => {
    expect(inferUrlPattern("https://example.com/about")).toBe("/about");
  });

  test("parent segments are preserved", () => {
    expect(inferUrlPattern("https://example.com/a/b/c/123")).toBe(
      "/a/b/c/:id"
    );
  });

  test("different parents produce different patterns", () => {
    const a = inferUrlPattern("https://example.com/blog/123");
    const b = inferUrlPattern("https://example.com/products/123");
    expect(a).not.toBe(b);
    expect(a).toBe("/blog/:id");
    expect(b).toBe("/products/:id");
  });

  test("short slug (1 hyphen) stays literal", () => {
    expect(inferUrlPattern("https://example.com/blog/my-post")).toBe(
      "/blog/my-post"
    );
  });
});

describe("NODE_SIGNATURE_FN", () => {
  test("is a non-empty string", () => {
    expect(typeof NODE_SIGNATURE_FN).toBe("string");
    expect(NODE_SIGNATURE_FN.length).toBeGreaterThan(0);
  });
});
