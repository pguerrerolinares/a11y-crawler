import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import type { ElementManifest, InteractionResult, PopupInfo } from "../types/manifest";
import type { TierTimer } from "./tier-timer";
import { adaptiveWait, disableAnimations } from "./adaptive-wait";
import { parseRgba, alphaBlend, relativeLuminance, contrastRatio } from "../analyzer/contrast";
import { makeWcagIssue } from "../analyzer/utils";
import { elementHashFromManifest } from "./probe-cache";

export type HoverFocusCache = Map<string, {
  hoverStyles: Record<string, string>;
  focusStyles: Record<string, string>;
  hadPopup: boolean;
}>;

export function isNativeInteractive(tag: string): boolean {
  return ["a", "button", "input", "select", "textarea", "details", "summary"].includes(tag);
}

function makeIssue(
  selector: string,
  url: string,
  rule: string,
  description: string,
  wcagCriterion: string,
  impact: Issue["impact"] = "serious",
): Issue {
  return makeWcagIssue(url, rule, impact, description, selector, wcagCriterion, "interactive", {
    checkSource: "interactive",
  });
}

function resolveColor(
  css: string,
  parentBg: string,
): [number, number, number] | null {
  const rgba = parseRgba(css);
  if (!rgba) return null;
  if (rgba[3] < 1) {
    const bgRgba = parseRgba(parentBg);
    if (!bgRgba) return [rgba[0], rgba[1], rgba[2]];
    return alphaBlend(rgba, [bgRgba[0], bgRgba[1], bgRgba[2]]);
  }
  return [rgba[0], rgba[1], rgba[2]];
}

function colorsEqual(a: string, b: string): boolean {
  const ra = parseRgba(a);
  const rb = parseRgba(b);
  if (!ra || !rb) return a === b;
  return ra[0] === rb[0] && ra[1] === rb[1] && ra[2] === rb[2] && Math.abs(ra[3] - rb[3]) < 0.01;
}

export function evaluateStateChange(
  element: ElementManifest,
  result: InteractionResult,
  url: string,
): Issue[] {
  const hoverStyles = result.hoverStyles;
  if (!hoverStyles) return [];

  const defaults = element.defaultStyles;
  const propsToCheck = ["backgroundColor", "borderColor", "outlineColor", "color"] as const;

  let changed = false;
  let ratio = 0;

  for (const prop of propsToCheck) {
    const before = defaults[prop as keyof typeof defaults];
    const after = hoverStyles[prop];
    if (!before || !after) continue;
    if (!colorsEqual(before, after)) {
      changed = true;
      const fgResolved = resolveColor(after, element.parentBg);
      const bgResolved = resolveColor(element.parentBg, "rgb(255,255,255)");
      if (fgResolved && bgResolved) {
        const r = contrastRatio(relativeLuminance(fgResolved), relativeLuminance(bgResolved));
        ratio = Math.max(ratio, r);
      }
      break;
    }
  }

  if (!changed) {
    return [makeIssue(element.selector, url, "state-change-contrast",
      "No visual state change detectable on hover (WCAG 1.4.11 requires ≥3:1 non-text contrast)",
      "1.4.11")];
  }
  if (ratio < 3.0 && ratio > 0) {
    return [makeIssue(element.selector, url, "state-change-contrast",
      `Insufficient hover contrast ratio: ${ratio.toFixed(2)}:1 (WCAG 1.4.11 requires ≥3:1)`,
      "1.4.11")];
  }
  return [];
}

export function evaluateHoverFocus(
  element: ElementManifest,
  result: InteractionResult,
  url: string,
): Issue[] {
  if (!result.hoverPopup) return [];

  const issues: Issue[] = [];
  if (result.popupPersistent === false) {
    issues.push(makeIssue(element.selector, url, "hover-focus",
      "Hover content disappears before user can interact with it (WCAG 1.4.13)", "1.4.13"));
  }
  if (result.popupHoverable === false) {
    issues.push(makeIssue(element.selector, url, "hover-focus",
      "Hover content is not hoverable (WCAG 1.4.13)", "1.4.13"));
  }
  if (result.popupDismissible === false) {
    issues.push(makeIssue(element.selector, url, "hover-focus",
      "Hover content cannot be dismissed without moving focus (WCAG 1.4.13)", "1.4.13"));
  }
  return issues;
}

