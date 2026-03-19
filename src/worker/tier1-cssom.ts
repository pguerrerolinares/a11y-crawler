/**
 * Tier 1: CSSOM hover analysis
 *
 * Evaluates hover state contrast using statically-resolved CSS rules.
 * If CSSOM can't resolve (cross-origin sheets, CSS variables), returns "ambiguous"
 * to promote the element to Tier 2 (browser interaction).
 */

import {
  parseRgba,
  alphaBlend,
  relativeLuminance,
  contrastRatio,
} from "../analyzer/contrast";
import type { TierResult } from "../types/manifest";

/** Visual properties that constitute a meaningful hover state change */
const VISUAL_PROPS = [
  "background-color",
  "backgroundColor",
  "border-color",
  "borderColor",
  "outline-color",
  "outlineColor",
  "box-shadow",
  "boxShadow",
  "color",
] as const;

/** Color properties we can compute contrast for (in priority order) */
const COLOR_PROPS_PRIORITY = [
  ["background-color", "backgroundColor"],
  ["border-color", "borderColor"],
  ["outline-color", "outlineColor"],
  ["color", "color"],
] as const;

/**
 * Resolve an rgb color string against a background, returning [r,g,b].
 * Returns null if the color can't be parsed.
 */
function resolveColor(
  css: string,
  bgCss: string,
): [number, number, number] | null {
  const fg = parseRgba(css);
  if (!fg) return null;
  if (fg[3] === 1) return [fg[0], fg[1], fg[2]];
  const bg = parseRgba(bgCss);
  if (!bg) return [fg[0], fg[1], fg[2]]; // best effort without bg
  return alphaBlend(fg, [bg[0], bg[1], bg[2]]);
}

/**
 * Evaluate the contrast of a hover state change.
 *
 * @param defaultStyles - Computed styles in the default (non-hover) state
 * @param hoverStyles   - CSS properties set by :hover rules, or null if CSSOM
 *                        couldn't resolve (cross-origin / CSS variables present)
 * @param parentBg      - Computed background-color of the nearest opaque ancestor
 * @returns TierResult
 *   - "ambiguous"  → CSSOM couldn't resolve; promote to Tier 2
 *   - "no-change"  → Element has no hover state change at all
 *   - "pass"       → Hover change meets WCAG 1.4.11 non-text contrast (≥ 3:1)
 *   - "fail"       → Hover change does not meet contrast threshold
 */
export function evaluateHoverContrast(
  defaultStyles: Record<string, string>,
  hoverStyles: Record<string, string> | null,
  parentBg: string,
): TierResult {
  // null → CSSOM couldn't resolve (cross-origin, CSS vars, etc.)
  if (hoverStyles === null) return "ambiguous";

  // Empty hover rules → CSSOM found nothing applicable
  if (Object.keys(hoverStyles).length === 0) return "ambiguous";

  // Check if any visual property actually changed
  const hasVisualChange = VISUAL_PROPS.some((prop) => {
    const hoverVal = hoverStyles[prop];
    if (!hoverVal) return false;
    const defaultVal = defaultStyles[prop];
    return hoverVal !== defaultVal;
  });

  if (!hasVisualChange) return "no-change";

  // Find the first color property that changed and compute contrast
  for (const [kebab, camel] of COLOR_PROPS_PRIORITY) {
    const hoverVal = hoverStyles[kebab] ?? hoverStyles[camel];
    if (!hoverVal) continue;

    const defaultVal = defaultStyles[kebab] ?? defaultStyles[camel];
    if (hoverVal === defaultVal) continue;

    // Compute contrast between hover color and parent background
    const hoverRgb = resolveColor(hoverVal, parentBg);
    const bgRgb = resolveColor(parentBg, "rgb(255,255,255)");

    if (!hoverRgb || !bgRgb) continue;

    const hoverLum = relativeLuminance(hoverRgb);
    const bgLum = relativeLuminance(bgRgb);
    const ratio = contrastRatio(hoverLum, bgLum);

    // WCAG 1.4.11 non-text contrast threshold is 3:1
    return ratio >= 3.0 ? "pass" : "fail";
  }

  // Visual change was in a non-color property (e.g. box-shadow without color change)
  // We can't compute a numeric contrast — promote to Tier 2
  return "ambiguous";
}

/**
 * Returns the JavaScript function source (as a string) to be injected via
 * `page.evaluate`. The returned function `getHoverRules(el)` reads CSSOM
 * `:hover` rules for a given element and returns the resolved property map,
 * or null if any cross-origin or CSS-variable ambiguity is detected.
 */
export function buildCssomHoverQuery(): string {
  return `
    function getHoverRules(el) {
      const hoverProps = {};
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          return null; // Cross-origin
        }
        let promoteToTier2 = false;
        function traverse(ruleList) {
          for (const rule of ruleList) {
            if (promoteToTier2) break;
            if (rule.constructor.name === 'CSSGroupingRule' || rule.cssRules) {
              traverse(rule.cssRules);
            } else if (rule.selectorText && rule.selectorText.includes(':hover')) {
              const baseSelector = rule.selectorText.replace(/:hover/g, '');
              try {
                if (el.matches(baseSelector)) {
                  for (const prop of rule.style) {
                    if (rule.style.getPropertyValue(prop).includes('var(')) {
                      promoteToTier2 = true;
                      break;
                    }
                    hoverProps[prop] = rule.style.getPropertyValue(prop);
                  }
                }
              } catch {
                promoteToTier2 = true;
              }
            }
          }
        }
        traverse(rules);
        if (promoteToTier2) return null;
      }
      return Object.keys(hoverProps).length > 0 ? hoverProps : null;
    }
  `;
}
