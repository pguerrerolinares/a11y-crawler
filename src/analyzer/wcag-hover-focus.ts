// src/analyzer/wcag-hover-focus.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";

function makeHoverIssue(
  url: string, rule: string, description: string, selector: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule,
    impact: "serious", description,
    help: "Content that appears on hover/focus must be persistent, hoverable, and dismissible.",
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus",
    wcagTags: ["wcag1413"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 1280, pageTitle: "",
    checkSource: "interactive",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "1.4.13",
    violationCategory: "interactive",
  };
}

/**
 * WCAG 1.4.13 — Content on Hover or Focus:
 * Test that tooltip/popover content triggered by hover is:
 * 1. PERSISTENT — stays visible while hover/focus is maintained
 * 2. HOVERABLE — pointer can move to the popup without it disappearing
 * 3. DISMISSIBLE — can be closed without moving pointer (Escape key)
 *
 * Exception: native `title` attribute tooltips are exempt (user-agent controlled).
 */
export async function testHoverFocus(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Discover trigger candidates
  const triggers = await page.evaluate(() => {
    const results: Array<{
      selector: string;
      text: string;
      isNativeTitle: boolean;
    }> = [];

    // Explicit tooltip triggers (testable)
    document.querySelectorAll(
      "[aria-describedby], [data-tooltip], [data-tippy-content], [data-popover], [aria-haspopup='dialog']",
    ).forEach((el) => {
      const selector =
        el.id ? `#${el.id}` :
        el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : el.tagName.toLowerCase();

      results.push({
        selector,
        text: (el.textContent ?? "").trim().slice(0, 30),
        isNativeTitle: false,
      });
    });

    return results.slice(0, 5); // limit interactions to keep probe fast
  });

  for (const trigger of triggers) {
    if (trigger.isNativeTitle) continue; // exempt

    try {
      const handle = await page.$(trigger.selector);
      if (!handle) continue;

      // Inject MutationObserver to detect appearing content
      await page.evaluate(() => {
        (window as any).__hoverPopup = null;
        const obs = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              const el = node as Element;
              const role = el.getAttribute("role");
              if (role === "tooltip" || role === "dialog" ||
                  el.classList.contains("tooltip") ||
                  el.classList.contains("popover") ||
                  el.classList.contains("tippy-box")) {
                (window as any).__hoverPopup = {
                  selector: el.id ? `#${el.id}` : `.${el.className?.split(" ")[0] ?? "unknown"}`,
                  found: true,
                };
              }
            }
            // Also check visibility changes
            if (m.type === "attributes" && m.target.nodeType === Node.ELEMENT_NODE) {
              const el = m.target as Element;
              const role = el.getAttribute("role");
              if (role === "tooltip" && getComputedStyle(el).display !== "none") {
                (window as any).__hoverPopup = {
                  selector: el.id ? `#${el.id}` : `[role="tooltip"]`,
                  found: true,
                };
              }
            }
          }
        });
        obs.observe(document.body, {
          childList: true, subtree: true,
          attributes: true, attributeFilter: ["style", "class", "aria-hidden", "hidden"],
        });
        (window as any).__hoverObs = obs;
      });

      // Hover to trigger
      await handle.hover();
      await page.waitForTimeout(500);

      const popup = await page.evaluate(() => {
        (window as any).__hoverObs?.disconnect();
        return (window as any).__hoverPopup;
      });

      if (!popup?.found) continue; // no popup appeared — nothing to test

      const popupSelector = popup.selector;

      // --- TEST 1: PERSISTENT ---
      // Re-hover trigger, wait 1.5 seconds, check if popup still visible
      await handle.hover();
      await page.waitForTimeout(1500);
      const stillVisible = await page.$(popupSelector)
        .then((el) => el?.isVisible() ?? false)
        .catch(() => false);

      if (!stillVisible) {
        issues.push(makeHoverIssue(url, "hover-focus-not-persistent",
          `Tooltip/popup triggered by "${trigger.text}" (${trigger.selector}) auto-closes before user dismisses it`,
          trigger.selector));
        continue; // can't test hoverable/dismissible if popup already gone
      }

      // --- TEST 2: HOVERABLE ---
      // Move pointer from trigger to popup
      try {
        const popupEl = await page.$(popupSelector);
        if (popupEl) {
          await popupEl.hover();
          await page.waitForTimeout(300);
          const popupStillVisible = await popupEl.isVisible();
          if (!popupStillVisible) {
            issues.push(makeHoverIssue(url, "hover-focus-not-hoverable",
              `Tooltip/popup triggered by "${trigger.text}" disappears when pointer moves to it (not hoverable)`,
              trigger.selector));
          }
        }
      } catch {
        // popup might have disappeared — flag as not hoverable
        issues.push(makeHoverIssue(url, "hover-focus-not-hoverable",
          `Tooltip/popup triggered by "${trigger.text}" disappears when pointer moves away from trigger`,
          trigger.selector));
      }

      // --- TEST 3: DISMISSIBLE ---
      // Re-hover trigger, then press Escape
      await handle.hover();
      await page.waitForTimeout(500);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const dismissedVisible = await page.$(popupSelector)
        .then((el) => el?.isVisible() ?? false)
        .catch(() => false);

      if (dismissedVisible) {
        // Check exemption: does popup overlap other content?
        const overlaps = await page.evaluate((sel) => {
          const popup = document.querySelector(sel);
          if (!popup) return false;
          const rect = popup.getBoundingClientRect();
          const elements = document.elementsFromPoint(
            rect.x + rect.width / 2, rect.y + rect.height / 2,
          );
          return elements.some((el) =>
            el !== popup && !popup.contains(el) && (el.textContent?.trim().length ?? 0) > 0,
          );
        }, popupSelector);

        if (overlaps) {
          issues.push(makeHoverIssue(url, "hover-focus-not-dismissible",
            `Tooltip/popup triggered by "${trigger.text}" cannot be dismissed with Escape key`,
            trigger.selector));
        }
        // If no overlap, dismissibility is not required per WCAG 1.4.13
      }

    } catch {
      // Interaction sequence failed — disconnect observer and skip this trigger
      await page.evaluate(() => (window as any).__hoverObs?.disconnect()).catch(() => {});
    }
  }

  return issues;
}
