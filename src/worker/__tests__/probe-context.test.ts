import { test, expect } from "bun:test";
import { ProbeContextManager } from "../probe-context";

test("ProbeContextManager is exported as a class", () => {
  expect(typeof ProbeContextManager).toBe("function");
  const fakeBrowser = async () => ({}) as any;
  const mgr = new ProbeContextManager(fakeBrowser);
  expect(mgr).toBeInstanceOf(ProbeContextManager);
});

test("close() on fresh manager does not throw", async () => {
  const fakeBrowser = async () => ({}) as any;
  const mgr = new ProbeContextManager(fakeBrowser);
  await expect(mgr.close()).resolves.toBeUndefined();
});

test("close() is safe to call multiple times (idempotent)", async () => {
  const fakeBrowser = async () => ({}) as any;
  const mgr = new ProbeContextManager(fakeBrowser);
  await mgr.close();
  await mgr.close();
  await mgr.close();
  // No error thrown — idempotent
});
