import { simhash, hammingDistance, inferUrlPattern } from "./fingerprint";
import type { ScanResult, TemplateCluster, TestType } from "../types/pipeline";

const HAMMING_THRESHOLD = 8;

export function clusterPages(scanResults: ScanResult[]): TemplateCluster[] {
  const clusters: TemplateCluster[] = [];
  for (const result of scanResults) {
    const urlPattern = inferUrlPattern(result.url);
    const fingerprint = simhash(result.fingerprint);
    const match = clusters.find(
      (c) => c.urlPattern === urlPattern && hammingDistance(c.fingerprint, fingerprint) <= HAMMING_THRESHOLD,
    );
    if (match) {
      match.urls.push(result.url);
      match.axeIssues.push(...result.axeIssues);
      for (const key of Object.keys(result.capabilities) as Array<keyof typeof result.capabilities>) {
        if (result.capabilities[key]) {
          (match.capabilities as Record<string, boolean>)[key] = true;
        }
      }
    } else {
      clusters.push({
        id: `${fingerprint.toString(16)}-${urlPattern}`,
        fingerprint,
        urlPattern,
        urls: [result.url],
        representative: result.url,
        capabilities: { ...result.capabilities },
        axeIssues: [...result.axeIssues],
        testPlan: [],
      });
    }
  }
  return clusters;
}

export function buildTestPlan(cluster: TemplateCluster): TestType[] {
  const plan: TestType[] = [
    "axe-full", "interactive", "reflow", "text-spacing", "resize-text",
    "target-size", "non-text-contrast",
    // v4.3 — always run (zero cost)
    "meaningful-sequence", "semantic-structure",
    // v4.5 — legal/structural checks (zero cost)
    "legal-a11y",
  ];
  if (cluster.capabilities.hasMedia) plan.push("multimedia", "timed-events");
  if (cluster.capabilities.hasCarousel) plan.push("timed-events");
  if (cluster.capabilities.hasForms) plan.push("error-identification", "status-messages");
  // hover-focus and aria-states: always run (detect interactive widgets)
  plan.push("hover-focus", "aria-states", "state-change-contrast");
  // v4.4 — LLM-augmented tests (always run; degrade gracefully if no LLM)
  plan.push("color-use");
  if (cluster.capabilities.hasForms) plan.push("sensory-instructions");
  return [...new Set(plan)];
}

export function selectRepresentative(
  cluster: TemplateCluster,
  scanResults: Map<string, ScanResult>,
): string {
  return cluster.urls.reduce(
    (best, url) => {
      const page = scanResults.get(url);
      if (!page) return best;
      const score =
        (page.capabilities.hasForms ? 4 : 0) +
        (page.capabilities.hasMedia ? 3 : 0) +
        (page.capabilities.hasCarousel ? 2 : 0) +
        (page.capabilities.hasDataTables ? 1 : 0) +
        (page.axeIssues.length > 0 ? 1 : 0);
      return score > best.score ? { url, score } : best;
    },
    { url: cluster.urls[0], score: -1 },
  ).url;
}

export function prioritizeTemplates(
  clusters: TemplateCluster[],
  maxProbeTemplates: number,
): { probed: TemplateCluster[]; skipped: TemplateCluster[] } {
  if (clusters.length <= maxProbeTemplates) return { probed: clusters, skipped: [] };
  const sorted = [...clusters].sort((a, b) => {
    const capScore = (c: TemplateCluster) => 1 + Object.values(c.capabilities).filter(Boolean).length;
    return b.urls.length * capScore(b) - a.urls.length * capScore(a);
  });
  return { probed: sorted.slice(0, maxProbeTemplates), skipped: sorted.slice(maxProbeTemplates) };
}
