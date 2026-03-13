export interface ImpactCounts {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
}

/**
 * Computes WCAG accessibility score (0-100) from distinct violated rules
 * per impact level.
 *
 * Weights: critical=10, serious=5, moderate=2, minor=1
 *
 * The input should be COUNT(DISTINCT rule) per impact, not per-node counts.
 * This matches how Lighthouse scores accessibility — by rule, not by element.
 *
 * Returns null if totalPages is 0 (no pages analyzed).
 */
export function computeWcagScore(
  issuesByImpact: ImpactCounts,
  totalPages: number,
): number | null {
  if (totalPages === 0) return null;

  const totalPenalty =
    (issuesByImpact.critical ?? 0) * 10 +
    (issuesByImpact.serious ?? 0) * 5 +
    (issuesByImpact.moderate ?? 0) * 2 +
    (issuesByImpact.minor ?? 0) * 1;

  return Math.max(0, Math.round(100 - totalPenalty));
}
