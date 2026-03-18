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

test("isPseudoListLayout detects uniform-height aligned siblings", () => {
  expect(isPseudoListLayout(
    [{ height: 40, left: 10 }, { height: 42, left: 10 }, { height: 41, left: 10 }],
  )).toBe(true);
});

test("isPseudoListLayout rejects varied layout", () => {
  expect(isPseudoListLayout(
    [{ height: 40, left: 10 }, { height: 100, left: 200 }, { height: 30, left: 50 }],
  )).toBe(false);
});
