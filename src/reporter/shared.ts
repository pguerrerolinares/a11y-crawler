import type { PageResult } from "../types/page.ts";
import type { SharedIssue } from "../types/report.ts";

const MIN_SHARED_PAGES = 3;

/**
 * Detect issues appearing on 3+ pages (likely template/component issues).
 */
export function detectSharedIssues(pages: PageResult[]): SharedIssue[] {
  const groups = new Map<string, {
    rule: string;
    html: string;
    selector: string;
    pages: Set<string>;
    suggestedFix: string | null;
  }>();

  for (const page of pages) {
    for (const issue of page.issues) {
      const key = `${issue.rule}::${normalizeHtml(issue.html)}`;

      if (!groups.has(key)) {
        groups.set(key, {
          rule: issue.rule,
          html: issue.html,
          selector: issue.selector,
          pages: new Set(),
          suggestedFix: null,
        });
      }

      const group = groups.get(key)!;
      group.pages.add(page.url);
      if (issue.suggestedFix && !group.suggestedFix) {
        group.suggestedFix = issue.suggestedFix;
      }
    }
  }

  return [...groups.values()]
    .filter((g) => g.pages.size >= MIN_SHARED_PAGES)
    .sort((a, b) => b.pages.size - a.pages.size)
    .map((g) => ({
      rule: g.rule,
      selectorPattern: g.selector,
      html: g.html,
      affectedPages: [...g.pages],
      pageCount: g.pages.size,
      suggestedFix: g.suggestedFix,
    }));
}

function normalizeHtml(html: string): string {
  return html.replace(/\s+/g, " ").trim().toLowerCase();
}