export function evaluateAriaStates(
  element: ElementManifest,
  result: InteractionResult,
  url: string,
): Issue[] {
  if (!element.hasAriaExpanded && !element.hasAriaPressed) return [];
  if (result.ariaStateChanged === undefined) return [];
  if (result.ariaStateChanged === false) {
    return [makeIssue(element.selector, url, "aria-states",
      "Element has aria-expanded/pressed but ARIA state did not change on click (WCAG 4.1.2)",
      "4.1.2")];
  }
  return [];
}

export function evaluateKeyboard(
  element: ElementManifest,
  result: InteractionResult,
  url: string,
  isFocusable: boolean = true,
): Issue[] {
  // Skip native interactive elements (keyboard handled by browser)
  if (isNativeInteractive(element.tag)) return [];
  // Skip elements that are neither custom role nor onclick
  if (!element.role && !element.hasOnclick) return [];

  // Pre-check: custom interactive element must be focusable
  if (!isFocusable) {
    return [makeIssue(element.selector, url, "custom-element-not-focusable",
      `Custom interactive element (${element.role ? `role="${element.role}"` : "[onclick]"}) is not keyboard focusable — needs tabindex="0" (WCAG 2.1.1)`,
      "2.1.1", "critical")];
  }

  if (result.keyboardResponded === false) {
    const label = element.role ? `role="${element.role}"` : "[onclick]";
    return [makeIssue(element.selector, url, "keyboard-operability",
      `Custom interactive element (${label}) does not respond to Enter/Space keyboard (WCAG 2.1.1)`,
      "2.1.1")];
  }
  return [];
}

async function captureAriaStates(page: Page, selector: string): Promise<Record<string, string | null>> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { "aria-expanded": null, "aria-pressed": null, "aria-selected": null, "aria-checked": null };
    return {
      "aria-expanded": el.getAttribute("aria-expanded"),
      "aria-pressed": el.getAttribute("aria-pressed"),
      "aria-selected": el.getAttribute("aria-selected"),
      "aria-checked": el.getAttribute("aria-checked"),
    };
  }, selector);
}

interface BatchedInteractionResult {
  hoverStyles: Record<string, string>;
  hoverPopup: PopupInfo | null;
  focusStyles: Record<string, string>;
  focusPopup: PopupInfo | null;
  popupBeforeSnapshot: boolean[];
}

/**
 * Batch hover + focus interactions into a single page.evaluate roundtrip.
 * For the common case (no popup), this replaces ~10 separate roundtrips with 1.
 */
async function batchedHoverFocus(
  page: Page,
  selector: string,
): Promise<BatchedInteractionResult | null> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    if (!el) return null;

    // --- Helper: capture computed styles ---
    function captureStylesOf(target: Element): Record<string, string> {
      const cs = getComputedStyle(target);
      return {
        backgroundColor: cs.backgroundColor,
        borderColor: cs.borderColor,
        outlineColor: cs.outlineColor,
        boxShadow: cs.boxShadow,
        textDecorationLine: cs.textDecorationLine,
        color: cs.color,
      };
    }

    // --- Helper: get popup candidates ---
    function getPopupCandidates(triggerEl: Element): Element[] {
      return [
        ...Array.from(triggerEl.children),
        triggerEl.nextElementSibling,
        triggerEl.parentElement?.querySelector('[role="tooltip"]'),
        triggerEl.parentElement?.querySelector('[class$="-tooltip"]'),
        triggerEl.parentElement?.querySelector('[class$="-popup"]'),
        triggerEl.parentElement?.querySelector('[class$="-popover"]'),
      ].filter(Boolean) as Element[];
    }

    // --- Helper: snapshot visibility of candidates ---
    function snapshotVisibility(candidates: Element[]): boolean[] {
      return candidates.map(c => {
        const style = getComputedStyle(c);
        return style.opacity !== "0" &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          c.getBoundingClientRect().height > 0;
      });
    }

    // --- Helper: detect popup (before→after) ---
    function findNewPopup(candidates: Element[], before: boolean[]): {
      selector: string;
      type: "css-transition";
      boundingBox: { x: number; y: number; width: number; height: number };
    } | null {
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const style = getComputedStyle(c);
        const nowVisible = style.opacity !== "0" &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          c.getBoundingClientRect().height > 0;
        const wasVisible = before[i] ?? false;
        if (nowVisible && !wasVisible) {
          const htmlEl = c as HTMLElement;
          const id = htmlEl.id ? `#${CSS.escape(htmlEl.id)}` : null;
          const cls = c.className && typeof c.className === "string"
            ? "." + c.className.split(" ").filter(Boolean).map(cl => CSS.escape(cl)).join(".")
            : "";
          const cSel = id || `${c.tagName.toLowerCase()}${cls}`;
          const rect = c.getBoundingClientRect();
          return {
            selector: cSel,
            type: "css-transition" as const,
            boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        }
      }
      return null;
    }

    const candidates = getPopupCandidates(el);

    // === HOVER ===
    const hoverBefore = snapshotVisibility(candidates);
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    // With animations disabled, styles are already computed synchronously
    const hoverStyles = captureStylesOf(el);
    const hoverPopup = findNewPopup(candidates, hoverBefore);
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));

    // === FOCUS ===
    const focusCandidates = getPopupCandidates(el);
    const focusBefore = snapshotVisibility(focusCandidates);
    el.focus();
    const focusStyles = captureStylesOf(el);
    const focusPopup = findNewPopup(focusCandidates, focusBefore);
    el.blur();

    return {
      hoverStyles,
      hoverPopup,
      focusStyles,
      focusPopup,
      popupBeforeSnapshot: hoverBefore,
    };
  }, selector);
}

