// src/analyzer/__tests__/wcag-semantic-structure.test.ts
import { test, expect } from "bun:test";
import { isPseudoHeadingStyle, isPseudoListLayout } from "../wcag-semantic-structure";

test("isPseudoHeadingStyle detects large bold text", () => {
  expect(isPseudoHeadingStyle(24, 700, 30)).toBe(true);
});

test("isPseudoHeadingStyle rejects normal paragraph text", () => {
  expect(isPseudoHeadingStyle(16, 400, 200)).toBe(false);
});

test("isPseudoHeadingStyle detects 14px+ bold short text", () => {
  expect(isPseudoHeadingStyle(14, 700, 50)).toBe(true);
});

test("isPseudoHeadingStyle rejects long text even if large", () => {
  expect(isPseudoHeadingStyle(24, 700, 200)).toBe(false);
});

test("isPseudoListLayout detects uniform-height aligned siblings (5+ items)", () => {
  expect(isPseudoListLayout(
    [{ height: 40, left: 10 }, { height: 42, left: 10 }, { height: 41, left: 10 }, { height: 40, left: 10 }, { height: 41, left: 10 }],
  )).toBe(true);
});

test("isPseudoListLayout rejects 3-item groups (card grid threshold)", () => {
  expect(isPseudoListLayout(
    [{ height: 40, left: 10 }, { height: 42, left: 10 }, { height: 41, left: 10 }],
  )).toBe(false);
});

test("isPseudoListLayout rejects varied layout", () => {
  expect(isPseudoListLayout(
    [{ height: 40, left: 10 }, { height: 100, left: 200 }, { height: 30, left: 50 }],
  )).toBe(false);
});

test("isPseudoHeadingStyle uses parent font-size comparison", () => {
  // 18px text on a 16px parent = 1.125x — NOT a heading (< 1.3x)
  expect(isPseudoHeadingStyle(18, 400, 30, 16)).toBe(false);
  // 22px text on a 16px parent = 1.375x — IS a heading (>= 1.3x and >= 16px)
  expect(isPseudoHeadingStyle(22, 400, 30, 16)).toBe(true);
  // 18px on 18px base = 1.0x — NOT a heading
  expect(isPseudoHeadingStyle(18, 400, 30, 18)).toBe(false);
  // 14px bold still works regardless of parent
  expect(isPseudoHeadingStyle(14, 700, 30, 16)).toBe(true);
});
