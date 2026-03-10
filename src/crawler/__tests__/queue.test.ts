import { test, expect, describe, beforeEach } from "bun:test";
import { UrlQueue } from "../queue.ts";

describe("UrlQueue", () => {
  let queue: UrlQueue;

  beforeEach(() => {
    queue = new UrlQueue(10);
  });

  test("seed and consume URLs in FIFO order", () => {
    queue.seed(["https://example.com/a", "https://example.com/b"], "link");
    expect(queue.next()).toBe("https://example.com/a");
    expect(queue.next()).toBe("https://example.com/b");
    expect(queue.next()).toBeNull();
  });

  test("deduplicates URLs", () => {
    queue.seed(["https://example.com/a", "https://example.com/a"], "link");
    expect(queue.next()).toBe("https://example.com/a");
    expect(queue.next()).toBeNull();
  });

  test("normalizes URLs — trailing slash", () => {
    queue.seed(["https://example.com/page/"], "link");
    expect(queue.next()).toBe("https://example.com/page");
  });

  test("normalizes URLs — strips hash", () => {
    queue.seed(["https://example.com/page#section"], "link");
    expect(queue.next()).toBe("https://example.com/page");
  });

  test("normalizes URLs — sorts query params", () => {
    queue.seed(["https://example.com/page?b=2&a=1"], "link");
    expect(queue.next()).toBe("https://example.com/page?a=1&b=2");
  });

  test("respects maxPages limit", () => {
    const small = new UrlQueue(2);
    small.seed(["https://example.com/a", "https://example.com/b", "https://example.com/c"], "link");
    expect(small.next()).toBe("https://example.com/a");
    expect(small.next()).toBe("https://example.com/b");
    expect(small.next()).toBeNull(); // maxPages reached
  });

  test("does not revisit consumed URLs", () => {
    queue.seed(["https://example.com/a"], "link");
    expect(queue.next()).toBe("https://example.com/a");
    queue.seed(["https://example.com/a"], "interaction"); // re-seed same URL
    expect(queue.next()).toBeNull(); // already visited
  });

  test("tracks discovery origin", () => {
    queue.seed(["https://example.com/a"], "sitemap");
    queue.seed(["https://example.com/b"], "link");
    queue.seed(["https://example.com/c"], "interaction");
    const stats = queue.stats;
    expect(stats.byOrigin.sitemap).toBe(1);
    expect(stats.byOrigin.link).toBe(1);
    expect(stats.byOrigin.interaction).toBe(1);
    expect(stats.totalDiscovered).toBe(3);
  });

  test("stats reflect visited and pending counts", () => {
    queue.seed(["https://example.com/a", "https://example.com/b"], "link");
    queue.next(); // visit a
    const stats = queue.stats;
    expect(stats.totalVisited).toBe(1);
    expect(stats.pendingCount).toBe(1);
  });

  test("respects maxDepth limit", () => {
    const shallow = new UrlQueue(10, 1);
    shallow.seed(["https://example.com/"], "link", 0);
    expect(shallow.next()).toBe("https://example.com/");
    // Child URLs at depth 1 should be allowed
    shallow.seed(["https://example.com/a"], "link", 1);
    expect(shallow.next()).toBe("https://example.com/a");
    // Grandchild URLs at depth 2 should be rejected
    shallow.seed(["https://example.com/a/b"], "link", 2);
    expect(shallow.next()).toBeNull();
  });

  test("getDepth returns correct depth for seeded URLs", () => {
    queue.seed(["https://example.com/"], "link", 0);
    queue.seed(["https://example.com/a"], "link", 1);
    expect(queue.getDepth("https://example.com/")).toBe(0);
    expect(queue.getDepth("https://example.com/a")).toBe(1);
  });
});
