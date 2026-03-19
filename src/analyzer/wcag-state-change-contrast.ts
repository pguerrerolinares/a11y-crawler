// src/analyzer/wcag-state-change-contrast.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import { parseRgba, alphaBlend, relativeLuminance, contrastRatio } from "./contrast";
import { makeWcagIssue, CONSENT_BANNER_SELECTOR } from "./utils";

const MIN_STATE_RATIO = 3.0;
const MAX_ELEMENTS = 20; // limit to keep probe fast

const HELP_TEXT =
  "Visual state changes (hover, focus, active) must have ≥ 3:1 contrast difference so users can perceive the change.";

function makeStateIssue(url: string, description: string, selector: string): Issue {
  return {
    ...makeWcagIssue(url, "state-change-low-contrast", "moderate", description, selector, "1.4.11", "visual"),
    checkSource: "interactive",
    help: HELP_TEXT,
  };
}

/**
 * Compute the contrast ratio between two color states relative to a background.
 * This measures how perceptible the *change* is, not absolute contrast.
 *
 * Strategy: compute the blended RGB of each state against the bg,
 * then compute the contrast ratio between the two blended colors.
 * A ratio < 3:1 means the change is too subtle to perceive.
 */
export function stateChangeRatio(
  colorDefault: string,
  colorChanged: string,
  bgColor: string,
): number {
  const defaultRgba = parseRgba(colorDefault);
  const changedRgba = parseRgba(colorChanged);
  const bgRgba = parseRgba(bgColor);

  if (!defaultRgba || !changedRgba || !bgRgba) return 1;

  const bg: [number, number, number] = [bgRgba[0], bgRgba[1], bgRgba[2]];
  const blendedDefault = alphaBlend(defaultRgba, bg);
  const blendedChanged = alphaBlend(changedRgba, bg);

  const lumDefault = relativeLuminance(blendedDefault);
  const lumChanged = relativeLuminance(blendedChanged);

  return contrastRatio(lumDefault, lumChanged);
}

interface ElementStateColors {
  selector: string;
  tag: string;
  text: string;
  default: {
    borderColor: string;
    outlineColor: string;
    backgroundColor: string;
    boxShadow: string;
    textDecorationLine: string;
  };
  parentBg: string;
}

/**
 * WCAG 1.4.11 — Non-text Contrast: State Changes
 *
 * Verifies that hover and focus states of interactive elements produce
 * a visual change with ≥ 3:1 contrast ratio vs the default state.
 *
 * This complements the existing non-text-contrast test (which checks
 * static contrast) by checking *dynamic state transitions*.
 */
export async function testStateChangeContrast(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  const INTERACTIVE_SELECTOR = [
    "a[href]", "button", "input", "select", "textarea",
    '[role="button"]', '[role="tab"]', '[role="menuitem"]',
    '[role="link"]',
  ].join(", ");

  // Step 1: Gather default-state colors for interactive elements.
  // Selectors are built inside the browser context with CSS.escape() to handle
  // IDs and class names containing special CSS characters.
  let elements: ElementStateColors[];
  try {
    elements = await page.evaluate((args: { selector: string; consentSelector: string; max: number }) => {
      function resolveParentBg(el: Element): string {
        let current = el.parentElement;
        while (current) {
          const bg = getComputedStyle(current).backgroundColor;
          if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
          current = current.parentElement;
        }
        return "rgb(255, 255, 255)";
      }

      // Build a CSS selector using CSS.escape() to handle special characters in IDs/classes.
      function cssSelector(el: Element): string {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const tag = el.tagName.toLowerCase();
        if (el.className && typeof el.className === "string") {
          const classes = el.className.trim().split(/\s+/).slice(0, 3).map((c) => CSS.escape(c)).join(".");
          if (classes) return `${tag}.${classes}`;
        }
        return tag;
      }

      const results: any[] = [];
      const seen = new Set<string>();

      for (const el of Array.from(document.querySelectorAll(args.selector))) {
        if (results.length >= args.max) break;

        // Skip consent banners
        if (el.closest(args.consentSelector)) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        // Skip hidden elements
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;

        // Skip duplicates (same selector = same component type)
        const sel = cssSelector(el);
        if (seen.has(sel)) continue;
        seen.add(sel);

        results.push({
          selector: sel,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? "").trim().slice(0, 30),
          default: {
            borderColor: style.borderColor,
            outlineColor: style.outlineColor,
            backgroundColor: style.backgroundColor,
            boxShadow: style.boxShadow,
            textDecorationLine: style.textDecorationLine,
          },
          parentBg: resolveParentBg(el),
        });
      }
      return results;
    }, { selector: INTERACTIVE_SELECTOR, consentSelector: CONSENT_BANNER_SELECTOR, max: MAX_ELEMENTS });
  } catch {
    return [];
  }

  if (elements.length === 0) return [];

  // Step 2: For each element, hover and focus, capture changed colors
  for (const el of elements) {
    try {
      const handle = await page.$(el.selector);
      if (!handle) continue;

      // --- HOVER STATE ---
      await handle.hover();
      await page.waitForTimeout(200);

      const hoverColors = await page.evaluate((sel: string) => {
        const target = document.querySelector(sel);
        if (!target) return null;
        const style = getComputedStyle(target);
        return {
          borderColor: style.borderColor,
          outlineColor: style.outlineColor,
          backgroundColor: style.backgroundColor,
          boxShadow: style.boxShadow,
          textDecorationLine: style.textDecorationLine,
        };
      }, el.selector);

      // Move mouse away to reset hover state
      await page.mouse.move(0, 0);
      await page.waitForTimeout(100);

      if (hoverColors) {
        const hasVisualChange = checkStateChange(el, hoverColors, el.parentBg, "hover");
        if (hasVisualChange === "insufficient") {
          issues.push(makeStateIssue(url,
            `Element "${el.text || el.tag}" (${el.selector}) hover state has insufficient visual change — the color difference between default and hover states does not meet 3:1 contrast ratio.`,
            el.selector,
          ));
        }
      }

      // --- FOCUS STATE ---
      await handle.focus();
      await page.waitForTimeout(200);

      const focusColors = await page.evaluate((sel: string) => {
        const target = document.querySelector(sel);
        if (!target) return null;
        const style = getComputedStyle(target);
        return {
          borderColor: style.borderColor,
          outlineColor: style.outlineColor,
          backgroundColor: style.backgroundColor,
          boxShadow: style.boxShadow,
          textDecorationLine: style.textDecorationLine,
        };
      }, el.selector);

      // Blur to reset
      await page.evaluate((sel: string) => {
        const target = document.querySelector(sel) as HTMLElement;
        target?.blur();
      }, el.selector);
      await page.waitForTimeout(100);

      if (focusColors) {
        const hasVisualChange = checkStateChange(el, focusColors, el.parentBg, "focus");
        if (hasVisualChange === "insufficient") {
          issues.push(makeStateIssue(url,
            `Element "${el.text || el.tag}" (${el.selector}) focus state has insufficient visual change — the color difference between default and focus states does not meet 3:1 contrast ratio.`,
            el.selector,
          ));
        }
      }

      await handle.dispose();
    } catch {
      // Element became stale or interaction failed — skip
      continue;
    }
  }

  return issues;
}

