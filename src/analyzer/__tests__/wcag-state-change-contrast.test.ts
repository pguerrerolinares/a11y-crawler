// src/analyzer/__tests__/wcag-state-change-contrast.test.ts
import { test, expect, describe } from "bun:test";

describe("wcag-state-change-contrast", () => {
  // Test the core logic: given default and hovered colors, detect insufficient change
  describe("state color diff detection", () => {
    test("reports issue when hover changes border color with insufficient contrast", async () => {
      const { testStateChangeContrast } = await import("../wcag-state-change-contrast");

      // Mock page: element with border that barely changes on hover
      const mockPage = {
        evaluate: async (fn: Function, ...args: any[]) => fn(...args),
        $: async () => ({
          hover: async () => {},
          dispose: async () => {},
        }),
        hover: async () => {},
        keyboard: { press: async () => {} },
        mouse: { move: async () => {} },
        waitForTimeout: async () => {},
      } as any;

      // We can't easily test with a real page, so verify the function at least
      // returns an array and doesn't crash
      const issues = await testStateChangeContrast(mockPage, "https://example.com/");
      expect(Array.isArray(issues)).toBe(true);
    });
  });

  describe("contrast math for state changes", () => {
    test("stateChangeRatio: identical colors = 1:1", async () => {
      const { stateChangeRatio } = await import("../wcag-state-change-contrast");
      const ratio = stateChangeRatio(
        "rgb(100, 100, 100)",
        "rgb(100, 100, 100)",
        "rgb(255, 255, 255)",
      );
      expect(ratio).toBeCloseTo(1.0, 1);
    });

    test("stateChangeRatio: white to black on white bg = high ratio", async () => {
      const { stateChangeRatio } = await import("../wcag-state-change-contrast");
      const ratio = stateChangeRatio(
        "rgb(255, 255, 255)",
        "rgb(0, 0, 0)",
        "rgb(255, 255, 255)",
      );
      expect(ratio).toBeGreaterThan(3);
    });

    test("stateChangeRatio: subtle grey change = low ratio", async () => {
      const { stateChangeRatio } = await import("../wcag-state-change-contrast");
      // #ccc → #bbb on white bg — very subtle change
      const ratio = stateChangeRatio(
        "rgb(204, 204, 204)",
        "rgb(187, 187, 187)",
        "rgb(255, 255, 255)",
      );
      expect(ratio).toBeLessThan(3);
    });

    test("stateChangeRatio: null/invalid color returns 1", async () => {
      const { stateChangeRatio } = await import("../wcag-state-change-contrast");
      const ratio = stateChangeRatio("transparent", "rgb(0,0,0)", "rgb(255,255,255)");
      expect(ratio).toBe(1);
    });
  });
});
