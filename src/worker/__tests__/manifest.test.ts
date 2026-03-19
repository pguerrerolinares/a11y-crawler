import { test, expect } from "bun:test";
import { computeStyleFingerprint, groupByFingerprint, collectManifest } from "../manifest";
import type { ElementManifest } from "../../types/manifest";

test("computeStyleFingerprint groups elements with same classes", () => {
  const fp1 = computeStyleFingerprint("div", "nav-link active", "nav");
  const fp2 = computeStyleFingerprint("div", "nav-link active", "nav");
  const fp3 = computeStyleFingerprint("div", "nav-link", "nav");
  expect(fp1).toBe(fp2);
  expect(fp1).not.toBe(fp3);
});

test("groupByFingerprint returns representative per group", () => {
  const elements: ElementManifest[] = [
    { selector: "#a", styleFingerprint: "fp1" } as ElementManifest,
    { selector: "#b", styleFingerprint: "fp1" } as ElementManifest,
    { selector: "#c", styleFingerprint: "fp2" } as ElementManifest,
  ];
  const groups = groupByFingerprint(elements);
  expect(groups.length).toBe(2);
  expect(groups[0].representative.selector).toBe("#a");
  expect(groups[0].members.length).toBe(2);
});

test("collectManifest discovers [onclick] elements without ARIA role", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(`
    <html><body>
      <div onclick="alert(1)" style="width:100px;height:50px">Click me</div>
      <button>Real button</button>
      <div onclick="nav()" style="width:100px;height:50px">Nav div</div>
      <a href="#" onclick="return false">Link with onclick</a>
    </body></html>
  `);

  const manifest = await collectManifest(page);

  // Should find the 2 onclick divs (not the <a> or <button> which are already discovered by tag)
  const onclickDivs = manifest.filter(el => el.tag === "div" && el.hasOnclick === true);
  expect(onclickDivs.length).toBe(2);

  // Native interactive elements should be discovered too
  const button = manifest.find(el => el.tag === "button");
  expect(button).toBeDefined();

  await page.close();
  await browser.close();
});
