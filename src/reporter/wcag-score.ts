export interface ImpactCounts {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
}

/**
 * Computes WCAG accessibility score (0-100) using Formula C:
 * weighted per-page average penalty, normalized by page count.
 *
 * Weights: critical=10, serious=5, moderate=2, minor=1
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

  const avgPenaltyPerPage = totalPenalty / totalPages;
  return Math.max(0, Math.round(100 - avgPenaltyPerPage));
}
