import type { Page } from "playwright";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CropDimensions {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Exported for testing — computes clamped crop dimensions */
export function clampCrop(
  box: BoundingBox,
  padding: number,
  viewportWidth: number,
  viewportHeight: number,
): CropDimensions {
  const left = Math.max(0, Math.round(box.x - padding));
  const top = Math.max(0, Math.round(box.y - padding));
  const right = Math.min(viewportWidth, Math.round(box.x + box.width + padding));
  const bottom = Math.min(viewportHeight, Math.round(box.y + box.height + padding));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/**
 * Crops a screenshot to the element's bounding box + padding.
 * Re-queries the bounding box at capture time (not from manifest, which may be stale).
 * Saves to reports/{auditId}/crops/ on disk and returns the Buffer.
 */
export async function cropScreenshot(
  page: Page,
  selector: string,
  auditId: string,
  padding = 80,
): Promise<Buffer | null> {
  // Re-query bounding box at capture time
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);

  if (!box || box.width === 0 || box.height === 0) {
    return page.screenshot({ type: "png", fullPage: false }) as Promise<Buffer>;
  }

  const viewportSize = page.viewportSize() ?? { width: 1280, height: 720 };
  const crop = clampCrop(box, padding, viewportSize.width, viewportSize.height);

  const fullShot = await page.screenshot({ type: "png", fullPage: false }) as Buffer;

  const { default: sharp } = await import("sharp");
  const cropped = await sharp(fullShot)
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .resize(400, undefined, { withoutEnlargement: true })
    .png()
    .toBuffer();

  // Save to disk
  const dir = path.join("reports", auditId, "crops");
  await fs.mkdir(dir, { recursive: true });
  const filename = `${selector.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)}-${Date.now()}.png`;
  await fs.writeFile(path.join(dir, filename), cropped);

  return cropped;
}
