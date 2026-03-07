import { describe, test, expect } from "bun:test";
import { TokenBucket, estimateTokens } from "../client.ts";

describe("TokenBucket", () => {
  test("allows requests within rate limit", () => {
    const bucket = new TokenBucket(10); // 10 per minute
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
  });

  test("blocks when bucket is empty", () => {
    const bucket = new TokenBucket(2);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });
});

describe("estimateTokens", () => {
  test("estimates token count from text", () => {
    const text = "Hello world, this is a test string";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
