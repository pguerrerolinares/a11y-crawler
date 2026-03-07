import type { Page } from "playwright";

interface ElementInfo {
  tag: string;
  text: string;
  href: string | null;
  selector: string;
}

/**
 * Enumerate all links and buttons on the page as a simplified list.
 * Last resort when no nav landmarks are found.
 */
export async function getHeuristicElements(page: Page): Promise<string> {
  const elements: ElementInfo[] = await page.evaluate(() => {
    const results: ElementInfo[] = [];
    const seen = new Set<string>();

    // All links
    document.querySelectorAll("a[href]").forEach((el) => {
      const href = el.getAttribute("href");
      const text = (el.textContent || "").trim().slice(0, 50);
      if (href && !seen.has(href) && text) {
        seen.add(href);
        results.push({
          tag: "a",
          text,
          href,
          selector: generateSelector(el),
        });
      }
    });

    // All buttons
    document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"]').forEach((el) => {
      const text = (el.textContent || "").trim().slice(0, 50);
      if (text) {
        results.push({
          tag: el.tagName.toLowerCase(),
          text,
          href: null,
          selector: generateSelector(el),
        });
      }
    });

    function generateSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      const classes = Array.from(el.classList).slice(0, 2).join(".");
      if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
      return el.tagName.toLowerCase();
    }

    return results;
  });

  return formatElementList(elements);
}

/**
 * Format element list into a readable string for LLM consumption.
 */
export function formatElementList(elements: ElementInfo[]): string {
  return elements
    .map((el) => {
      if (el.tag === "a" && el.href) {
        return `- link: '${el.text}' -> ${el.href} [${el.selector}]`;
      }
      return `- ${el.tag === "button" ? "button" : "interactive"}: '${el.text}' [${el.selector}]`;
    })
    .join("\n");
}
