import { test, expect, mock } from "bun:test";
import { ProbeContextManager } from "../probe-context";

// Mock browser and context
function mockBrowser() {
  const pages: Array<{ close: () => Promise<void> }> = [];
  const context = {
    newPage: mock(async () => {
      const page = { close: mock(async () => {}), goto: mock(async () => {}), url: () => "http://test" };
      pages.push(page);
      return page;
    }),
    close: mock(async () => {}),
    route: mock(async () => {}),
    setExtraHTTPHeaders: mock(async () => {}),
  };
  const browser = {
    newContext: mock(async () => context),
  };
  return { browser, context, pages };
}

test("lease: returns page and release function", async () => {
  const { browser } = mockBrowser();
  const mgr = new ProbeContextManager(async () => browser as any, 5);
  const lease = await mgr.lease();
  expect(lease.page).toBeDefined();
  expect(typeof lease.release).toBe("function");
  await lease.release();
  await mgr.close();
});

test("lease: does not recycle context while pages are active", async () => {
  const { browser, context } = mockBrowser();
  const mgr = new ProbeContextManager(async () => browser as any, 2);

  // Lease 2 pages (hits pagesPerContext limit)
  const lease1 = await mgr.lease();
  const lease2 = await mgr.lease();

  // Context should NOT be closed yet (2 active pages)
  expect(context.close).not.toHaveBeenCalled();

  // Release first page
  await lease1.release();
  // Still 1 active page — no recycle
  expect(context.close).not.toHaveBeenCalled();

  // Release second page — now 0 active, should recycle on next lease
  await lease2.release();

  // Next lease triggers recycle (pagesSinceRecycle >= pagesPerContext AND activePages === 0)
  const lease3 = await mgr.lease();
  expect(context.close).toHaveBeenCalledTimes(1);
  await lease3.release();
  await mgr.close();
});

test("lease: double release is safe (idempotent)", async () => {
  const { browser } = mockBrowser();
  const mgr = new ProbeContextManager(async () => browser as any, 5);
  const lease = await mgr.lease();
  await lease.release();
  await lease.release(); // should not throw or double-decrement
  // Next lease should work normally
  const lease2 = await mgr.lease();
  expect(lease2.page).toBeDefined();
  await lease2.release();
  await mgr.close();
});

test("lease: two concurrent pages share same context", async () => {
  const { browser } = mockBrowser();
  const mgr = new ProbeContextManager(async () => browser as any, 5);

  const lease1 = await mgr.lease();
  const lease2 = await mgr.lease();

  // Both pages are in the same context (newContext called once)
  expect(browser.newContext).toHaveBeenCalledTimes(1);

  await lease1.release();
  await lease2.release();
  await mgr.close();
});
