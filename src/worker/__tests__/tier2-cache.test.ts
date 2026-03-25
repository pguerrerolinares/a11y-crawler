import { test, expect } from "bun:test";
import { elementHashFromManifest } from "../probe-cache";
import type { HoverFocusCache } from "../tier2";

const baseManifest = {
  selector: "button.btn",
  tag: "button",
  role: "button",
  accessibleName: "Submit",
  boundingBox: { x: 0, y: 0, width: 100, height: 40 },
  hasHoverCss: true,
  hasAriaExpanded: false,
  hasAriaPressed: false,
  hasUnderline: false,
  isFormControl: false,
  hasOnclick: false,
  defaultStyles: { borderColor: "", outlineColor: "", backgroundColor: "", boxShadow: "", textDecorationLine: "", color: "" },
  parentBg: "rgb(255,255,255)",
  styleFingerprint: "div|button|btn-primary",
};

test("elementHashFromManifest: same structure, different accessibleName = same hash", () => {
  const a = { ...baseManifest, accessibleName: "Buy Plan A" };
  const b = { ...baseManifest, accessibleName: "Buy Plan B" };
  expect(elementHashFromManifest(a)).toBe(elementHashFromManifest(b));
});

test("elementHashFromManifest: different role = different hash", () => {
  const a = { ...baseManifest, role: "button" };
  const b = { ...baseManifest, role: "menuitem" };
  expect(elementHashFromManifest(a)).not.toBe(elementHashFromManifest(b));
});

test("elementHashFromManifest: different ariaExpanded = different hash", () => {
  const a = { ...baseManifest, hasAriaExpanded: false };
  const b = { ...baseManifest, hasAriaExpanded: true };
  expect(elementHashFromManifest(a)).not.toBe(elementHashFromManifest(b));
});

test("HoverFocusCache: stores and retrieves by element hash", () => {
  const cache: HoverFocusCache = new Map();
  const hash = elementHashFromManifest(baseManifest);
  const key = `hf:${hash}`;

  cache.set(key, {
    hoverStyles: { color: "rgb(255,0,0)" },
    focusStyles: { outlineColor: "rgb(0,0,255)" },
    hadPopup: false,
  });

  const hit = cache.get(key);
  expect(hit).toBeDefined();
  expect(hit!.hadPopup).toBe(false);
  expect(hit!.hoverStyles.color).toBe("rgb(255,0,0)");
});

test("HoverFocusCache: popup elements marked non-cacheable (hadPopup=true)", () => {
  const cache: HoverFocusCache = new Map();
  const hash = elementHashFromManifest(baseManifest);
  const key = `hf:${hash}`;

  cache.set(key, {
    hoverStyles: { color: "rgb(255,0,0)" },
    focusStyles: {},
    hadPopup: true,
  });

  const hit = cache.get(key);
  expect(hit!.hadPopup).toBe(true);
  // Caller should NOT use cached styles, must run batchedHoverFocus
});
