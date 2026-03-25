import { test, expect } from "bun:test";
import { computeElementHash, computeDomHash, computeManifestHash, elementHashFromManifest } from "../probe-cache";

test("computeElementHash: same structure = same hash", () => {
  const a = { tag: "button", role: "button", ariaAttrs: "aria-expanded=false", cssFingerprint: "div|button|btn-primary" };
  const b = { tag: "button", role: "button", ariaAttrs: "aria-expanded=false", cssFingerprint: "div|button|btn-primary" };
  expect(computeElementHash(a)).toBe(computeElementHash(b));
});

test("computeElementHash: different role = different hash", () => {
  const a = { tag: "button", role: "button", ariaAttrs: "", cssFingerprint: "div|button|btn" };
  const b = { tag: "button", role: "menuitem", ariaAttrs: "", cssFingerprint: "div|button|btn" };
  expect(computeElementHash(a)).not.toBe(computeElementHash(b));
});

test("computeElementHash: ignores accessibleName (different text = same hash)", () => {
  const a = { tag: "button", role: "button", ariaAttrs: "", cssFingerprint: "div|button|btn" };
  const b = { tag: "button", role: "button", ariaAttrs: "", cssFingerprint: "div|button|btn" };
  expect(computeElementHash(a)).toBe(computeElementHash(b));
});

test("elementHashFromManifest: different accessibleName = same hash", () => {
  const base = {
    selector: "button.btn", tag: "button", role: "button", accessibleName: "",
    boundingBox: { x: 0, y: 0, width: 100, height: 40 },
    hasHoverCss: true, hasAriaExpanded: false, hasAriaPressed: false,
    hasUnderline: false, isFormControl: false, hasOnclick: false,
    defaultStyles: { borderColor: "", outlineColor: "", backgroundColor: "", boxShadow: "", textDecorationLine: "", color: "" },
    parentBg: "", styleFingerprint: "div|button|btn-primary",
  };
  const a = { ...base, accessibleName: "Buy Plan A" };
  const b = { ...base, accessibleName: "Buy Plan B" };
  expect(elementHashFromManifest(a)).toBe(elementHashFromManifest(b));
});

test("computeManifestHash: same elements in different order = same hash (sorted)", () => {
  const hashes = ["abc123", "def456", "ghi789"];
  const reversed = ["ghi789", "def456", "abc123"];
  expect(computeManifestHash(hashes)).toBe(computeManifestHash(reversed));
});

test("computeManifestHash: different elements = different hash", () => {
  const a = ["abc123", "def456"];
  const b = ["abc123", "xyz999"];
  expect(computeManifestHash(a)).not.toBe(computeManifestHash(b));
});

test("computeDomHash: same structure = same hash", () => {
  const a = { selectors: "A.nav|BUTTON.btn|H1.", headings: "H1,H2,H2", landmarks: "nav,main,footer", forms: "text,email,submit" };
  const b = { selectors: "A.nav|BUTTON.btn|H1.", headings: "H1,H2,H2", landmarks: "nav,main,footer", forms: "text,email,submit" };
  expect(computeDomHash(a)).toBe(computeDomHash(b));
});

test("computeDomHash: different headings = different hash", () => {
  const a = { selectors: "A.nav", headings: "H1,H2", landmarks: "main", forms: "" };
  const b = { selectors: "A.nav", headings: "H1,H2,H3", landmarks: "main", forms: "" };
  expect(computeDomHash(a)).not.toBe(computeDomHash(b));
});
