import type { Page } from "playwright";
import type { PageRepresentation } from "../types/page.ts";
import { getAriaSnapshot, countNavNodes } from "./aria.ts";
import { getPrunedHtml } from "./pruned-html.ts";
import { getHeuristicElements } from "./heuristic.ts";
import { estimateTokens } from "../llm/client.ts";

const MIN_NAV_NODES = 3;
const MIN_PRUNED_HTML_LENGTH = 100;

/**
 * Build the best page representation using tiered strategy.
 * Tries: ARIA snapshot -> Pruned HTML -> CSS heuristic
 */
export async function buildRepresentation(page: Page): Promise<PageRepresentation> {
  // Tier 1: ARIA snapshot
  const ariaYaml = await getAriaSnapshot(page);
  const prunedHtml = await getPrunedHtml(page);

  const selected = selectTier(ariaYaml, prunedHtml);

  // If css-heuristic is needed, fetch elements from page
  if (selected.tier === "css-heuristic") {
    const heuristicContent = await getHeuristicElements(page);
    return {
      tier: "css-heuristic",
      content: heuristicContent || "No interactive elements found",
      tokenEstimate: estimateTokens(heuristicContent),
      tierReason: "No landmarks found, using element enumeration",
    };
  }

  return selected;
}

/**
 * Select the best tier based on available content.
 * Pure function for easy testing.
 */
export function selectTier(
  ariaYaml: string,
  prunedHtml: string,
): PageRepresentation {
  // Tier 1: ARIA snapshot
  if (ariaYaml && countNavNodes(ariaYaml) >= MIN_NAV_NODES) {
    return {
      tier: "aria-snapshot",
      content: ariaYaml,
      tokenEstimate: estimateTokens(ariaYaml),
      tierReason: `ARIA snapshot contains ${countNavNodes(ariaYaml)} navigation nodes`,
    };
  }

  // Tier 2: Pruned HTML
  if (prunedHtml.length >= MIN_PRUNED_HTML_LENGTH) {
    return {
      tier: "pruned-html",
      content: prunedHtml,
      tokenEstimate: estimateTokens(prunedHtml),
      tierReason: "ARIA snapshot insufficient, using pruned HTML from landmarks",
    };
  }

  // Tier 3: placeholder - actual content fetched in buildRepresentation
  return {
    tier: "css-heuristic",
    content: "",
    tokenEstimate: 0,
    tierReason: "No landmarks found, using element enumeration",
  };
}
