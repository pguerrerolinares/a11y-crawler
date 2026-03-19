import { test, expect } from "bun:test";
import { evaluateHoverFocus } from "../tier2";
import type { ElementManifest, InteractionResult } from "../../types/manifest";

function makeElement(): ElementManifest {
  return {
    selector: "a.nav-link", tag: "a", role: null, accessibleName: "Menu",
    boundingBox: { x: 100, y: 100, width: 200, height: 40 },
    hasHoverCss: false, hasAriaExpanded: false, hasAriaPressed: false,
    hasUnderline: false, isFormControl: false, hasOnclick: false,
    defaultStyles: { borderColor: "", outlineColor: "", backgroundColor: "", boxShadow: "", textDecorationLine: "", color: "" },
    parentBg: "rgb(255,255,255)", styleFingerprint: "",
  };
}

test("evaluateHoverFocus reports not-persistent when popup disappears", () => {
  const el = makeElement();
  const result: InteractionResult = {
    hoverPopup: { selector: ".tooltip", type: "css-transition", boundingBox: { x: 100, y: 140, width: 200, height: 30 } },
    popupPersistent: false,
    popupHoverable: true,
    popupDismissible: true,
  };
  const issues = evaluateHoverFocus(el, result, "https://example.com");
  expect(issues.length).toBe(1);
  expect(issues[0].rule).toBe("hover-focus");
  expect(issues[0].description).toContain("disappears");
});

test("evaluateHoverFocus reports not-hoverable", () => {
  const el = makeElement();
  const result: InteractionResult = {
    hoverPopup: { selector: ".tooltip", type: "css-transition", boundingBox: { x: 100, y: 140, width: 200, height: 30 } },
    popupPersistent: true,
    popupHoverable: false,
    popupDismissible: true,
  };
  const issues = evaluateHoverFocus(el, result, "https://example.com");
  expect(issues.length).toBe(1);
  expect(issues[0].description).toContain("not hoverable");
});

test("evaluateHoverFocus reports not-dismissible", () => {
  const el = makeElement();
  const result: InteractionResult = {
    hoverPopup: { selector: ".tooltip", type: "css-transition", boundingBox: { x: 100, y: 140, width: 200, height: 30 } },
    popupPersistent: true,
    popupHoverable: true,
    popupDismissible: false,
  };
  const issues = evaluateHoverFocus(el, result, "https://example.com");
  expect(issues.length).toBe(1);
  expect(issues[0].description).toContain("dismissed");
});

test("evaluateHoverFocus returns no issues when all 3 pass", () => {
  const el = makeElement();
  const result: InteractionResult = {
    hoverPopup: { selector: ".tooltip", type: "css-transition", boundingBox: { x: 100, y: 140, width: 200, height: 30 } },
    popupPersistent: true,
    popupHoverable: true,
    popupDismissible: true,
  };
  const issues = evaluateHoverFocus(el, result, "https://example.com");
  expect(issues.length).toBe(0);
});
