// src/repr/tier.ts
import type { Page } from "playwright";
import type { PageRepresentation } from "../types/page.ts";
import { getAriaSnapshot, countNavNodes } from "./aria.ts";
import { getPrunedHtml } from "./pruned-html.ts";
import { getHeuristicElements } from "./heuristic.ts";
import { estimateTokens } from "../llm/client.ts";

const MIN_NAV_NODES = 3;
const MIN_PRUNED_HTML_LENGTH = 100;

const TOKEN_BUDGETS = {
  "aria-snapshot": 800,
  "pruned-html": 5000,
  "css-heuristic": 3000,
} as const;

/**
 * Truncate content to a token budget. Appends [truncated] marker if cut.
 */
export function truncateToTokenBudget(content: string, maxTokens: number): string {
  const marker = " [truncated]";
  const maxChars = maxTokens * 4;
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars - marker.length) + marker;
}

/**
 * Build the best page representation using tiered strategy.
 */
export async function buildRepresentation(page: Page): Promise<PageRepresentation> {
  const ariaYaml = await getAriaSnapshot(page);
  const prunedHtml = await getPrunedHtml(page);

  const selected = selectTier(ariaYaml, prunedHtml);

  if (selected.tier === "css-heuristic") {
    const raw = await getHeuristicElements(page);
    const content = truncateToTokenBudget(
      raw || "No interactive elements found",
      TOKEN_BUDGETS["css-heuristic"],
    );
    return {
      tier: "css-heuristic",
      content,
      tokenEstimate: estimateTokens(content),
      tierReason: "No landmarks found, using element enumeration",
    };
  }

  return selected;
}

/**
 * Select the best tier based on available content.
 * Applies token budget truncation to selected content.
 * Pure function for easy testing.
 */
export function selectTier(
  ariaYaml: string,
  prunedHtml: string,
): PageRepresentation {
  const navNodeCount = countNavNodes(ariaYaml);
  if (ariaYaml && navNodeCount >= MIN_NAV_NODES) {
    const content = truncateToTokenBudget(ariaYaml, TOKEN_BUDGETS["aria-snapshot"]);
    return {
      tier: "aria-snapshot",
      content,
      tokenEstimate: estimateTokens(content),
      tierReason: `ARIA snapshot contains ${navNodeCount} navigation nodes`,
    };
  }

  if (prunedHtml.length >= MIN_PRUNED_HTML_LENGTH) {
    const content = truncateToTokenBudget(prunedHtml, TOKEN_BUDGETS["pruned-html"]);
    return {
      tier: "pruned-html",
      content,
      tokenEstimate: estimateTokens(content),
      tierReason: "ARIA snapshot insufficient, using pruned HTML from landmarks",
    };
  }

  return {
    tier: "css-heuristic",
    content: "",
    tokenEstimate: 0,
    tierReason: "No landmarks found, using element enumeration",
  };
}
