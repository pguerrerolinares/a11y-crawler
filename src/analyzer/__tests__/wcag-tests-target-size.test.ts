import { describe, test, expect, mock } from "bun:test";
import { testTargetSize } from "../wcag-tests";

// Mock a Playwright Page with page.evaluate()
function mockPage(evaluateResult: unknown) {
  return {
    evaluate: mock(() => Promise.resolve(evaluateResult)),
  } as any;
}

describe("testTargetSize", () => {
  test("returns empty array when all elements are >= 24x24", async () => {
    const page = mockPage([]);
    const issues = await testTargetSize(page, "https://example.com");
    expect(issues).toHaveLength(0);
  });

  test("returns issue for element smaller than 24x24", async () => {
    const page = mockPage([
      { selector: "a.tiny-link", html: '<a class="tiny-link" href="/x">X</a>', width: 16, height: 16 },
    ]);
    const issues = await testTargetSize(page, "https://example.com");
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe("target-size");
    expect(issues[0].impact).toBe("serious");
    expect(issues[0].checkSource).toBe("wcag-custom");
    expect(issues[0].description).toContain("16×16");
    expect(issues[0].description).toContain("24×24");
  });

  test("skips hidden elements (0x0)", async () => {
    const page = mockPage([]);
    const issues = await testTargetSize(page, "https://example.com");
    expect(issues).toHaveLength(0);
  });

  test("reports multiple undersized elements", async () => {
    const page = mockPage([
      { selector: "button.sm", html: "<button class=\"sm\">OK</button>", width: 20, height: 20 },
      { selector: "a.icon", html: "<a class=\"icon\">×</a>", width: 12, height: 12 },
    ]);
    const issues = await testTargetSize(page, "https://example.com");
    expect(issues).toHaveLength(2);
  });
});
