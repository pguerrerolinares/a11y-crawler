// src/analyzer/__tests__/wcag-legal-checks.test.ts
import { test, expect, describe, mock } from "bun:test";

// We'll test the page.evaluate logic directly by simulating the returned data.
// The implementation calls page.evaluate() twice: first for skip-nav, then for declaration.
// We discriminate by call order (1st = skip, 2nd = declaration).
// NOTE: If the order of page.evaluate() calls in wcag-legal-checks.ts changes, update the
// mock order here accordingly — the tests will fail with misleading errors otherwise.

function makeEvaluateMock(skipResult: object, declResult: object) {
  let callCount = 0;
  return mock(async (_fn: Function) => {
    callCount++;
    return callCount === 1 ? skipResult : declResult;
  });
}

describe("wcag-legal-checks", () => {
  describe("skip navigation detection", () => {
    test("reports issue when no skip link exists", async () => {
      const { testLegalA11y } = await import("../wcag-legal-checks");

      const mockPage = {
        evaluate: makeEvaluateMock(
          { hasSkipLink: false },
          { hasDeclaration: false },
        ),
      } as any;

      const issues = await testLegalA11y(mockPage, "https://example.com/");
      const skipIssue = issues.find((i) => i.rule === "skip-nav-missing");
      expect(skipIssue).toBeDefined();
      expect(skipIssue!.wcagCriterion).toBe("2.4.1");
    });

    test("no issue when skip link exists", async () => {
      const { testLegalA11y } = await import("../wcag-legal-checks");

      const mockPage = {
        evaluate: makeEvaluateMock(
          { hasSkipLink: true },
          { hasDeclaration: true },
        ),
      } as any;

      const issues = await testLegalA11y(mockPage, "https://example.com/");
      const skipIssue = issues.find((i) => i.rule === "skip-nav-missing");
      expect(skipIssue).toBeUndefined();
    });
  });

  describe("accessibility declaration detection", () => {
    test("reports issue when no declaration link exists", async () => {
      const { testLegalA11y } = await import("../wcag-legal-checks");

      const mockPage = {
        evaluate: makeEvaluateMock(
          { hasSkipLink: true },
          { hasDeclaration: false },
        ),
      } as any;

      const issues = await testLegalA11y(mockPage, "https://example.com/");
      const declIssue = issues.find((i) => i.rule === "accessibility-declaration-missing");
      expect(declIssue).toBeDefined();
      expect(declIssue!.impact).toBe("serious");
    });

    test("no issue when declaration link found in footer", async () => {
      const { testLegalA11y } = await import("../wcag-legal-checks");

      const mockPage = {
        evaluate: makeEvaluateMock(
          { hasSkipLink: true },
          { hasDeclaration: true },
        ),
      } as any;

      const issues = await testLegalA11y(mockPage, "https://example.com/");
      const declIssue = issues.find((i) => i.rule === "accessibility-declaration-missing");
      expect(declIssue).toBeUndefined();
    });
  });
});
