import { test, expect } from "bun:test";
import { parseRgba } from "../contrast";

test("parseRgba handles comma-separated rgb", () => {
  expect(parseRgba("rgb(255, 0, 128)")).toEqual([255, 0, 128, 1]);
});

test("parseRgba handles comma-separated rgba", () => {
  expect(parseRgba("rgba(255, 0, 128, 0.5)")).toEqual([255, 0, 128, 0.5]);
});

test("parseRgba handles space-separated rgb (modern syntax)", () => {
  expect(parseRgba("rgb(255 0 128)")).toEqual([255, 0, 128, 1]);
});

test("parseRgba handles space-separated rgba with slash (modern syntax)", () => {
  expect(parseRgba("rgb(255 0 128 / 0.5)")).toEqual([255, 0, 128, 0.5]);
});

test("parseRgba handles rgba space-separated with slash", () => {
  expect(parseRgba("rgba(100 200 50 / 0.8)")).toEqual([100, 200, 50, 0.8]);
});

test("parseRgba handles percentage alpha", () => {
  expect(parseRgba("rgb(255 0 128 / 50%)")).toEqual([255, 0, 128, 0.5]);
});

test("parseRgba returns null for invalid input", () => {
  expect(parseRgba("transparent")).toBeNull();
  expect(parseRgba("#ff0000")).toBeNull();
  expect(parseRgba("")).toBeNull();
});
