import { test, expect } from "bun:test";
import { evaluateStateChange, evaluateKeyboard, isNativeInteractive } from "../tier2";
import type { ElementManifest, InteractionResult } from "../../types/manifest";

test("evaluateStateChange returns issue when no hover change detected", () => {
  const element = {
    selector: "#btn",
    defaultStyles: { backgroundColor: "rgb(255,255,255)", borderColor: "rgb(0,0,0)", outlineColor: "", boxShadow: "", textDecorationLine: "", color: "rgb(0,0,0)" },
    parentBg: "rgb(255,255,255)",
  } as ElementManifest;

  const result: InteractionResult = {
    hoverStyles: { backgroundColor: "rgb(255,255,255)", borderColor: "rgb(0,0,0)" }, // no change
  };

  const issues = evaluateStateChange(element, result, "https://example.com");
  // No visible change → issue
  expect(issues.length).toBeGreaterThan(0);
});

test("isNativeInteractive returns true for native elements", () => {
  expect(isNativeInteractive("button")).toBe(true);
  expect(isNativeInteractive("a")).toBe(true);
  expect(isNativeInteractive("input")).toBe(true);
  expect(isNativeInteractive("div")).toBe(false);
});

test("evaluateKeyboard returns issue when element did not respond", () => {
  const element = {
    selector: "#custom-btn",
    role: "button",
    tag: "div",
  } as ElementManifest;

  const result: InteractionResult = {
    keyboardResponded: false,
  };

  const issues = evaluateKeyboard(element, result, "https://example.com");
  expect(issues.length).toBeGreaterThan(0);
});
