import { describe, test, expect } from "bun:test";
import {
  getSystemPrompt,
  buildEnrichUserMessage,
  parseEnrichResponse,
  cleanFragment,
} from "../prompts.ts";

describe("getSystemPrompt", () => {
  test("structural prompt contains WCAG landmark guidance", () => {
    const p = getSystemPrompt("structural");
    expect(p).toContain("landmarks, headings, lists");
    expect(p).toContain("WCAG 2.2");
    expect(p).toContain('"fix"');
  });

  test("interactive prompt contains aria-label guidance", () => {
    const p = getSystemPrompt("interactive");
    expect(p).toContain("aria-label");
    expect(p).toContain("keyboard");
  });

  test("visual prompt contains contrast ratio numbers", () => {
    const p = getSystemPrompt("visual");
    expect(p).toContain("4.5:1");
    expect(p).toContain("3:1");
    expect(p).toContain("screenshot");
  });

  test("media prompt contains alt text guidance", () => {
    const p = getSystemPrompt("media");
    expect(p).toContain('alt=""');
    expect(p).toContain("decorative");
  });

  test("semantic prompt contains BCP 47 guidance", () => {
    const p = getSystemPrompt("semantic");
    expect(p).toContain("BCP 47");
    expect(p).toContain("Page Name");
  });
});

describe("cleanFragment", () => {
  test("strips scripts", () => {
    expect(cleanFragment('<div><script>alert(1)</script><p>text</p></div>')).not.toContain("<script>");
  });

  test("strips styles", () => {
    expect(cleanFragment('<div><style>.a{color:red}</style><p>text</p></div>')).not.toContain("<style>");
  });

  test("strips SVG", () => {
    const result = cleanFragment('<button><svg><path d="M0 0"/></svg>Click</button>');
    expect(result).not.toContain("<svg>");
    expect(result).toContain("Click");
  });

  test("strips HTML comments", () => {
    expect(cleanFragment("<!-- comment --><p>text</p>")).not.toContain("comment");
  });
});

describe("buildEnrichUserMessage", () => {
  const issue = {
    url: "https://example.com",
    rule: "color-contrast",
    impact: "serious" as const,
    wcagTags: ["wcag143"],
    description: "Elements must meet minimum color contrast",
    help: "Elements must have sufficient color contrast",
    helpUrl: "https://dequeuniversity.com/rules/axe/4.10/color-contrast",
    selector: ".hero p",
    html: "<p style='color:#999'>Hello</p>",
    surroundingHtml: "<div><p style='color:#999'>Hello</p></div>",
    id: "axe-color-contrast-abc",
    xpath: "",
    viewportWidth: 1280,
    pageTitle: "Home",
    checkSource: "axe" as const,
    suggestedFix: null,
    fixConfidence: null,
    violationCategory: "visual" as const,
  };

  test("text-only message for non-visual", () => {
    const msg = buildEnrichUserMessage({ ...issue, violationCategory: "structural" });
    expect(typeof msg.content).toBe("string");
    const content = msg.content as string;
    expect(content).toContain("color-contrast");
    expect(content).toContain("<<<FRAGMENT>>>");
    expect(content).toContain("<<<END>>>");
  });

  test("multimodal message for visual with screenshots", () => {
    const screenshots = { mobile: "mob64", tablet: "tab64", desktop: "desk64" };
    const msg = buildEnrichUserMessage(issue, screenshots);
    expect(Array.isArray(msg.content)).toBe(true);
    const content = msg.content as any[];
    expect(content.some((c: any) => c.type === "image_url")).toBe(true);
    expect(content.filter((c: any) => c.type === "image_url")).toHaveLength(3);
  });
});

describe("parseEnrichResponse", () => {
  test("parses valid JSON response", () => {
    const raw = '{"fix": "<p style=\'color:#595959\'>Hello</p>", "confidence": "high", "wcag": "1.4.3"}';
    const result = parseEnrichResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.fix).toContain("#595959");
    expect(result!.confidence).toBe("high");
    expect(result!.wcag).toBe("1.4.3");
  });

  test("returns null for invalid JSON", () => {
    expect(parseEnrichResponse("not json")).toBeNull();
    expect(parseEnrichResponse("")).toBeNull();
  });

  test("returns null when fix field missing", () => {
    expect(parseEnrichResponse('{"confidence": "high"}')).toBeNull();
  });

  test("handles MANUAL_REVIEW in fix field", () => {
    const raw = '{"fix": "MANUAL_REVIEW: insufficient context", "confidence": "low", "wcag": "1.4.3"}';
    const result = parseEnrichResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.fix).toContain("MANUAL_REVIEW");
  });
});
