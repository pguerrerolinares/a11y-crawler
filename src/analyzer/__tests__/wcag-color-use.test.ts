import { test, expect } from "bun:test";
import { computePixelDiffPercent } from "../wcag-color-use";

test("computePixelDiffPercent returns 0 for identical buffers", () => {
  // 2x2 red image
  const buf = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
  expect(computePixelDiffPercent(buf, buf, 2, 2)).toBe(0);
});

test("computePixelDiffPercent returns >0 for different buffers", () => {
  const buf1 = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
  const buf2 = Buffer.from([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]);
  const diff = computePixelDiffPercent(buf1, buf2, 2, 2);
  expect(diff).toBeGreaterThan(0);
});
