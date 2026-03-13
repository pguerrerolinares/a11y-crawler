import { test, expect, describe } from "bun:test";
import { computeWcagScore } from "../wcag-score.ts";

describe("computeWcagScore", () => {
  test("perfect site returns 100", () => {
    expect(computeWcagScore({ critical: 0, serious: 0, moderate: 0, minor: 0 }, 10)).toBe(100);
  });

  test("site with no pages returns null", () => {
    expect(computeWcagScore({ critical: 0, serious: 0, moderate: 0, minor: 0 }, 0)).toBeNull();
  });

  test("one critical rule gives 90", () => {
    // penalty = 1*10 = 10, score = 100-10 = 90
    expect(computeWcagScore({ critical: 1, serious: 0, moderate: 0, minor: 0 }, 1)).toBe(90);
  });

  test("many violated rules clamp at 0", () => {
    // penalty = 20*10 = 200, score = max(0, -100) = 0
    expect(computeWcagScore({ critical: 20, serious: 0, moderate: 0, minor: 0 }, 1)).toBe(0);
  });

  test("score is independent of page count (distinct rules are site-wide)", () => {
    // 3 critical rules → penalty 30, score 70 regardless of pages
    expect(computeWcagScore({ critical: 3, serious: 0, moderate: 0, minor: 0 }, 1)).toBe(70);
    expect(computeWcagScore({ critical: 3, serious: 0, moderate: 0, minor: 0 }, 10)).toBe(70);
    expect(computeWcagScore({ critical: 3, serious: 0, moderate: 0, minor: 0 }, 100)).toBe(70);
  });

  test("mixed impact levels", () => {
    // penalty = 1*10 + 2*5 + 3*2 + 4*1 = 10+10+6+4 = 30
    // score = 100-30 = 70
    expect(computeWcagScore({ critical: 1, serious: 2, moderate: 3, minor: 4 }, 5)).toBe(70);
  });

  test("realistic site with moderate issues", () => {
    // 2 critical rules + 4 serious + 5 moderate + 3 minor
    // penalty = 20 + 20 + 10 + 3 = 53, score = 47
    expect(computeWcagScore({ critical: 2, serious: 4, moderate: 5, minor: 3 }, 30)).toBe(47);
  });

  test("good site with few issues", () => {
    // 0 critical, 1 serious, 2 moderate, 1 minor
    // penalty = 0 + 5 + 4 + 1 = 10, score = 90
    expect(computeWcagScore({ critical: 0, serious: 1, moderate: 2, minor: 1 }, 20)).toBe(90);
  });
});
