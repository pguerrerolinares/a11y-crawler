import type { Page } from "playwright";

/**
 * Disable CSS animations/transitions on the page so hover/focus style changes
 * are instantaneous. This is the standard approach used by visual testing tools
 * (Chromatic, Applitools) — we don't need animation timing, only final computed styles.
 *
 * Call once per page before running Tier 2 interactions.
 */
export async function disableAnimations(page: Page): Promise<void> {
  const handle = await page.addStyleTag({
    content: `
      *, *::before, *::after {
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        animation-duration: 0s !important;
        animation-delay: 0s !important;
      }
    `,
  });
  await handle.evaluate(el => (el as HTMLElement).setAttribute('data-disable-animations', 'true'));
}

/**
 * Re-enable CSS animations/transitions. Call at the boundary between
 * Phase 2 (interaction) and Phase 3 (viewport) to ensure viewport tests
 * and screenshots see real animation state.
 */
export async function enableAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const tag = document.querySelector('style[data-disable-animations]');
    if (tag) tag.remove();
  });
}

/**
 * Wait for a style change to settle after an interaction (hover, focus, click).
 *
 * Strategy:
 * 1. Listen for 'transitionend' event (fires instantly with transition-duration: 0s)
 * 2. Fallback timeout (50ms) for JS-driven changes that don't use CSS transitions
 *
 * With animations disabled, this typically resolves in <16ms (one animation frame).
 * The fallbackMs ceiling prevents hanging on elements with no transitions at all.
 */
export async function adaptiveWait(
  page: Page,
  selector: string,
  _trigger: string,
  fallbackMs = 50,
): Promise<void> {
  try {
    await page.evaluate(
      (args) => new Promise<void>((resolve) => {
        const el = document.querySelector(args.sel);
        if (!el) { resolve(); return; }
        el.addEventListener("transitionend", () => resolve(), { once: true });
        setTimeout(resolve, args.ms);
      }),
      { sel: selector, ms: fallbackMs },
    );
  } catch {
    // Element gone or page navigated — proceed
  }
}
