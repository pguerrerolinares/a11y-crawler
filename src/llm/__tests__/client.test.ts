import { describe, test, expect } from "bun:test";
import { TokenBucket, estimateTokens, buildMultimodalMessage } from "../client.ts";

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

describe("buildMultimodalMessage", () => {
  test("builds text-only message when no images", () => {
    const msg = buildMultimodalMessage("hello", []);
    expect(msg.role).toBe("user");
    expect(Array.isArray(msg.content)).toBe(true);
    const content = msg.content as any[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("hello");
  });

  test("builds multimodal message with images", () => {
    const msg = buildMultimodalMessage("fix this", ["abc123", "def456"]);
    const content = msg.content as any[];
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("image_url");
    expect(content[1].image_url.url).toContain("data:image/png;base64,abc123");
    expect(content[2].image_url.url).toContain("data:image/png;base64,def456");
  });
});
