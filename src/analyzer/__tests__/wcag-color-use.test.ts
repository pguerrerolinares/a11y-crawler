import { test, expect } from "bun:test";
import { computePixelDiffPercent } from "../wcag-color-use";

test("computePixelDiffPercent returns 0 for identical buffers", async () => {
  // 2x2 red image
  const buf = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
  const result = await computePixelDiffPercent(buf, buf, 2, 2);
  expect(result.percent).toBe(0);
});

test("computePixelDiffPercent returns >0 for different buffers with bounding box", async () => {
  const buf1 = Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
  const buf2 = Buffer.from([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]);
  const result = await computePixelDiffPercent(buf1, buf2, 2, 2);
  expect(result.percent).toBeGreaterThan(0);
  expect(result.boundingBox).not.toBeNull();
  expect(result.boundingBox!.width).toBeGreaterThan(0);
});
