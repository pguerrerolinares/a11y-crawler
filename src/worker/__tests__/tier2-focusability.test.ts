import { test, expect } from "bun:test";
import { evaluateKeyboard } from "../tier2";
import type { ElementManifest, InteractionResult } from "../../types/manifest";

function makeElement(overrides: Partial<ElementManifest> = {}): ElementManifest {
  return {
    selector: "div.custom-btn",
    tag: "div",
    role: "button",
    accessibleName: "Submit",
    boundingBox: { x: 0, y: 0, width: 100, height: 50 },
    hasHoverCss: false,
    hasAriaExpanded: false,
    hasAriaPressed: false,
    hasUnderline: false,
    isFormControl: false,
    hasOnclick: true,
    defaultStyles: { borderColor: "", outlineColor: "", backgroundColor: "", boxShadow: "", textDecorationLine: "", color: "" },
    parentBg: "rgb(255,255,255)",
    styleFingerprint: "",
    ...overrides,
  };
}

test("evaluateKeyboard emits custom-element-not-focusable when isFocusable is false", () => {
  const element = makeElement({ role: "button" });
  const result: InteractionResult = { keyboardResponded: undefined };

  const issues = evaluateKeyboard(element, result, "https://example.com", false);

  expect(issues.length).toBe(1);
  expect(issues[0].rule).toBe("custom-element-not-focusable");
  expect(issues[0].impact).toBe("critical");
});

test("evaluateKeyboard skips focusability check for native interactive elements", () => {
  const element = makeElement({ tag: "button", role: null });
  const result: InteractionResult = {};

  const issues = evaluateKeyboard(element, result, "https://example.com", false);
  expect(issues.length).toBe(0); // native elements are filtered by isNativeInteractive
});

test("evaluateKeyboard detects non-focusable onclick element without role", () => {
  const element = makeElement({ tag: "div", role: null, hasOnclick: true });
  const result: InteractionResult = {};

  const issues = evaluateKeyboard(element, result, "https://example.com", false);
  expect(issues.length).toBe(1);
  expect(issues[0].rule).toBe("custom-element-not-focusable");
  expect(issues[0].description).toContain("[onclick]");
});

test("evaluateKeyboard reports keyboard-operability when focusable but not responding", () => {
  const element = makeElement({ role: "button" });
  const result: InteractionResult = { keyboardResponded: false };

  const issues = evaluateKeyboard(element, result, "https://example.com", true);
  expect(issues.length).toBe(1);
  expect(issues[0].rule).toBe("keyboard-operability");
});
