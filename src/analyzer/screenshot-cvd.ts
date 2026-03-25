// src/analyzer/screenshot-cvd.ts
// Reusable screenshot, pixel diff, CVD simulation, and CSS fingerprint utilities.
import type { Page } from "playwright";

export interface DiffBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Subset of CDP VisionDeficiency enum
export type CvdDeficiency = "deuteranopia" | "achromatopsia";

export interface CvdDiffResult {
  deficiency: CvdDeficiency;
  diffPercent: number;
  normalImg: Buffer;
  cvdImg: Buffer;
  diffBox: DiffBoundingBox | null;
}

/**
 * Pixel diff percentage between two raw RGBA buffers.
 * Returns diff % and bounding box of changed region.
 */
export async function computePixelDiffPercent(
  buf1: Uint8Array | Buffer,
  buf2: Uint8Array | Buffer,
  width: number,
  height: number,
): Promise<{ percent: number; boundingBox: DiffBoundingBox | null }> {
  const mod = await import("pixelmatch");
  const pixelmatch = mod.default ?? mod;
  const totalPixels = width * height;
  const diff = new Uint8Array(totalPixels * 4);
  const diffPixels = pixelmatch(
    new Uint8Array(buf1), new Uint8Array(buf2),
    diff, width, height,
    { threshold: 0.1, includeAA: false },
  );
  const percent = (diffPixels / totalPixels) * 100;

  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (diff[i * 4 + 3] > 0) {
      const x = i % width;
      const y = Math.floor(i / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const boundingBox = maxX >= minX ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  return { percent, boundingBox };
}

/**
 * Take normal + CVD-simulated screenshots via CDP and compute pixel diff.
 * Downsamples to 640×360 for faster comparison (75% fewer pixels).
 */
export async function cvdScreenshotDiff(page: Page): Promise<CvdDiffResult[]> {
  const { default: sharp } = await import("sharp");
  const results: CvdDiffResult[] = [];

  const normalShot = await page.screenshot({ type: "jpeg", quality: 80, fullPage: false });
  const DIFF_WIDTH = 640;
  const DIFF_HEIGHT = 360;
  const { data: normalRaw } = await sharp(normalShot)
    .resize(DIFF_WIDTH, DIFF_HEIGHT)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const deficiencies: CvdDeficiency[] = ["deuteranopia"];

  const client = await page.context().newCDPSession(page);
  try {
    for (const deficiency of deficiencies) {
      try {
        await client.send("Emulation.setEmulatedVisionDeficiency", { type: deficiency });
        const cvdShot = await page.screenshot({ type: "jpeg", quality: 80, fullPage: false });
        await client.send("Emulation.setEmulatedVisionDeficiency", { type: "none" });

        const { data: cvdRaw } = await sharp(cvdShot)
          .ensureAlpha().resize(DIFF_WIDTH, DIFF_HEIGHT).raw().toBuffer({ resolveWithObject: true });

        const { percent: diffPercent, boundingBox: diffBoxSmall } = await computePixelDiffPercent(normalRaw, cvdRaw, DIFF_WIDTH, DIFF_HEIGHT);
        let diffBox: DiffBoundingBox | null = null;
        if (diffBoxSmall) {
          const scaleX = 1280 / DIFF_WIDTH;
          const scaleY = 720 / DIFF_HEIGHT;
          const PAD = 50;
          diffBox = {
            x: Math.max(0, Math.floor(diffBoxSmall.x * scaleX) - PAD),
            y: Math.max(0, Math.floor(diffBoxSmall.y * scaleY) - PAD),
            width: Math.min(1280, Math.ceil(diffBoxSmall.width * scaleX) + PAD * 2),
            height: Math.min(720, Math.ceil(diffBoxSmall.height * scaleY) + PAD * 2),
          };
        }
        results.push({ deficiency, diffPercent, normalImg: normalShot, cvdImg: cvdShot, diffBox });
      } catch (err) {
        console.warn(`CVD simulation (${deficiency}) failed:`, err instanceof Error ? err.message : err);
        await client.send("Emulation.setEmulatedVisionDeficiency", { type: "none" }).catch(() => {});
      }
    }
  } finally {
    await client.send("Emulation.setEmulatedVisionDeficiency", { type: "none" }).catch(() => {});
    await client.detach().catch(() => {});
  }

  return results;
}

/**
 * Compute a CSS fingerprint for the current page (stylesheet hrefs + inline style hashes).
 * Used for caching CVD results across templates with identical styles.
 */
export async function computeCssFingerprint(page: Page): Promise<string> {
  const raw = await page.evaluate(() => {
    const parts: string[] = [];
    document.querySelectorAll('link[rel="stylesheet"]').forEach(l => {
      parts.push((l as HTMLLinkElement).href);
    });
    document.querySelectorAll('style').forEach(s => {
      const text = s.textContent || '';
      parts.push(`inline:${text.length}:${text.slice(0, 100)}`);
    });
    return parts.sort().join('|');
  });
  const { createHash } = await import("node:crypto");
  const hash = createHash("md5").update(raw).digest("hex");
  return hash;
}
