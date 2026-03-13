import { hammingDistance } from "./fingerprint";

const NEAR_FINGERPRINT_THRESHOLD = 12;

export interface SerializedCluster {
  id: string;
  fingerprint: string;    // hex string from bigint.toString(16)
  urlPattern: string;
  urls: string[];
  representative: string;
}

export interface RegressionDiff {
  previousAuditId: string;
  previousAuditDate: string;
  matched: Array<{
    currentTemplateId: string;
    previousTemplateId: string;
    matchMethod: "url-pattern" | "fingerprint-near" | "representative-url";
    newIssues: Array<{ rule: string; impact: string; count: number }>;
    resolvedIssues: Array<{ rule: string; impact: string; count: number }>;
  }>;
  unmatchedNew: string[];
  unmatchedRemoved: string[];
  scoreChange: number | null;
  summary: {
    totalNewIssues: number;
    totalResolvedIssues: number;
    newTemplates: number;
    removedTemplates: number;
  };
}

/**
 * Match templates across two audits using a ranked cascade:
 * 1. URL pattern (most stable)
 * 2. Near-fingerprint (Hamming ≤ 12)
 * 3. Representative URL overlap
 */
export function matchTemplatesAcrossAudits(
  current: SerializedCluster[],
  previous: SerializedCluster[],
): Map<string, string> {
  const matches = new Map<string, string>();
  const matchedPrevIds = () => new Set(matches.values());

  // Pass 1: URL pattern
  for (const curr of current) {
    const usedPrevIds = matchedPrevIds();
    const prev = previous.find(
      (p) => p.urlPattern === curr.urlPattern && !usedPrevIds.has(p.id),
    );
    if (prev) matches.set(curr.id, prev.id);
  }

  // Pass 2: Near-fingerprint (Hamming ≤ 12)
  for (const curr of current.filter((c) => !matches.has(c.id))) {
    const usedPrevIds = matchedPrevIds();
    const currFp = BigInt(`0x${curr.fingerprint || "0"}`);
    const prev = previous.find((p) => {
      if (usedPrevIds.has(p.id)) return false;
      const prevFp = BigInt(`0x${p.fingerprint || "0"}`);
      return hammingDistance(currFp, prevFp) <= NEAR_FINGERPRINT_THRESHOLD;
    });
    if (prev) matches.set(curr.id, prev.id);
  }

  // Pass 3: Representative URL overlap
  for (const curr of current.filter((c) => !matches.has(c.id))) {
    const usedPrevIds = matchedPrevIds();
    const prev = previous.find(
      (p) => !usedPrevIds.has(p.id) && curr.urls.some((u) => p.urls.includes(u)),
    );
    if (prev) matches.set(curr.id, prev.id);
  }

  return matches;
}

/**
 * Compute the full regression diff from matched templates and their issues.
 */
export function computeRegressionDiff(
  matched: Map<string, string>,
  currentIssuesByTemplate: Map<string, Array<{ rule: string; impact: string }>>,
  previousIssuesByTemplate: Map<string, Array<{ rule: string; impact: string }>>,
  currentTemplates: Array<{ id: string; urlPattern: string }>,
  previousTemplates: Array<{ id: string; urlPattern: string }>,
  previousAuditId: string,
  previousAuditDate: string,
  currentScore: number | null,
  previousScore: number | null,
): RegressionDiff {
  const matchedEntries: RegressionDiff["matched"] = [];

  for (const [currentId, previousId] of matched) {
    const currentIssues = currentIssuesByTemplate.get(currentId) ?? [];
    const previousIssues = previousIssuesByTemplate.get(previousId) ?? [];

    // Aggregate issues by rule
    const currentRules = new Map<string, { impact: string; count: number }>();
    for (const i of currentIssues) {
      const existing = currentRules.get(i.rule);
      if (existing) existing.count++;
      else currentRules.set(i.rule, { impact: i.impact, count: 1 });
    }

    const previousRules = new Map<string, { impact: string; count: number }>();
    for (const i of previousIssues) {
      const existing = previousRules.get(i.rule);
      if (existing) existing.count++;
      else previousRules.set(i.rule, { impact: i.impact, count: 1 });
    }

    const newIssues: Array<{ rule: string; impact: string; count: number }> = [];
    for (const [rule, data] of currentRules) {
      if (!previousRules.has(rule)) {
        newIssues.push({ rule, impact: data.impact, count: data.count });
      }
    }

    const resolvedIssues: Array<{ rule: string; impact: string; count: number }> = [];
    for (const [rule, data] of previousRules) {
      if (!currentRules.has(rule)) {
        resolvedIssues.push({ rule, impact: data.impact, count: data.count });
      }
    }

    // Infer match method
    const currTemplate = currentTemplates.find((t) => t.id === currentId);
    const prevTemplate = previousTemplates.find((t) => t.id === previousId);
    let matchMethod: "url-pattern" | "fingerprint-near" | "representative-url" = "representative-url";
    if (currTemplate && prevTemplate && currTemplate.urlPattern === prevTemplate.urlPattern) {
      matchMethod = "url-pattern";
    }

    matchedEntries.push({
      currentTemplateId: currentId,
      previousTemplateId: previousId,
      matchMethod,
      newIssues,
      resolvedIssues,
    });
  }

  const matchedCurrentIds = new Set(matched.keys());
  const matchedPrevIds = new Set(matched.values());
  const unmatchedNew = currentTemplates.filter((t) => !matchedCurrentIds.has(t.id)).map((t) => t.id);
  const unmatchedRemoved = previousTemplates.filter((t) => !matchedPrevIds.has(t.id)).map((t) => t.id);

  const totalNewIssues = matchedEntries.reduce((sum, m) => sum + m.newIssues.reduce((s, i) => s + i.count, 0), 0);
  const totalResolvedIssues = matchedEntries.reduce((sum, m) => sum + m.resolvedIssues.reduce((s, i) => s + i.count, 0), 0);

  return {
    previousAuditId,
    previousAuditDate,
    matched: matchedEntries,
    unmatchedNew,
    unmatchedRemoved,
    scoreChange: currentScore !== null && previousScore !== null ? currentScore - previousScore : null,
    summary: {
      totalNewIssues,
      totalResolvedIssues,
      newTemplates: unmatchedNew.length,
      removedTemplates: unmatchedRemoved.length,
    },
  };
}