export async function runTier2(
  page: Page,
  elements: ElementManifest[],
  url: string,
  timer: TierTimer,
  hfCache?: HoverFocusCache,
): Promise<{ issues: Issue[]; promotedToTier3: ElementManifest[]; hfHits: number; hfMisses: number }> {
  timer.startTier("tier2");
  const allIssues: Issue[] = [];
  const promotedToTier3: ElementManifest[] = [];
  let hfHits = 0;
  let hfMisses = 0;

  // Disable CSS animations/transitions so hover/focus style changes are instantaneous.
  // We only need final computed styles, not animation timing.
  await disableAnimations(page);

  for (const element of elements) {
    const result: InteractionResult = {};
    const handle = await page.$(element.selector);
    if (!handle) continue;

    try {
      // 1+2. HOVER + FOCUS — check cache first, then single page.evaluate roundtrip
      const elemHash = elementHashFromManifest(element);
      const hfCacheKey = `hf:${elemHash}`;
      const cachedHF = hfCache?.get(hfCacheKey);

      if (cachedHF && !cachedHF.hadPopup) {
        // Cache hit (no popup) — reuse styles, skip batchedHoverFocus
        hfHits++;
        result.hoverStyles = cachedHF.hoverStyles;
        result.focusStyles = cachedHF.focusStyles;
        result.hoverPopup = null;
        result.focusPopup = null;
        timer.recordInteraction("hovers");
        timer.recordInteraction("focuses");
      } else {
        // Cache miss or popup fingerprint — run real interaction
        hfMisses++;
        const batched = await batchedHoverFocus(page, element.selector);
        if (!batched) continue;

        result.hoverStyles = batched.hoverStyles;
        result.hoverPopup = batched.hoverPopup;
        result.focusStyles = batched.focusStyles;
        result.focusPopup = batched.focusPopup;
        timer.recordInteraction("hovers");
        timer.recordInteraction("focuses");

        // Store in cache (including whether popup was detected)
        hfCache?.set(hfCacheKey, {
          hoverStyles: result.hoverStyles ?? {},
          focusStyles: result.focusStyles ?? {},
          hadPopup: !!result.hoverPopup || !!result.focusPopup,
        });
      }

      // WCAG 1.4.13 sub-tests: persistence, hoverability, dismissibility.
      // Only entered on the rare path where a popup was detected.
      // These use page.mouse.move() (real pointer movement) because we need to test
      // actual mouse interaction behavior (dispatchEvent doesn't activate CSS :hover).
      if (result.hoverPopup) {
        const popup = result.hoverPopup;
        const triggerBox = element.boundingBox;

        // Re-trigger hover with real mouse to ensure browser :hover is active
        await page.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
        await adaptiveWait(page, popup.selector, "re-hover-real", 200);

        // 1. PERSISTENCE: move mouse away from trigger, check if popup stays
        await page.mouse.move(Math.max(0, triggerBox.x - 50), Math.max(0, triggerBox.y - 50));
        await adaptiveWait(page, popup.selector, "persistence", 300);
        const stillVisible = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const cs = getComputedStyle(el);
          return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0"
            && el.getBoundingClientRect().height > 0;
        }, popup.selector);
        result.popupPersistent = stillVisible;

        // 2. HOVERABILITY: move mouse to popup, check if it remains
        if (stillVisible) {
          const popupBox = popup.boundingBox;
          await page.mouse.move(popupBox.x + popupBox.width / 2, popupBox.y + popupBox.height / 2);
          await adaptiveWait(page, popup.selector, "hoverability", 100);
          result.popupHoverable = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const cs = getComputedStyle(el);
            return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0"
              && el.getBoundingClientRect().height > 0;
          }, popup.selector);
        } else {
          result.popupHoverable = false;
        }

        // 3. DISMISSIBILITY: press Escape, check if popup closes
        await page.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
        await adaptiveWait(page, popup.selector, "re-hover", 200);
        await page.keyboard.press("Escape");
        await adaptiveWait(page, popup.selector, "dismiss", 200);
        const dismissed = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return true; // element removed = dismissed
          const cs = getComputedStyle(el);
          return cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0"
            || el.getBoundingClientRect().height === 0;
        }, popup.selector);
        result.popupDismissible = dismissed;
      }

      // 3. CLICK (only for aria-expanded/pressed elements, with safety guard)
      if (element.hasAriaExpanded || element.hasAriaPressed) {
        const isSafe = await handle.evaluate((el: Element) => {
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute("type");
          const text = (el.textContent || "").toLowerCase();
          if (tag === "input" && type === "submit") return false;
          if (/delete|remove|cancel|logout|sign.?out/i.test(text)) return false;
          if (tag === "a" && el.getAttribute("target") === "_blank") return false;
          return true;
        });

        if (isSafe) {
          const before = await captureAriaStates(page, element.selector);
          await handle.click({ force: true, timeout: 2000 });
          await adaptiveWait(page, element.selector, "click", 100);
          const after = await captureAriaStates(page, element.selector);
          result.ariaStateChanged = JSON.stringify(before) !== JSON.stringify(after);
          if (result.ariaStateChanged && after["aria-expanded"] !== before["aria-expanded"]) {
            await handle.click({ force: true, timeout: 2000 }).catch(() => {});
            await adaptiveWait(page, element.selector, "reset", 50);
          }
          timer.recordInteraction("clicks");
        }
      }

      // 4. KEYBOARD (custom interactive elements + onclick without role)
      const isCustomInteractive = (element.role && !isNativeInteractive(element.tag)) ||
                                   (!element.role && element.hasOnclick);
      if (isCustomInteractive) {
        // Pre-check focusability
        const isFocusable = await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement;
          if (!el) return false;
          if (el.tabIndex >= 0) return true;
          return false;
        }, element.selector);

        if (isFocusable) {
          await page.evaluate((sel) => {
            (document.querySelector(sel) as HTMLElement)?.focus();
          }, element.selector);
          const urlBefore = page.url();
          const originBefore = new URL(urlBefore).origin;
          await page.keyboard.press("Enter");
          await adaptiveWait(page, element.selector, "keyboard", 100);
          const urlAfter = page.url();
          const navigated = urlAfter !== urlBefore;
          result.keyboardResponded = navigated || !!result.ariaStateChanged;
          if (navigated) {
            const originAfter = new URL(urlAfter).origin;
            if (originAfter === originBefore) {
              await page.goBack({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
            } else {
              await page.goto(urlBefore, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
            }
          }
        }

        timer.recordInteraction("keyboardTests");
        allIssues.push(...evaluateKeyboard(element, result, url, isFocusable));
      }

      allIssues.push(...evaluateStateChange(element, result, url));
      allIssues.push(...evaluateHoverFocus(element, result, url));
      allIssues.push(...evaluateAriaStates(element, result, url));
    } catch {
      // Element interaction failed — skip
    } finally {
      await handle.dispose();
    }
  }

  timer.endTier("tier2", {
    issuesFound: allIssues.length,
    elementsPromotedToTier3: promotedToTier3.length,
    avgWaitMs: 150,
  });

  return { issues: allIssues, promotedToTier3, hfHits, hfMisses };
}
