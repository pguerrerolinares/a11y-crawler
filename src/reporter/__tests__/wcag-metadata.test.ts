import { test, expect } from "bun:test";
import {
  RULE_CATEGORY, CRITERION_META, CATEGORY_META,
  getCriterionMeta, getReportCategory,
} from "../wcag-metadata";

test("RULE_CATEGORY maps axe-core rules to report categories", () => {
  expect(RULE_CATEGORY["color-contrast"]).toBe("color-contrast");
  expect(RULE_CATEGORY["keyboard"]).toBe("keyboard-navigation");
  expect(RULE_CATEGORY["label"]).toBe("forms-labels");
  expect(RULE_CATEGORY["aria-required-attr"]).toBe("aria-semantics");
});

test("CRITERION_META has name and level for all WCAG 2.2 AA criteria", () => {
  const aa = Object.entries(CRITERION_META).filter(([, v]) => v.level !== "AAA");
  expect(aa.length).toBeGreaterThanOrEqual(38); // WCAG 2.2 A+AA criteria
  expect(CRITERION_META["1.4.3"]).toEqual({ name: "Contrast (Minimum)", level: "AA" });
  expect(CRITERION_META["2.1.1"]).toEqual({ name: "Keyboard", level: "A" });
});

test("CATEGORY_META has human names for all categories", () => {
  const categories = Object.keys(CATEGORY_META);
  expect(categories).toContain("keyboard-navigation");
  expect(categories).toContain("color-contrast");
  expect(categories).toContain("forms-labels");
  expect(CATEGORY_META["keyboard-navigation"].name).toBe("Keyboard Navigation");
});

test("getCriterionMeta returns meta or null for unknown", () => {
  expect(getCriterionMeta("1.4.3")).toEqual({ name: "Contrast (Minimum)", level: "AA" });
  expect(getCriterionMeta("99.99.99")).toBeNull();
});

test("getReportCategory returns category or 'uncategorized'", () => {
  expect(getReportCategory("color-contrast")).toBe("color-contrast");
  expect(getReportCategory("totally-unknown-rule")).toBe("uncategorized");
});

test("all RULE_CATEGORY values are valid CATEGORY_META keys", () => {
  for (const [rule, cat] of Object.entries(RULE_CATEGORY)) {
    expect(CATEGORY_META[cat]).toBeDefined();
  }
});
