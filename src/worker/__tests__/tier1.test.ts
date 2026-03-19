import { test, expect } from "bun:test";
import { amplifyResults } from "../tier1";
import type { ElementManifest } from "../../types/manifest";

test("amplifyResults amplifies FAIL to all group members", () => {
  const members: ElementManifest[] = [
    { selector: "#a", styleFingerprint: "fp1" } as ElementManifest,
    { selector: "#b", styleFingerprint: "fp1" } as ElementManifest,
  ];
  const issues = amplifyResults([{
    ruleId: "state-change-contrast",
    selector: "#a",
    severity: "error" as const,
    message: "Insufficient contrast",
    wcagCriterion: "1.4.11",
  }], members, "state-change-contrast");

  // Should create issues for all members
  expect(issues.length).toBe(2);
  expect(issues.some(i => i.selector === "#a")).toBe(true);
  expect(issues.some(i => i.selector === "#b")).toBe(true);
});

test("amplifyResults with empty issues returns no issues for members", () => {
  const members: ElementManifest[] = [
    { selector: "#a" } as ElementManifest,
    { selector: "#b" } as ElementManifest,
  ];
  const result = amplifyResults([], members, "state-change-contrast");
  expect(result.length).toBe(0);
});
