import { test, expect } from "bun:test";
import { TierTimer } from "../tier-timer";

test("TierTimer records duration per tier", async () => {
  const timer = new TierTimer("audit-1", "template-1", "https://example.com");
  timer.startTier("tier0");
  await new Promise(r => setTimeout(r, 10));
  timer.endTier("tier0", { elementsDiscovered: 5, styleGroups: 2, representativeElements: 3 });

  const timing = timer.getTiming();
  expect(timing.tier0.durationMs).toBeGreaterThan(5);
  expect(timing.tier0.elementsDiscovered).toBe(5);
});

test("TierTimer aggregates interaction counts", () => {
  const timer = new TierTimer("a", "t", "u");
  timer.startTier("tier2");
  timer.recordInteraction("hovers");
  timer.recordInteraction("hovers");
  timer.recordInteraction("focuses");
  timer.endTier("tier2", { issuesFound: 1, elementsPromotedToTier3: 0, avgWaitMs: 50 });

  const timing = timer.getTiming();
  expect(timing.tier2.interactions.hovers).toBe(2);
  expect(timing.tier2.interactions.focuses).toBe(1);
});
