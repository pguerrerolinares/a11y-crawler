import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import type { ElementManifest, InteractionResult, PopupInfo } from "../types/manifest";
import type { TierTimer } from "./tier-timer";
import { adaptiveWait, disableAnimations } from "./adaptive-wait";
import { parseRgba, alphaBlend, relativeLuminance, contrastRatio } from "../analyzer/contrast";

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
  return {
    id: `${rule}-${selector}-${Date.now()}`,
    url,
    rule,
    impact,
    description,
    help: description,
    helpUrl: `https://www.w3.org/WAI/WCAG22/Understanding/${wcagCriterion.replace(".", "")}`,
    wcagTags: [wcagCriterion],
    selector,
    html: "",
    surroundingHtml: "",
    xpath: "",
    viewportWidth: 1280,
    pageTitle: "",
    checkSource: "interactive",
    suggestedFix: null,
    fixConfidence: null,
    llmConfidence: null,
    wcagCriterion,
    violationCategory: "interactive",
  };
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
): Issue[] {
  if (!element.role || isNativeInteractive(element.tag)) return [];
  if (result.keyboardResponded === false) {
    return [makeIssue(element.selector, url, "keyboard-operability",
      `Custom interactive element (role="${element.role}") does not respond to Enter/Space keyboard (WCAG 2.1.1)`,
      "2.1.1")];
  }
  return [];
}

async function captureStyles(page: Page, selector: string): Promise<Record<string, string>> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return {};
    const cs = getComputedStyle(el);
    return {
      backgroundColor: cs.backgroundColor,
      borderColor: cs.borderColor,
      outlineColor: cs.outlineColor,
      boxShadow: cs.boxShadow,
      textDecorationLine: cs.textDecorationLine,
      color: cs.color,
    };
  }, selector);
}

async function captureAriaStates(page: Page, selector: string): Promise<Record<string, string | null>> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return {};
    return {
      "aria-expanded": el.getAttribute("aria-expanded"),
      "aria-pressed": el.getAttribute("aria-pressed"),
      "aria-selected": el.getAttribute("aria-selected"),
      "aria-checked": el.getAttribute("aria-checked"),
    };
  }, selector);
}

async function detectPopup(page: Page, trigger: ElementManifest): Promise<PopupInfo | null> {
  return await page.evaluate((sel) => {
    const triggerEl = document.querySelector(sel);
    if (!triggerEl) return null;

    const candidates = [
      ...Array.from(triggerEl.children),
      triggerEl.nextElementSibling,
      triggerEl.parentElement?.querySelector('[role="tooltip"]'),
      triggerEl.parentElement?.querySelector('[class$="-tooltip"]'),
      triggerEl.parentElement?.querySelector('[class$="-popup"]'),
      triggerEl.parentElement?.querySelector('[class$="-popover"]'),
    ].filter(Boolean) as Element[];

    for (const el of candidates) {
      const style = getComputedStyle(el);
      if (style.opacity !== "0" &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        el.getBoundingClientRect().height > 0) {
        const id = (el as HTMLElement).id ? `#${CSS.escape((el as HTMLElement).id)}` : null;
        const cls = el.className && typeof el.className === "string"
          ? "." + el.className.split(" ").filter(Boolean).map(c => CSS.escape(c)).join(".")
          : "";
        const selector = id || `${el.tagName.toLowerCase()}${cls}`;
        const rect = el.getBoundingClientRect();
        return {
          selector,
          type: "css-transition" as const,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      }
    }
    return null;
  }, trigger.selector);
}

export async function runTier2(
  page: Page,
  elements: ElementManifest[],
  url: string,
  timer: TierTimer,
): Promise<{ issues: Issue[]; promotedToTier3: ElementManifest[] }> {
  timer.startTier("tier2");
  const allIssues: Issue[] = [];
  const promotedToTier3: ElementManifest[] = [];

  // Disable CSS animations/transitions so hover/focus style changes are instantaneous.
  // We only need final computed styles, not animation timing.
  await disableAnimations(page);

  for (const element of elements) {
    const result: InteractionResult = {};
    const handle = await page.$(element.selector);
    if (!handle) continue;

    try {
      // 1. HOVER
      await handle.hover();
      await adaptiveWait(page, element.selector, "hover", 200);
      result.hoverStyles = await captureStyles(page, element.selector);
      result.hoverPopup = await detectPopup(page, element);
      await page.mouse.move(0, 0);
      await adaptiveWait(page, element.selector, "reset", 100);
      timer.recordInteraction("hovers");

      // 2. FOCUS
      await handle.focus();
      await adaptiveWait(page, element.selector, "focus", 200);
      result.focusStyles = await captureStyles(page, element.selector);
      result.focusPopup = await detectPopup(page, element);
      await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement)?.blur(); }, element.selector);
      timer.recordInteraction("focuses");

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
          await handle.click();
          await adaptiveWait(page, element.selector, "click", 300);
          const after = await captureAriaStates(page, element.selector);
          result.ariaStateChanged = JSON.stringify(before) !== JSON.stringify(after);
          if (result.ariaStateChanged && after["aria-expanded"] !== before["aria-expanded"]) {
            await handle.click().catch(() => {});
            await adaptiveWait(page, element.selector, "reset", 200);
          }
          timer.recordInteraction("clicks");
        }
      }

      // 4. KEYBOARD (only for custom interactive elements)
      if (element.role && !isNativeInteractive(element.tag)) {
        await handle.focus();
        const urlBefore = page.url();
        const originBefore = new URL(urlBefore).origin;
        await page.keyboard.press("Enter");
        await adaptiveWait(page, element.selector, "keyboard", 300);
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
        timer.recordInteraction("keyboardTests");
      }

      allIssues.push(...evaluateStateChange(element, result, url));
      allIssues.push(...evaluateHoverFocus(element, result, url));
      allIssues.push(...evaluateAriaStates(element, result, url));
      allIssues.push(...evaluateKeyboard(element, result, url));
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

  return { issues: allIssues, promotedToTier3 };
}
