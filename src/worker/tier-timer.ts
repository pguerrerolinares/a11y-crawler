import type { ProbeTiming } from "../types/manifest";

type TierName = "tier0" | "tier1" | "tier2" | "tier3";

export class TierTimer {
  private timing: ProbeTiming;
  private starts: Partial<Record<TierName, number>> = {};

  constructor(auditId: string, templateId: string, url: string) {
    this.timing = {
      auditId,
      templateId,
      url,
      tier0: { durationMs: 0, elementsDiscovered: 0, styleGroups: 0, representativeElements: 0 },
      tier1: { durationMs: 0, issuesFound: 0, elementsPromotedToTier2: 0, skippedByFingerprint: 0 },
      tier2: { durationMs: 0, interactions: { hovers: 0, focuses: 0, clicks: 0, keyboardTests: 0 }, issuesFound: 0, elementsPromotedToTier3: 0, avgWaitMs: 0 },
      tier3: { durationMs: 0, llmCalls: 0, llmInputTokens: 0, llmOutputTokens: 0, imagesSent: 0, avgImageSizeBytes: 0, issuesConfirmed: 0, issuesDiscarded: 0, cacheHits: 0, earlyTerminations: 0 },
    };
  }

  startTier(tier: TierName): void {
    this.starts[tier] = Date.now();
  }

  endTier(tier: TierName, meta: Record<string, unknown>): void {
    const start = this.starts[tier];
    if (start) {
      (this.timing[tier] as Record<string, unknown>).durationMs = Date.now() - start;
    }
    Object.assign(this.timing[tier], meta);
  }

  recordInteraction(type: "hovers" | "focuses" | "clicks" | "keyboardTests"): void {
    this.timing.tier2.interactions[type]++;
  }

  getTiming(): ProbeTiming {
    return this.timing;
  }
}
