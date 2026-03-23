// src/analyzer/wcag-hover-focus.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";
import { makeWcagIssue } from "./utils";

function makeHoverIssue(
  url: string, rule: string, description: string, selector: string,
): Issue {
  return makeWcagIssue(url, rule, "serious", description, selector, "1.4.13", "interactive", {
    checkSource: "interactive",
  });
}

interface TriggerCandidate {
  selector: string;
  text: string;
  source: "attribute" | "css-hidden-child";
}

/**
 * WCAG 1.4.13 — Content on Hover or Focus:
 * Test that tooltip/popover content triggered by hover is:
 * 1. PERSISTENT — stays visible while hover/focus is maintained
 * 2. HOVERABLE — pointer can move to the popup without it disappearing
 * 3. DISMISSIBLE — can be closed without moving pointer (Escape key)
 *
 * Detects both JS-triggered popups (MutationObserver) and CSS-only popups
 * (before/after visibility snapshot on :hover).
 */
export async function testHoverFocus(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Discover trigger candidates from two sources
  const triggers = await page.evaluate(() => {
    const results: TriggerCandidate[] = [];
    const seen = new Set<string>();

    function buildSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      if (el.className && typeof el.className === "string") {
        return `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`;
      }
      return el.tagName.toLowerCase();
    }

    function addCandidate(el: Element, source: TriggerCandidate["source"]) {
      const selector = buildSelector(el);
      if (seen.has(selector)) return;
      seen.add(selector);
      results.push({
        selector,
        text: (el.textContent ?? "").trim().slice(0, 30),
        source,
      });
    }

    // Source 1: Explicit tooltip/popover triggers (JS-based)
    document.querySelectorAll(
      "[aria-describedby], [data-tooltip], [data-tippy-content], [data-popover], [aria-haspopup='dialog']",
    ).forEach((el) => addCandidate(el, "attribute"));

    // Source 2: CSS-only popup triggers — elements with hidden children
    // that look like tooltips/popovers/dropdowns
    const cssPopupSelectors = [
      "[class*='tooltip']", "[class*='popover']", "[class*='dropdown']",
      "[class*='submenu']", "[class*='overlay']", "[class*='hover']",
    ];
    for (const sel of cssPopupSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        // Check if this element or its parent has hidden children
        const container = el.parentElement ?? el;
        for (const child of container.children) {
          const style = getComputedStyle(child);
          if (style.display === "none" || style.opacity === "0" || style.visibility === "hidden") {
            // Hidden child found — the container is a potential CSS popup trigger
            addCandidate(container, "css-hidden-child");
            break;
          }
        }
      });
    }

    // Source 3: Any interactive element with a hidden next sibling
    document.querySelectorAll("a, button, [tabindex]").forEach((el) => {
      const next = el.nextElementSibling;
      if (!next) return;
      const style = getComputedStyle(next);
      if (style.display === "none" || style.opacity === "0" || style.visibility === "hidden") {
        const role = next.getAttribute("role");
        const cls = next.className?.toString() ?? "";
        if (role === "tooltip" || role === "dialog" || role === "menu" ||
            /tooltip|popover|dropdown|menu|popup/i.test(cls)) {
          addCandidate(el, "css-hidden-child");
        }
      }
    });

    return results.slice(0, 8);
  });

  for (const trigger of triggers) {
    try {
      const handle = await page.$(trigger.selector);
      if (!handle) continue;

      // Reset globals at start of each trigger iteration
      await page.evaluate(() => {
        (window as any).__hoverPopup = null;
        (window as any).__hoverObs?.disconnect();
        (window as any).__hoverObs = null;
      });

      // Snapshot visibility of potential popup elements BEFORE hover
      const beforeSnapshot = await page.evaluate((sel) => {
        const trigger = document.querySelector(sel);
        if (!trigger) return [];
        const candidates = [
          ...Array.from(trigger.children),
          trigger.nextElementSibling,
          trigger.parentElement?.querySelector('[role="tooltip"]'),
          trigger.parentElement?.querySelector('[class*="tooltip"]'),
          trigger.parentElement?.querySelector('[class*="popover"]'),
          trigger.parentElement?.querySelector('[class*="popup"]'),
        ].filter(Boolean) as Element[];

        return candidates.map(c => {
          const style = getComputedStyle(c);
          const sel = c.id ? `#${c.id}` :
            c.className && typeof c.className === "string"
              ? `${c.tagName.toLowerCase()}.${c.className.trim().split(/\s+/).slice(0, 3).join(".")}`
              : c.tagName.toLowerCase();
          return {
            selector: sel,
            wasVisible: style.opacity !== "0" && style.visibility !== "hidden" &&
              style.display !== "none" && c.getBoundingClientRect().height > 0,
          };
        });
      }, trigger.selector);

      // Inject MutationObserver to detect JS-triggered popups
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

      // Hover to trigger (real mouse — activates CSS :hover)
      await handle.hover();
      await page.waitForTimeout(500);

      // Check 1: MutationObserver detected a JS popup?
      const mutationPopup = await page.evaluate(() => {
        (window as any).__hoverObs?.disconnect();
        return (window as any).__hoverPopup;
      });

      // Check 2: CSS-only popup — before/after visibility comparison
      let popupSelector: string | null = null;
      if (mutationPopup?.found) {
        popupSelector = mutationPopup.selector;
      } else {
        // Check if any previously-hidden elements became visible (CSS :hover transition)
        const cssPopup = await page.evaluate((candidates) => {
          for (const c of candidates) {
            if (c.wasVisible) continue; // was already visible, skip
            const el = document.querySelector(c.selector);
            if (!el) continue;
            const style = getComputedStyle(el);
            const nowVisible = style.opacity !== "0" && style.visibility !== "hidden" &&
              style.display !== "none" && el.getBoundingClientRect().height > 0;
            if (nowVisible) {
              return { selector: c.selector, found: true };
            }
          }
          return null;
        }, beforeSnapshot);

        if (cssPopup?.found) {
          popupSelector = cssPopup.selector;
        }
      }

      if (!popupSelector) continue; // no popup appeared — nothing to test

      // --- TEST 1: PERSISTENT ---
      await handle.hover();
      await page.waitForTimeout(1500);
      const stillVisible = await page.$(popupSelector)
        .then((el) => el?.isVisible() ?? false)
        .catch(() => false);

      if (!stillVisible) {
        issues.push(makeHoverIssue(url, "hover-focus-not-persistent",
          `Tooltip/popup triggered by "${trigger.text}" (${trigger.selector}) auto-closes before user dismisses it`,
          trigger.selector));
        continue;
      }

      // --- TEST 2: HOVERABLE ---
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
        issues.push(makeHoverIssue(url, "hover-focus-not-hoverable",
          `Tooltip/popup triggered by "${trigger.text}" disappears when pointer moves away from trigger`,
          trigger.selector));
      }

      // --- TEST 3: DISMISSIBLE ---
      await handle.hover();
      await page.waitForTimeout(500);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const dismissedVisible = await page.$(popupSelector)
        .then((el) => el?.isVisible() ?? false)
        .catch(() => false);

      if (dismissedVisible) {
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
      }

    } catch {
      // Interaction sequence failed — skip this trigger
    } finally {
      await page.evaluate(() => {
        (window as any).__hoverObs?.disconnect();
        delete (window as any).__hoverPopup;
        delete (window as any).__hoverObs;
      }).catch(() => {});
    }
  }

  return issues;
}
