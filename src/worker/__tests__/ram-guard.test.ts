import { test, expect } from "bun:test";
import { shouldBatch } from "../ram-guard";

test("shouldBatch: returns boolean", () => {
  const result = shouldBatch();
  expect(typeof result).toBe("boolean");
});

test("shouldBatch: injectable getAvailableMemory for deterministic testing", () => {
  // Well above threshold → batch
  expect(shouldBatch(() => 800 * 1024 * 1024)).toBe(true);
  // Below threshold → sequential
  expect(shouldBatch(() => 200 * 1024 * 1024)).toBe(false);
});
