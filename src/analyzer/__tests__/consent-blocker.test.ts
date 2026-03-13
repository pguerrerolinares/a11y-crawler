import { describe, test, expect } from "bun:test";
import {
  CONSENT_SCRIPT_PATTERNS,
  CONSENT_PREHIDE_CSS,
  installConsentBlocker,
  injectConsentPrehideCSS,
} from "../consent-blocker";

describe("consent-blocker", () => {
  describe("CONSENT_SCRIPT_PATTERNS", () => {
    test("has at least 15 patterns", () => {
      expect(CONSENT_SCRIPT_PATTERNS.length).toBeGreaterThanOrEqual(15);
    });

    test("covers cookiebot", () => {
      expect(CONSENT_SCRIPT_PATTERNS.some((p) => p.includes("cookiebot"))).toBe(true);
    });

    test("covers cookielaw (OneTrust)", () => {
      expect(CONSENT_SCRIPT_PATTERNS.some((p) => p.includes("cookielaw"))).toBe(true);
    });

    test("covers cookieyes", () => {
      expect(CONSENT_SCRIPT_PATTERNS.some((p) => p.includes("cookieyes"))).toBe(true);
    });

    test("covers trustarc", () => {
      expect(CONSENT_SCRIPT_PATTERNS.some((p) => p.includes("trustarc"))).toBe(true);
    });

    test("covers quantcast", () => {
      expect(CONSENT_SCRIPT_PATTERNS.some((p) => p.includes("quantcast"))).toBe(true);
    });

    test("covers usercentrics", () => {
      expect(CONSENT_SCRIPT_PATTERNS.some((p) => p.includes("usercentrics"))).toBe(true);
    });

    test("covers didomi (privacy-center)", () => {
      expect(CONSENT_SCRIPT_PATTERNS.some((p) => p.includes("privacy-center"))).toBe(true);
    });

    test("covers termly", () => {
      expect(CONSENT_SCRIPT_PATTERNS.some((p) => p.includes("termly"))).toBe(true);
    });

    test("covers iubenda", () => {
      expect(CONSENT_SCRIPT_PATTERNS.some((p) => p.includes("iubenda"))).toBe(true);
    });

    test("covers consentmanager", () => {
      expect(CONSENT_SCRIPT_PATTERNS.some((p) => p.includes("consentmanager"))).toBe(true);
    });
  });

  describe("CONSENT_PREHIDE_CSS", () => {
    test("contains #CybotCookiebotDialog selector", () => {
      expect(CONSENT_PREHIDE_CSS).toContain("#CybotCookiebotDialog");
    });

    test("contains #onetrust-banner-sdk selector", () => {
      expect(CONSENT_PREHIDE_CSS).toContain("#onetrust-banner-sdk");
    });

    test("contains display: none !important", () => {
      expect(CONSENT_PREHIDE_CSS).toContain("display: none !important");
    });
  });

  describe("exports", () => {
    test("installConsentBlocker is an exported function", () => {
      expect(typeof installConsentBlocker).toBe("function");
    });

    test("injectConsentPrehideCSS is an exported function", () => {
      expect(typeof injectConsentPrehideCSS).toBe("function");
    });
  });
});
