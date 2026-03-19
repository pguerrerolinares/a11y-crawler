import { test, expect } from "bun:test";
import { computeStyleFingerprint, groupByFingerprint } from "../manifest";
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
