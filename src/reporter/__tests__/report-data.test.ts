import { test, expect, describe } from "bun:test";
import { buildComplianceTable, groupByCategory } from "../report-data";

describe("buildComplianceTable", () => {
  test("marks criteria with issues as fail, others as pass", () => {
    const issueCounts = new Map([
      ["1.4.3", 5],
      ["2.1.1", 2],
    ]);
    const table = buildComplianceTable(issueCounts);

    const contrast = table.find(r => r.criterion === "1.4.3");
    expect(contrast).toBeDefined();
    expect(contrast!.status).toBe("fail");
    expect(contrast!.issueCount).toBe(5);

    const keyboard = table.find(r => r.criterion === "2.1.1");
    expect(keyboard!.status).toBe("fail");

    // A criterion with no issues should be pass
    const nonText = table.find(r => r.criterion === "1.1.1");
    expect(nonText).toBeDefined();
    expect(nonText!.status).toBe("pass");
    expect(nonText!.issueCount).toBe(0);
  });
});

describe("groupByCategory", () => {
  test("groups issues into categories with consolidated findings", () => {
    const issues = [
      { report_category: "color-contrast", wcag_criterion: "1.4.3",
        rule: "color-contrast", impact: "serious",
        description: "Element has insufficient contrast", help: "Fix contrast",
        suggested_fix: "Change color to #000", url: "https://example.com/",
        selector: ".text", html: "<p class='text'>Hi</p>" },
      { report_category: "color-contrast", wcag_criterion: "1.4.3",
        rule: "color-contrast", impact: "serious",
        description: "Element has insufficient contrast", help: "Fix contrast",
        suggested_fix: null, url: "https://example.com/about",
        selector: ".heading", html: "<h1 class='heading'>About</h1>" },
    ];

    const categories = groupByCategory(issues, "standard");

    expect(categories.length).toBe(1);
    expect(categories[0].name).toBe("Color & Contrast");
    expect(categories[0].findings.length).toBe(1); // consolidated by criterion
    expect(categories[0].findings[0].criterion).toBe("1.4.3");
    expect(categories[0].findings[0].affectedPages).toContain("https://example.com/");
    expect(categories[0].findings[0].issueCount).toBe(2);
    expect(categories[0].findings[0].remediation).toContain("Change color to #000");
  });

  test("full detail includes instances", () => {
    const issues = [
      { report_category: "color-contrast", wcag_criterion: "1.4.3",
        rule: "color-contrast", impact: "serious",
        description: "Insufficient contrast", help: "Fix it",
        suggested_fix: null, url: "https://example.com/",
        selector: ".x", html: "<p>x</p>" },
    ];

    const categories = groupByCategory(issues, "full");
    expect(categories[0].findings[0].instances).toBeDefined();
    expect(categories[0].findings[0].instances!.length).toBe(1);
  });

  test("standard detail omits instances", () => {
    const issues = [
      { report_category: "color-contrast", wcag_criterion: "1.4.3",
        rule: "color-contrast", impact: "serious",
        description: "Insufficient contrast", help: "Fix it",
        suggested_fix: null, url: "https://example.com/",
        selector: ".x", html: "<p>x</p>" },
    ];

    const categories = groupByCategory(issues, "standard");
    expect(categories[0].findings[0].instances).toBeUndefined();
  });
});
