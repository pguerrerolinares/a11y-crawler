// src/analyzer/wcag-status-messages.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";

function makeStatusIssue(
  url: string, description: string, selector: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule: "status-message-no-live-region",
    impact: "serious", description,
    help: "Status messages must be programmatically determinable via role or properties (role='alert', role='status', aria-live).",
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/status-messages",
    wcagTags: ["wcag413"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 1280, pageTitle: "",
    checkSource: "wcag-custom",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "4.1.3",
    violationCategory: "interactive",
  };
}

/**
 * WCAG 4.1.3 — Status Messages: after triggering form validation,
 * check that dynamically appearing messages use live regions
 * (role="alert", role="status", or aria-live).
 *
 * Uses checkValidity() (safe, no real submit) + MutationObserver to detect
 * new visible text that lacks live region markup.
 */
export async function testStatusMessages(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  const forms = await page.$$("form");

  for (const form of forms) {
    const requiredFields = await form.$$('[required], [aria-required="true"]');
    if (requiredFields.length === 0) continue;

    // Inject MutationObserver before triggering validation
    try {
    // Reset globals at start of each form iteration (MEDIUM-2 fix)
    await page.evaluate(() => {
      (window as any).__statusMsgObs?.disconnect();
      (window as any).__statusMsgLog = [];
      (window as any).__statusMsgObs = null;
    });

    await page.evaluate(() => {
      (window as any).__statusMsgLog = [];

      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          // New elements
          for (const node of m.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const el = node as Element;
            const text = el.textContent?.trim();
            if (!text || text.length < 3) continue;
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") continue;

            (window as any).__statusMsgLog.push({
              text: text.slice(0, 100),
              role: el.getAttribute("role"),
              ariaLive: el.getAttribute("aria-live"),
              tag: el.tagName,
              className: el.className,
              hasLiveRegion: !!(
                el.getAttribute("role") === "alert" ||
                el.getAttribute("role") === "status" ||
                el.getAttribute("aria-live") ||
                el.closest("[role='alert'], [role='status'], [aria-live]")
              ),
            });
          }
          // Attribute changes making elements visible
          if (m.type === "attributes" && m.target.nodeType === Node.ELEMENT_NODE) {
            const el = m.target as Element;
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") continue;
            const text = el.textContent?.trim();
            if (!text || text.length < 3) continue;

            (window as any).__statusMsgLog.push({
              text: text.slice(0, 100),
              role: el.getAttribute("role"),
              ariaLive: el.getAttribute("aria-live"),
              tag: el.tagName,
              className: el.className,
              hasLiveRegion: !!(
                el.getAttribute("role") === "alert" ||
                el.getAttribute("role") === "status" ||
                el.getAttribute("aria-live") ||
                el.closest("[role='alert'], [role='status'], [aria-live]")
              ),
            });
          }
        }
      });

      obs.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ["style", "class", "hidden", "aria-hidden"],
      });
      (window as any).__statusMsgObs = obs;
    });

    // Trigger validation via checkValidity (safe, no submit)
    await form.evaluate((f) => {
      for (const el of f.elements) {
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
          el.checkValidity();
        }
      }
      // Also try reportValidity to trigger browser's built-in validation UI
      f.reportValidity();
    });

    await page.waitForTimeout(500);

    // Collect results
    const messages: Array<{
      text: string;
      role: string | null;
      ariaLive: string | null;
      tag: string;
      className: string;
      hasLiveRegion: boolean;
    }> = await page.evaluate(() => {
      const log = (window as any).__statusMsgLog ?? [];
      // Disconnect observer
      (window as any).__statusMsgObs?.disconnect();
      return log;
    });

    const formSelector = await form.evaluate((f) => {
      const action = f.getAttribute("action") || "self";
      return `form[action="${action}"]`;
    });

    // Flag messages that appeared without live region
    for (const msg of messages) {
      if (!msg.hasLiveRegion) {
        issues.push(makeStatusIssue(url,
          `Status message "${msg.text}" appeared after form validation but lacks role="alert", role="status", or aria-live attribute`,
          formSelector));
      }
    }
    } catch {
      // error path
    } finally {
      // Always clean up globals (MEDIUM-2 fix)
      await page.evaluate(() => {
        (window as any).__statusMsgObs?.disconnect();
        delete (window as any).__statusMsgLog;
        delete (window as any).__statusMsgObs;
      }).catch(() => {});
    }
  }

  return issues;
}
