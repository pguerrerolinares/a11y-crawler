import type { Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import type { Issue, ImpactLevel } from "../types/issue.ts";
import { getViolationCategory } from "./category.ts";

const WCAG_TAGS: Record<string, string[]> = {
  A: ["wcag2a", "wcag21a"],
  AA: ["wcag2a", "wcag21a", "wcag2aa", "wcag21aa", "wcag22aa"],
  AAA: ["wcag2a", "wcag21a", "wcag2aa", "wcag21aa", "wcag22aa", "wcag2aaa", "wcag21aaa"],
};

/**
 * Run axe-core analysis on a page. Returns Issue[].
 */
export async function runAxe(
  page: Page,
  config: { wcagLevel: "A" | "AA" | "AAA" },
): Promise<Issue[]> {
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS[config.wcagLevel] || WCAG_TAGS.AA)
    .analyze();

  const title = await page.title();
  const url = page.url();

  return results.violations.flatMap((v) =>
    v.nodes.map((node) => {
      const parentHtml = node.html;

      return {
        id: `axe-${v.id}-${hashString(url + node.target.join(""))}`,
        url,
        rule: v.id,
        impact: (v.impact || "moderate") as ImpactLevel,
        description: v.description,
        help: v.help,
        helpUrl: v.helpUrl,
        wcagTags: v.tags,
        selector: node.target.join(" > "),
        html: node.html,
        surroundingHtml: parentHtml,
        xpath: node.xpath ? node.xpath.join(" > ") : "",
        viewportWidth: 1280,
        pageTitle: title,
        checkSource: "axe" as const,
        suggestedFix: null,
        fixConfidence: null,
        llmConfidence: null,
        wcagCriterion: null,
        violationCategory: getViolationCategory(v.id),
      };
    }),
  );
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
