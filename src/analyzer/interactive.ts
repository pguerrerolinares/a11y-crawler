import { createHash } from "node:crypto";
import type { Page } from "playwright";
import type { Issue } from "../types/issue.ts";

/**
 * Run all interactive accessibility tests on a page.
 * Each test is isolated — failures in one don't affect others.
 */
export async function runInteractiveTests(page: Page, pageUrl: string): Promise<Issue[]> {
  const results: Issue[] = [];

  const tests = [
    testTabOrder,
    testFocusVisibility,
    testSkipNavigation,
  ];

  for (const testFn of tests) {
    try {
      const issues = await testFn(page, pageUrl);
      results.push(...issues);
    } catch (err) {
      console.warn(`Interactive test ${testFn.name} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return results;
}

// --- Helper ---

function createInteractiveIssue(opts: {
  url: string;
  rule: string;
  impact: "critical" | "serious" | "moderate" | "minor";
  description: string;
  selector: string;
  help: string;
  wcagCriterion: string;
}): Issue {
  const hash = createHash("md5").update(opts.url + opts.selector + opts.rule).digest("hex").slice(0, 8);
  return {
    id: `interactive-${opts.rule}-${hash}`,
    url: opts.url,
    rule: opts.rule,
    impact: opts.impact,
    description: opts.description,
    help: opts.help,
    helpUrl: `https://www.w3.org/WAI/WCAG22/Understanding/${opts.wcagCriterion}`,
    wcagTags: [opts.wcagCriterion],
    selector: opts.selector,
    html: "",
    surroundingHtml: "",
    xpath: "",
    viewportWidth: 1280,
    pageTitle: "",
    checkSource: "interactive",
    suggestedFix: null,
    fixConfidence: null,
    violationCategory: "interactive",
    llmConfidence: null,
    wcagCriterion: opts.wcagCriterion,
  };
}

// --- Tab Order Test ---

async function testTabOrder(page: Page, pageUrl: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const focusSequence: Array<{ selector: string; tabindex: string | null; isVisible: boolean }> = [];
  const MAX_TABS = 50;

  // Start from body to reset focus
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.());

  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press("Tab");

    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const rect = el.getBoundingClientRect();

      // Generate a basic CSS selector
      let selector = el.tagName.toLowerCase();
      if (el.id) selector = `#${el.id}`;
      else if (el.className && typeof el.className === "string") {
        const cls = el.className.trim().split(/\s+/).slice(0, 3).join(".");
        if (cls) selector = `${el.tagName.toLowerCase()}.${cls}`;
      }

      return {
        selector,
        tabindex: el.getAttribute("tabindex"),
        isVisible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top < window.innerHeight,
        text: (el.textContent || "").trim().slice(0, 30),
      };
    });

    if (!focused) continue;

    // Positive tabindex disrupts natural order
    if (focused.tabindex && parseInt(focused.tabindex) > 0) {
      issues.push(createInteractiveIssue({
        url: pageUrl,
        rule: "tabindex-positive",
        impact: "serious",
        description: `Element has tabindex="${focused.tabindex}" which disrupts natural tab order`,
        selector: focused.selector,
        help: "Avoid tabindex values greater than 0. Use tabindex='0' or '-1' instead.",
        wcagCriterion: "focus-order",
      }));
    }

    // Focus on invisible element
    if (!focused.isVisible) {
      issues.push(createInteractiveIssue({
        url: pageUrl,
        rule: "focus-not-visible",
        impact: "serious",
        description: `Focus moved to non-visible element: ${focused.selector}`,
        selector: focused.selector,
        help: "All focusable elements should be visible when focused.",
        wcagCriterion: "focus-visible",
      }));
    }

    focusSequence.push(focused);

    // Detect keyboard trap — same 3 elements cycling
    if (focusSequence.length >= 6) {
      const last3 = focusSequence.slice(-3).map((f) => f.selector);
      const prev3 = focusSequence.slice(-6, -3).map((f) => f.selector);
      if (JSON.stringify(last3) === JSON.stringify(prev3)) {
        issues.push(createInteractiveIssue({
          url: pageUrl,
          rule: "keyboard-trap",
          impact: "critical",
          description: `Keyboard trap detected: focus cycles between ${[...new Set(last3)].join(", ")}`,
          selector: last3[0],
          help: "Users must be able to navigate away from all components using keyboard.",
          wcagCriterion: "no-keyboard-trap",
        }));
        break;
      }
    }
  }

  return issues;
}

// --- Focus Visibility Test ---

async function testFocusVisibility(page: Page, pageUrl: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const SAMPLE_LIMIT = 15;

  const elements = await page.$$(
    'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex="0"]',
  );
  const sample = elements.slice(0, SAMPLE_LIMIT);

  for (const el of sample) {
    try {
      // Get styles before focus
      const before = await el.evaluate((e) => {
        const cs = getComputedStyle(e);
        return { outline: cs.outline, boxShadow: cs.boxShadow, border: cs.border };
      });

      await el.focus();

      // Get styles after focus
      const after = await el.evaluate((e) => {
        const cs = getComputedStyle(e);
        return { outline: cs.outline, boxShadow: cs.boxShadow, border: cs.border };
      });

      const noChange =
        before.outline === after.outline &&
        before.boxShadow === after.boxShadow &&
        before.border === after.border;

      // Flag only when NO visual property changed on focus
      // (outline being "none" is fine if box-shadow or border provides indication)
      if (noChange) {
        const selector = await el.evaluate((e) => {
          if (e.id) return `#${e.id}`;
          const tag = e.tagName.toLowerCase();
          if (e.className && typeof e.className === "string") {
            const cls = e.className.trim().split(/\s+/).slice(0, 3).join(".");
            if (cls) return `${tag}.${cls}`;
          }
          return tag;
        });

        issues.push(createInteractiveIssue({
          url: pageUrl,
          rule: "focus-indicator-missing",
          impact: "serious",
          description: `Element "${selector}" has no visible focus indicator`,
          selector,
          help: "Interactive elements must have a visible focus indicator when focused.",
          wcagCriterion: "focus-visible",
        }));
      }
    } catch {
      // Element may have been removed from DOM — skip
    }
  }

  return issues;
}

