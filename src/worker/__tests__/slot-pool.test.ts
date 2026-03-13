import { test, expect, describe } from "bun:test";
import { ContextSlot, SlotPool } from "../slot-pool";

describe("ContextSlot", () => {
  test("is an exported class", () => {
    expect(ContextSlot).toBeDefined();
    const slot = new ContextSlot();
    expect(slot).toBeInstanceOf(ContextSlot);
  });
});

describe("SlotPool", () => {
  test("is an exported class", () => {
    expect(SlotPool).toBeDefined();
  });

  test("SlotPool(3) creates a pool", () => {
    const pool = new SlotPool(3);
    expect(pool).toBeInstanceOf(SlotPool);
  });

  test("acquire() returns slots up to pool size without blocking", async () => {
    const pool = new SlotPool(3);
    const slot1 = await pool.acquire();
    const slot2 = await pool.acquire();
    const slot3 = await pool.acquire();
    expect(slot1).toBeInstanceOf(ContextSlot);
    expect(slot2).toBeInstanceOf(ContextSlot);
    expect(slot3).toBeInstanceOf(ContextSlot);
    // All three are distinct instances
    expect(slot1).not.toBe(slot2);
    expect(slot2).not.toBe(slot3);
  });

  test("acquire() blocks when exhausted, resumes on release", async () => {
    const pool = new SlotPool(1);
    const slot1 = await pool.acquire();

    let resolved = false;
    const pending = pool.acquire().then((s) => {
      resolved = true;
      return s;
    });

    // Give microtasks a chance to run — should still be blocked
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    pool.release(slot1);

    const slot2 = await pending;
    expect(resolved).toBe(true);
    expect(slot2).toBeInstanceOf(ContextSlot);
  });

  test("released slot goes to waiting consumer, not back to pool", async () => {
    const pool = new SlotPool(1);
    const slot1 = await pool.acquire();

    // Two waiters queued
    const pending1 = pool.acquire();
    const pending2 = pool.acquire();

    // Release once — first waiter gets it
    pool.release(slot1);
    const received1 = await pending1;
    expect(received1).toBe(slot1);

    // Pool is still exhausted — pending2 should not have resolved yet
    let resolved2 = false;
    pending2.then(() => { resolved2 = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved2).toBe(false);

    // Release again — second waiter gets it
    pool.release(received1);
    const received2 = await pending2;
    expect(received2).toBe(received1);
  });
});
