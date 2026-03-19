// src/worker/manifest.ts
import type { Page } from "playwright";
import type { ElementManifest, StyleGroup } from "../types/manifest";

/**
 * Computes a deterministic style fingerprint for an element.
 * Elements that share the same fingerprint likely share the same visual style
 * and can be grouped so only one representative needs probing.
 */
export function computeStyleFingerprint(
  tag: string,
  className: string,
  parentContext: string
): string {
  const sortedClasses = className.split(" ").filter(Boolean).sort().join(" ");
  return `${parentContext}|${tag}|${sortedClasses}`;
}

/**
 * Groups an array of ElementManifest objects by their styleFingerprint.
 * Returns one StyleGroup per unique fingerprint.
 * The representative is the first element seen with that fingerprint.
 * Members includes all elements with that fingerprint (including the representative).
 */
export function groupByFingerprint(elements: ElementManifest[]): StyleGroup[] {
  const map = new Map<string, StyleGroup>();

  for (const el of elements) {
    const fp = el.styleFingerprint;
    const existing = map.get(fp);
    if (existing) {
      existing.members.push(el);
    } else {
      map.set(fp, {
        fingerprint: fp,
        representative: el,
        members: [el],
      });
    }
  }

  return Array.from(map.values());
}

/**
 * Collects an ElementManifest for every interactive element on the page
 * via a single page.evaluate() call.
 * maxElements defaults to 300.
 */
export async function collectManifest(
  page: Page,
  maxElements = 300
): Promise<ElementManifest[]> {
  const elements = await page.evaluate((maxEls: number) => {
    const SELECTORS =
      'a, button, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="link"], [tabindex]';

    const nodes = Array.from(document.querySelectorAll(SELECTORS)).filter(
      (el) => {
        // Exclude tabindex="-1" elements
        const ti = el.getAttribute("tabindex");
        return ti !== "-1";
      }
    );

    const results: ElementManifest[] = [];

    for (const el of nodes) {
      if (results.length >= maxEls) break;

      const element = el as HTMLElement;
      const rect = element.getBoundingClientRect();

      // Skip non-visible elements
      if (rect.width === 0 || rect.height === 0) continue;

      const tag = element.tagName.toLowerCase();

      // Build selector
      let selector: string;
      if (element.id) {
        selector = `#${CSS.escape(element.id)}`;
      } else {
        const classStr = element.className
          ? "." +
            element.className
              .trim()
              .split(/\s+/)
              .map((c) => CSS.escape(c))
              .join(".")
          : "";
        selector = tag + classStr;
      }

      // Accessible name
      const accessibleName =
        element.getAttribute("aria-label") ||
        element.getAttribute("aria-labelledby") ||
        element.textContent?.trim().slice(0, 100) ||
        "";

      // Computed styles
      const cs = getComputedStyle(element);
      const defaultStyles = {
        borderColor: cs.borderColor,
        outlineColor: cs.outlineColor,
        backgroundColor: cs.backgroundColor,
        boxShadow: cs.boxShadow,
        textDecorationLine: cs.textDecorationLine,
        color: cs.color,
      };

      // Resolve parent background (walk up until non-transparent found)
      let parentBg = "rgb(255,255,255)";
      let parent = element.parentElement;
      while (parent) {
        const bg = getComputedStyle(parent).backgroundColor;
        if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") {
          parentBg = bg;
          break;
        }
        parent = parent.parentElement;
      }

      // Style fingerprint using parent context
      const parentElement = element.parentElement;
      const parentTag = parentElement ? parentElement.tagName.toLowerCase() : "";
      const parentClass = parentElement
        ? (parentElement.className || "").trim()
        : "";
      const sortedClasses = (element.className || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(" ");
      const styleFingerprint = `${parentTag}${parentClass}|${tag}|${sortedClasses}`;

      results.push({
        selector,
        tag,
        role: element.getAttribute("role"),
        accessibleName,
        boundingBox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        hasHoverCss: false,
        hasAriaExpanded: element.hasAttribute("aria-expanded"),
        hasAriaPressed: element.hasAttribute("aria-pressed"),
        hasUnderline: cs.textDecorationLine.includes("underline"),
        isFormControl: ["input", "select", "textarea"].includes(tag),
        defaultStyles,
        parentBg,
        styleFingerprint,
      });
    }

    return results;
  }, maxElements);

  return elements;
}

/**
 * Resizes the viewport to mobile dimensions and updates each element's
 * boundingBox by re-querying by selector.
 * Restores viewport to 1280×720 when done.
 * Called only when the test plan requires mobile data (meaningful-sequence, reflow).
 */
export async function collectMobileBoxes(
  page: Page,
  elements: ElementManifest[]
): Promise<void> {
  await page.setViewportSize({ width: 320, height: 800 });

  for (const el of elements) {
    try {
      const box = await page.evaluate((sel: string) => {
        const node = document.querySelector(sel) as HTMLElement | null;
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }, el.selector);

      if (box) {
        el.boundingBox = box;
      }
    } catch {
      // Selector may not match uniquely on mobile; leave existing boundingBox
    }
  }

  await page.setViewportSize({ width: 1280, height: 720 });
}
