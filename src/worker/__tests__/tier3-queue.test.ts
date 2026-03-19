import { test, expect } from "bun:test";

test("tier3 queue module exports processTier3Queue", async () => {
  const mod = await import("../tier3-queue");
  expect(typeof mod.processTier3Queue).toBe("function");
});

test("tier3 queue module exports resetStuckTier3Jobs", async () => {
  const mod = await import("../tier3-queue");
  expect(typeof mod.resetStuckTier3Jobs).toBe("function");
});
