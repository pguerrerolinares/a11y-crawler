import { test, expect } from "bun:test";
import {
  parseRgba,
  alphaBlend,
  srgbToLinear,
  relativeLuminance,
  contrastRatio,
} from "./contrast";

// --- parseRgba ---

test("parseRgba: rgb()", () => {
  expect(parseRgba("rgb(255, 255, 255)")).toEqual([255, 255, 255, 1]);
});

test("parseRgba: rgba()", () => {
  expect(parseRgba("rgba(200, 200, 200, 0.5)")).toEqual([200, 200, 200, 0.5]);
});

test("parseRgba: rgba with 0 alpha", () => {
  expect(parseRgba("rgba(0, 0, 0, 0)")).toEqual([0, 0, 0, 0]);
});

test("parseRgba: invalid string returns null", () => {
  expect(parseRgba("transparent")).toBeNull();
  expect(parseRgba("")).toBeNull();
});

// --- srgbToLinear ---

test("srgbToLinear: 0 → 0", () => {
  expect(srgbToLinear(0)).toBe(0);
});

test("srgbToLinear: 255 → 1", () => {
  expect(srgbToLinear(255)).toBeCloseTo(1.0, 5);
});

test("srgbToLinear: below threshold (10) uses linear formula", () => {
  const expected = (10 / 255) / 12.92;
  expect(srgbToLinear(10)).toBeCloseTo(expected, 5);
});

test("srgbToLinear: above threshold (128) uses gamma formula", () => {
  const c = 128 / 255;
  const expected = Math.pow((c + 0.055) / 1.055, 2.4);
  expect(srgbToLinear(128)).toBeCloseTo(expected, 5);
});

// --- relativeLuminance ---

test("relativeLuminance: white = 1.0", () => {
  expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1.0, 4);
});

test("relativeLuminance: black = 0.0", () => {
  expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0.0, 4);
});

test("relativeLuminance: pure red", () => {
  expect(relativeLuminance([255, 0, 0])).toBeCloseTo(0.2126, 4);
});

// --- contrastRatio ---

test("contrastRatio: white vs black = 21:1", () => {
  const lWhite = 1.0;
  const lBlack = 0.0;
  expect(contrastRatio(lWhite, lBlack)).toBeCloseTo(21.0, 2);
});

test("contrastRatio: same color = 1:1", () => {
  expect(contrastRatio(0.5, 0.5)).toBeCloseTo(1.0, 2);
});

test("contrastRatio: order-independent", () => {
  const a = 0.8;
  const b = 0.2;
  expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 5);
});

test("contrastRatio: #e0e0e0 vs #ffffff < 3:1", () => {
  const lGray = relativeLuminance([224, 224, 224]);
  const lWhite = relativeLuminance([255, 255, 255]);
  const ratio = contrastRatio(lGray, lWhite);
  expect(ratio).toBeLessThan(3.0);
});

test("contrastRatio: #767676 vs #ffffff >= 4.5:1", () => {
  const lGray = relativeLuminance([118, 118, 118]);
  const lWhite = relativeLuminance([255, 255, 255]);
  const ratio = contrastRatio(lGray, lWhite);
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

// --- alphaBlend ---

test("alphaBlend: fully opaque returns fg", () => {
  expect(alphaBlend([200, 100, 50, 1], [255, 255, 255])).toEqual([200, 100, 50]);
});

test("alphaBlend: fully transparent returns bg", () => {
  expect(alphaBlend([200, 100, 50, 0], [255, 255, 255])).toEqual([255, 255, 255]);
});

test("alphaBlend: 50% rgba on white", () => {
  const result = alphaBlend([200, 200, 200, 0.5], [255, 255, 255]);
  expect(result[0]).toBeCloseTo(228, 0);
  expect(result[1]).toBeCloseTo(228, 0);
  expect(result[2]).toBeCloseTo(228, 0);
});
