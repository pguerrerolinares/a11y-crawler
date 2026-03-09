import { test, expect, describe } from "bun:test";
import { computeWcagScore } from "../wcag-score.ts";

describe("computeWcagScore", () => {
  test("perfect site returns 100", () => {
    expect(computeWcagScore({ critical: 0, serious: 0, moderate: 0, minor: 0 }, 10)).toBe(100);
  });

  test("site with no pages returns null", () => {
    expect(computeWcagScore({ critical: 0, serious: 0, moderate: 0, minor: 0 }, 0)).toBeNull();
  });

  test("one critical issue on one page scores 90", () => {
    // penalty = 1*10 = 10, avgPerPage = 10/1 = 10, score = 100-10 = 90
    expect(computeWcagScore({ critical: 1, serious: 0, moderate: 0, minor: 0 }, 1)).toBe(90);
  });

  test("many issues clamp at 0, not negative", () => {
    // penalty = 20*10 = 200, avgPerPage = 200/1 = 200, score = max(0, -100) = 0
    expect(computeWcagScore({ critical: 20, serious: 0, moderate: 0, minor: 0 }, 1)).toBe(0);
  });

  test("issues spread across pages are normalized", () => {
    // Same 10 critical issues, 10 pages: avgPenalty = 100/10 = 10, score = 90
    expect(computeWcagScore({ critical: 10, serious: 0, moderate: 0, minor: 0 }, 10)).toBe(90);
    // Same 10 critical issues, 1 page: avgPenalty = 100/1 = 100, score = 0
    expect(computeWcagScore({ critical: 10, serious: 0, moderate: 0, minor: 0 }, 1)).toBe(0);
  });

  test("mixed impact levels", () => {
    // penalty = 1*10 + 2*5 + 3*2 + 4*1 = 10+10+6+4 = 30
    // avgPerPage = 30/5 = 6, score = 94
    expect(computeWcagScore({ critical: 1, serious: 2, moderate: 3, minor: 4 }, 5)).toBe(94);
  });
});
