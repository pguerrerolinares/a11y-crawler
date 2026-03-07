import { describe, test, expect } from "bun:test";
import { isBlacklistedAction, isBlacklistedUrl } from "../safety.ts";

describe("isBlacklistedAction", () => {
  test("blocks dangerous actions", () => {
    expect(isBlacklistedAction("Logout button")).toBe(true);
    expect(isBlacklistedAction("Cerrar sesion")).toBe(true);
    expect(isBlacklistedAction("Delete account")).toBe(true);
    expect(isBlacklistedAction("Buy now")).toBe(true);
    expect(isBlacklistedAction("Accept cookies")).toBe(true);
    expect(isBlacklistedAction("Submit form")).toBe(true);
    expect(isBlacklistedAction("Download PDF")).toBe(true);
  });

  test("allows safe navigation actions", () => {
    expect(isBlacklistedAction("Navigation menu")).toBe(false);
    expect(isBlacklistedAction("Services dropdown")).toBe(false);
    expect(isBlacklistedAction("Expand section")).toBe(false);
    expect(isBlacklistedAction("About us link")).toBe(false);
  });
});

describe("isBlacklistedUrl", () => {
  test("blocks non-HTML URLs", () => {
    expect(isBlacklistedUrl("https://example.com/doc.pdf")).toBe(true);
    expect(isBlacklistedUrl("https://example.com/img.png")).toBe(true);
    expect(isBlacklistedUrl("mailto:a@b.com")).toBe(true);
    expect(isBlacklistedUrl("tel:+34944355050")).toBe(true);
    expect(isBlacklistedUrl("javascript:void(0)")).toBe(true);
  });

  test("allows HTML URLs", () => {
    expect(isBlacklistedUrl("https://example.com/about")).toBe(false);
    expect(isBlacklistedUrl("https://example.com/servicios/")).toBe(false);
  });
});
