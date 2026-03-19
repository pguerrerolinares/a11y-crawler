import type { Page } from "playwright";

/**
 * Waits for CSS animations/transitions to complete on the given element.
 * Replaces fixed waitForTimeout() — resolves immediately if no animations,
 * up to maxMs ceiling.
 */
export async function adaptiveWait(
  page: Page,
  selector: string,
  trigger: string,
  maxMs: number,
): Promise<void> {
  try {
    await page.waitForFunction(
      (sel) => {
        // Check if any style transition has completed
        const el = document.querySelector(sel);
        if (!el) return true;
        const anims = el.getAnimations();
        return anims.length === 0 || anims.every(a => a.playState === 'finished');
      },
      { timeout: maxMs },
      selector,
    );
  } catch {
    // Timeout reached — proceed anyway (same as current behavior)
  }
}