type StateColors = {
  borderColor: string;
  outlineColor: string;
  backgroundColor: string;
  boxShadow: string;
  textDecorationLine: string;
};

/**
 * Compare default and changed state colors. Returns:
 * - "no-change": nothing changed visually (not necessarily a violation —
 *    some elements don't need hover styling)
 * - "sufficient": changed and meets 3:1 ratio
 * - "insufficient": changed but below 3:1 ratio
 */
function checkStateChange(
  el: ElementStateColors,
  changed: StateColors,
  bgColor: string,
  _state: "hover" | "focus",
): "no-change" | "sufficient" | "insufficient" {
  const defaultColors = el.default;

  // Check if ANY visual property changed
  const borderChanged = defaultColors.borderColor !== changed.borderColor;
  const outlineChanged = defaultColors.outlineColor !== changed.outlineColor;
  const bgChanged = defaultColors.backgroundColor !== changed.backgroundColor;
  const shadowChanged = defaultColors.boxShadow !== changed.boxShadow;
  const underlineChanged = defaultColors.textDecorationLine !== changed.textDecorationLine;

  // If text-decoration changed (e.g., underline added on hover), that's sufficient
  // regardless of color contrast — it's a non-color visual indicator
  if (underlineChanged) return "sufficient";

  // Box-shadow added on hover/focus: visible outline/glow — always sufficient
  if (shadowChanged && changed.boxShadow !== "none") return "sufficient";

  // Box-shadow removed on hover/focus AND nothing else changed: this is a visual regression
  // (the element loses a visual indicator without gaining another) — mark as insufficient
  if (shadowChanged && changed.boxShadow === "none" && !borderChanged && !outlineChanged && !bgChanged) {
    return "insufficient";
  }

  // No visual change at all — skip (not all elements need hover styles)
  if (!borderChanged && !outlineChanged && !bgChanged) return "no-change";

  // Something changed — check if the change meets 3:1 contrast ratio
  let bestRatio = 1;

  if (borderChanged) {
    const ratio = stateChangeRatio(defaultColors.borderColor, changed.borderColor, bgColor);
    if (ratio > bestRatio) bestRatio = ratio;
  }

  if (outlineChanged) {
    const ratio = stateChangeRatio(defaultColors.outlineColor, changed.outlineColor, bgColor);
    if (ratio > bestRatio) bestRatio = ratio;
  }

  if (bgChanged) {
    const ratio = stateChangeRatio(defaultColors.backgroundColor, changed.backgroundColor, bgColor);
    if (ratio > bestRatio) bestRatio = ratio;
  }

  return bestRatio >= MIN_STATE_RATIO ? "sufficient" : "insufficient";
}
