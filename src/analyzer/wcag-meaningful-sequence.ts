// src/analyzer/wcag-meaningful-sequence.ts
import type { Page } from "playwright";
import type { Issue, ImpactLevel } from "../types/issue";

function makeSequenceIssue(
  url: string, rule: string, impact: ImpactLevel,
  description: string, selector: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule, impact, description,
    help: description,
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/meaningful-sequence",
    wcagTags: ["wcag132"],
    selector, html: "", surroundingHtml: "", xpath: "",
    viewportWidth: 0, pageTitle: "",
    checkSource: "wcag-custom",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "1.3.2",
    violationCategory: "structural",
  };
}

/**
 * Compute Kendall's tau rank correlation between DOM order [0,1,2,...,n-1]
 * and the given visual rank ordering.
 * Returns a value from -1.0 (fully reversed) to 1.0 (identical order).
 */
export function computeKendallTau(visualRanks: number[]): number {
  const n = visualRanks.length;
  if (n <= 1) return 1.0;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // DOM order: i < j always (concordant if visual[i] < visual[j])
      if (visualRanks[i] < visualRanks[j]) concordant++;
      else if (visualRanks[i] > visualRanks[j]) discordant++;
    }
  }
  const pairs = (n * (n - 1)) / 2;
  return (concordant - discordant) / pairs;
}

/**
 * WCAG 1.3.2 — Meaningful Sequence: detect when CSS flex/grid reordering
 * causes visual order to diverge significantly from DOM order.
 *
 * Uses getBoundingClientRect to determine visual positions, then computes
 * Kendall's tau correlation against DOM index order. Tau < 0.8 = significant reorder.
 */
export async function testMeaningfulSequence(page: Page, url: string): Promise<Issue[]> {
  const TAU_THRESHOLD = 0.8;

  // Single DOM traversal collects both tau violations and CSS reorder signals
  const { violations, cssSignals } = await page.evaluate((threshold: number) => {
    const results: Array<{
      container: string;
      display: string;
      childCount: number;
      tau: number;
      domOrder: string[];
      visualOrder: string[];
    }> = [];
    const signals: Array<{ selector: string; property: string; value: string }> = [];

    // Target elements realistically used as flex/grid containers (avoid full DOM traversal)
    document.querySelectorAll("div, section, main, article, aside, nav, ul, ol, header, footer, form, details").forEach((el) => {
      const style = getComputedStyle(el);
      const display = style.display;

      // CSS reorder signal detection (runs for all elements, not just flex/grid)
      if (parseInt(style.order) !== 0 && style.order !== "0") {
        const sel = el.id ? `#${el.id}` : el.tagName.toLowerCase();
        signals.push({ selector: sel, property: "order", value: style.order });
      }
      if (style.flexDirection?.includes("reverse")) {
        const sel = el.id ? `#${el.id}` : el.tagName.toLowerCase();
        signals.push({ selector: sel, property: "flex-direction", value: style.flexDirection });
      }

      // Kendall tau check only for flex/grid containers
      if (!display.includes("flex") && !display.includes("grid")) return;

      const children = Array.from(el.children)
        .filter((c) => getComputedStyle(c).display !== "none");
      if (children.length < 2) return;

      // Get DOM index + visual position for each child
      const withPos = children.map((c, domIdx) => {
        const rect = c.getBoundingClientRect();
        return {
          domIdx,
          top: rect.top,
          left: rect.left,
          text: (c.textContent ?? "").trim().slice(0, 40),
        };
      });

      // Sort by visual position (reading order: top then left)
      const lineHeight = parseFloat(style.lineHeight) || 20;
      const lineTolerance = lineHeight * 0.6;
      const visualOrder = [...withPos].sort((a, b) =>
        Math.abs(a.top - b.top) < lineTolerance
          ? a.left - b.left
          : a.top - b.top,
      );

      // Build visual rank map: visualRanks[domIdx] = visual position rank
      const visualRanks: number[] = new Array(withPos.length);
      visualOrder.forEach((item, visualIdx) => {
        visualRanks[item.domIdx] = visualIdx;
      });

      // Compute Kendall's tau (intentionally duplicated from computeKendallTau — functions
      // passed to page.evaluate() run in the browser context and cannot reference Node.js closures)
      const n = visualRanks.length;
      let concordant = 0;
      let discordant = 0;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (visualRanks[i] < visualRanks[j]) concordant++;
          else if (visualRanks[i] > visualRanks[j]) discordant++;
        }
      }
      const pairs = (n * (n - 1)) / 2;
      const tau = pairs > 0 ? (concordant - discordant) / pairs : 1;

      if (tau < threshold) {
        const container =
          el.id ? `#${el.id}` :
          el.className && typeof el.className === "string"
            ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
            : el.tagName.toLowerCase();

        results.push({
          container,
          display,
          childCount: children.length,
          tau: parseFloat(tau.toFixed(2)),
          domOrder: withPos.map((p) => p.text),
          visualOrder: visualOrder.map((p) => p.text),
        });
      }
    });

    return { violations: results, cssSignals: signals };
  }, TAU_THRESHOLD);

  const issues: Issue[] = [];

  for (const v of violations) {
    issues.push(makeSequenceIssue(
      url,
      "meaningful-sequence-reorder",
      "serious",
      `${v.display} container "${v.container}" has visual order diverging from DOM order (Kendall tau=${v.tau}, threshold=0.8). DOM: [${v.domOrder.join(" → ")}]. Visual: [${v.visualOrder.join(" → ")}]`,
      v.container,
    ));
  }

  for (const s of cssSignals) {
    issues.push(makeSequenceIssue(
      url,
      "meaningful-sequence",
      "moderate",
      `Element "${s.selector}" uses CSS ${s.property}: ${s.value} which may alter reading order (WCAG 1.3.2)`,
      s.selector,
    ));
  }

  return issues;
}
