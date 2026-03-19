import { test, expect } from "bun:test";
import { runTier1 } from "../tier1";
import { TierTimer } from "../tier-timer";
import type { StyleGroup, ElementManifest } from "../../types/manifest";

function makeGroup(selector: string): StyleGroup {
  const el: ElementManifest = {
    selector, tag: "a", role: null, accessibleName: "Link",
    boundingBox: { x: 0, y: 0, width: 100, height: 20 },
    hasHoverCss: false, hasAriaExpanded: false, hasAriaPressed: false,
    hasUnderline: false, isFormControl: false, hasOnclick: false,
    defaultStyles: { borderColor: "rgb(0,0,0)", outlineColor: "rgb(0,0,0)", backgroundColor: "transparent", boxShadow: "none", textDecorationLine: "none", color: "rgb(0,0,255)" },
    parentBg: "rgb(255,255,255)", styleFingerprint: "body|a|link",
  };
  return { fingerprint: el.styleFingerprint, representative: el, members: [el] };
}

test("runTier1 short-circuits when all stylesheets are cross-origin", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Page with only a cross-origin stylesheet (simulated — no local accessible stylesheets)
  await page.setContent(`
    <html>
    <head><link rel="stylesheet" href="https://cdn.example.com/style.css"></head>
    <body><a href="#">Link</a></body>
    </html>
  `);

  const timer = new TierTimer("test-audit", "test-template", "https://example.com");
  const groups = [makeGroup("a")];
  const result = await runTier1(page, groups, "https://example.com", timer);

  // Should promote ALL elements (no CSSOM analysis possible)
  expect(result.promotedElements.length).toBe(1);
  expect(result.issues.length).toBe(0);

  // Timer should show near-instant (skipped)
  const timing = timer.getTiming();
  expect(timing.tier1.durationMs).toBeLessThan(500);

  await page.close();
  await browser.close();
});
