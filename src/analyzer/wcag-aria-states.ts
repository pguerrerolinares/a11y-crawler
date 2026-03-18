// src/analyzer/wcag-aria-states.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";

function makeAriaIssue(
  url: string, description: string, selector: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule: "aria-state-missing",
    impact: "serious", description,
    help: "Interactive widgets must update ARIA states (aria-expanded, aria-selected, aria-pressed) on interaction.",
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value",
    wcagTags: ["wcag412"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 1280, pageTitle: "",
    checkSource: "interactive",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "4.1.2",
    violationCategory: "interactive",
  };
}

/**
 * WCAG 4.1.2 — Name, Role, Value (dynamic states):
 * Verify that interactive widgets update ARIA states after interaction.
 *
 * Finds elements with aria-haspopup or aria-expanded and clicks them,
 * then verifies aria-expanded changes and controlled element becomes visible.
 */
export async function testAriaStates(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Find expandable triggers
  const triggers = await page.evaluate(() => {
    const results: Array<{
      selector: string;
      text: string;
      hasAriaExpanded: boolean;
      initialExpanded: string | null;
      ariaControls: string | null;
    }> = [];

    document.querySelectorAll(
      "[aria-haspopup], [aria-expanded], button[aria-controls], [role='tab']",
    ).forEach((el) => {
      // Skip native <details>/<summary>
      if (el.closest("details")) return;

      const selector =
        el.id ? `#${el.id}` :
        el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : el.tagName.toLowerCase();

      results.push({
        selector,
        text: (el.textContent ?? "").trim().slice(0, 30),
        hasAriaExpanded: el.hasAttribute("aria-expanded"),
        initialExpanded: el.getAttribute("aria-expanded"),
        ariaControls: el.getAttribute("aria-controls"),
      });
    });

    return results.slice(0, 6); // limit to avoid excessive interaction
  });

  for (const trigger of triggers) {
    try {
      const handle = await page.$(trigger.selector);
      if (!handle) continue;

      // Record initial state
      const before = await handle.evaluate((el) => ({
        expanded: el.getAttribute("aria-expanded"),
        pressed: el.getAttribute("aria-pressed"),
        selected: el.getAttribute("aria-selected"),
      }));

      // Click
      const urlBefore = page.url();
      await handle.click();
      await page.waitForTimeout(500);

      // If navigated, go back and skip
      if (page.url() !== urlBefore) {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
        continue;
      }

      // Record after state
      const after = await handle.evaluate((el) => ({
        expanded: el.getAttribute("aria-expanded"),
        pressed: el.getAttribute("aria-pressed"),
        selected: el.getAttribute("aria-selected"),
      })).catch(() => before);

      // Check: has aria-haspopup but no aria-expanded at all
      if (!trigger.hasAriaExpanded) {
        // Check if something visual appeared (a menu, dropdown, etc.)
        const contentAppeared = await handle.evaluate((el) => {
          const next = el.nextElementSibling;
          if (next && getComputedStyle(next).display !== "none") return true;
          const controlsId = el.getAttribute("aria-controls");
          if (controlsId) {
            const target = document.getElementById(controlsId);
            if (target && getComputedStyle(target).display !== "none") return true;
          }
          return false;
        }).catch(() => false);

        if (contentAppeared) {
          issues.push(makeAriaIssue(url,
            `Widget "${trigger.text}" (${trigger.selector}) opens content but lacks aria-expanded attribute`,
            trigger.selector));
        }
      }
      // Check: has aria-expanded but it didn't toggle
      else if (before.expanded === after.expanded && before.expanded !== null) {
        issues.push(makeAriaIssue(url,
          `Widget "${trigger.text}" (${trigger.selector}) has aria-expanded="${before.expanded}" but it did not change after click`,
          trigger.selector));
      }

      // Reset: click again to close
      try {
        await handle.click();
        await page.waitForTimeout(300);
      } catch { /* ignore */ }

    } catch {
      // Interaction failed — skip
    }
  }

  return issues;
}