// --- Skip Navigation Test ---

async function testSkipNavigation(page: Page, pageUrl: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Check for skip link existence
  const skipLink = await page.$(
    'a[href^="#"]:first-of-type, a.skip-link, a.skip-nav, a[class*="skip"]',
  );

  if (!skipLink) {
    // Check if there's significant content before main
    const hasNav = await page.$("nav, [role='navigation']");
    if (hasNav) {
      issues.push(createInteractiveIssue({
        url: pageUrl,
        rule: "skip-navigation-missing",
        impact: "moderate",
        description: "Page has navigation but no skip navigation link",
        selector: "body",
        help: "Provide a mechanism to bypass repeated blocks of content.",
        wcagCriterion: "bypass-blocks",
      }));
    }
  } else {
    // Verify skip link target exists
    const href = await skipLink.evaluate((el) => el.getAttribute("href"));
    if (href && href.startsWith("#") && href.length > 1) {
      const targetId = href.slice(1);
      const targetExists = await page.$(`[id="${targetId}"]`);
      if (!targetExists) {
        issues.push(createInteractiveIssue({
          url: pageUrl,
          rule: "skip-navigation-broken",
          impact: "serious",
          description: `Skip link points to #${targetId} but target element does not exist`,
          selector: `a[href="${href}"]`,
          help: "Skip navigation link target must exist on the page.",
          wcagCriterion: "bypass-blocks",
        }));
      }
    }
  }

  return issues;
}

// --- Keyboard Operability Test ---

async function testKeyboardOperability(page: Page, pageUrl: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Find custom interactive elements (non-native) that should be keyboard accessible
  const suspects = await page.$$eval(
    '[role="button"], [role="tab"], [role="menuitem"], [role="link"], [onclick]',
    (elements) =>
      elements
        .filter((el) => {
          const tag = el.tagName.toLowerCase();
          // Skip native interactive elements — already keyboard accessible
          return !["a", "button", "input", "select", "textarea", "summary"].includes(tag);
        })
        .slice(0, 8)
        .map((el) => {
          let selector = el.tagName.toLowerCase();
          if (el.id) selector = `#${el.id}`;
          else if (el.className && typeof el.className === "string") {
            const cls = el.className.trim().split(/\s+/).slice(0, 3).join(".");
            if (cls) selector = `${el.tagName.toLowerCase()}.${cls}`;
          }
          return {
            selector,
            role: el.getAttribute("role"),
            tabindex: el.getAttribute("tabindex"),
          };
        }),
  );

  for (const suspect of suspects) {
    // Not focusable at all — critical issue
    if (suspect.tabindex === null || parseInt(suspect.tabindex) < 0) {
      issues.push(createInteractiveIssue({
        url: pageUrl,
        rule: "custom-element-not-focusable",
        impact: "critical",
        description: `Custom ${suspect.role || "interactive"} element is not keyboard focusable`,
        selector: suspect.selector,
        help: "Custom interactive elements must be focusable via tabindex='0'.",
        wcagCriterion: "keyboard",
      }));
      continue;
    }

    // Focusable — test if Enter/Space triggers it
    try {
      const handle = await page.$(suspect.selector);
      if (!handle) continue;

      await handle.focus();
      const urlBefore = page.url();

      // Snapshot: aria-expanded, aria-pressed, aria-checked on the element
      const stateBefore = await handle.evaluate((el) => ({
        ariaExpanded: el.getAttribute("aria-expanded"),
        ariaPressed: el.getAttribute("aria-pressed"),
        ariaChecked: el.getAttribute("aria-checked"),
      }));

      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);

      const urlAfter = page.url();

      // URL changed = element is operable (navigation occurred)
      if (urlAfter !== urlBefore) {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
        continue; // Not a violation — element worked
      }

      // Check if any ARIA state changed
      const stateAfter = await handle.evaluate((el) => ({
        ariaExpanded: el.getAttribute("aria-expanded"),
        ariaPressed: el.getAttribute("aria-pressed"),
        ariaChecked: el.getAttribute("aria-checked"),
      })).catch(() => stateBefore);

      const stateChanged =
        stateBefore.ariaExpanded !== stateAfter.ariaExpanded ||
        stateBefore.ariaPressed !== stateAfter.ariaPressed ||
        stateBefore.ariaChecked !== stateAfter.ariaChecked;

      // Check if the aria-controls target is now visible
      const controlledAppeared = await handle.evaluate((el) => {
        const controlsId = el.getAttribute("aria-controls");
        if (controlsId) {
          const target = document.getElementById(controlsId);
          if (target) return getComputedStyle(target).display !== "none";
        }
        return false;
      }).catch(() => false);

      if (!stateChanged && !controlledAppeared) {
        issues.push(createInteractiveIssue({
          url: pageUrl,
          rule: "keyboard-operability",
          impact: "critical",
          description: `Element with role="${suspect.role}" does not respond to keyboard activation (Enter key)`,
          selector: suspect.selector,
          help: "All interactive elements must be operable via keyboard (Enter/Space).",
          wcagCriterion: "keyboard",
        }));
      }
    } catch {
      // Element interaction failed — skip
    }
  }

  return issues;
}
