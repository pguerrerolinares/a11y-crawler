import { test, expect } from "bun:test";
import { clampCrop } from "../crop-screenshot";

test("clampCrop returns valid dimensions within viewport", () => {
  const crop = clampCrop({ x: -10, y: -10, width: 200, height: 200 }, 80, 1280, 720);
  expect(crop.left).toBeGreaterThanOrEqual(0);
  expect(crop.top).toBeGreaterThanOrEqual(0);
  expect(crop.width).toBeGreaterThan(0);
  expect(crop.height).toBeGreaterThan(0);
  expect(crop.left + crop.width).toBeLessThanOrEqual(1280);
  expect(crop.top + crop.height).toBeLessThanOrEqual(720);
});

test("clampCrop handles element near right edge", () => {
  const crop = clampCrop({ x: 1200, y: 100, width: 100, height: 50 }, 80, 1280, 720);
  expect(crop.left + crop.width).toBeLessThanOrEqual(1280);
});
