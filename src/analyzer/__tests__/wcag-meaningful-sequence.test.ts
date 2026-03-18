// src/analyzer/__tests__/wcag-meaningful-sequence.test.ts
import { test, expect } from "bun:test";
import { computeKendallTau } from "../wcag-meaningful-sequence";

test("kendall tau = 1.0 for identical order", () => {
  expect(computeKendallTau([0, 1, 2, 3])).toBe(1.0);
});

test("kendall tau = -1.0 for fully reversed order", () => {
  expect(computeKendallTau([3, 2, 1, 0])).toBe(-1.0);
});

test("kendall tau is between -1 and 1 for partial reorder", () => {
  const tau = computeKendallTau([0, 2, 1, 3]);
  expect(tau).toBeGreaterThan(-1);
  expect(tau).toBeLessThan(1);
});

test("kendall tau = 1.0 for single element", () => {
  expect(computeKendallTau([0])).toBe(1.0);
});

test("kendall tau = 1.0 for two elements in order", () => {
  expect(computeKendallTau([0, 1])).toBe(1.0);
});

test("kendall tau = -1.0 for two elements reversed", () => {
  expect(computeKendallTau([1, 0])).toBe(-1.0);
});
