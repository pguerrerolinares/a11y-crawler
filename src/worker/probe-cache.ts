import { createHash } from "node:crypto";
import type { ElementManifest } from "../types/manifest";

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/**
 * Computes a fingerprint for an element based on structural properties.
 * Excludes accessibleName — two buttons with different labels but same
 * CSS+role+tag have identical interaction behavior.
 */
export function computeElementHash(el: {
  tag: string;
  role: string | null;
  ariaAttrs: string;
  cssFingerprint: string;
}): string {
  return md5(`${el.tag}|${el.role ?? ""}|${el.ariaAttrs}|${el.cssFingerprint}`);
}

/**
 * Extract ARIA attribute string from ElementManifest for hashing.
 * Only includes boolean ARIA state attributes that affect interaction behavior.
 */
export function extractInteractionTraits(el: ElementManifest): string {
  const parts: string[] = [];
  if (el.hasAriaExpanded) parts.push("expanded");
  if (el.hasAriaPressed) parts.push("pressed");
  if (el.isFormControl) parts.push("form");
  if (el.hasOnclick) parts.push("onclick");
  return parts.sort().join(",");
}

/**
 * Convenience: compute elementHash directly from an ElementManifest.
 */
export function elementHashFromManifest(el: ElementManifest): string {
  return computeElementHash({
    tag: el.tag,
    role: el.role,
    ariaAttrs: extractInteractionTraits(el),
    cssFingerprint: el.styleFingerprint,
  });
}

export function computeManifestHash(elementHashes: string[]): string {
  return md5(elementHashes.slice().sort().join("|"));
}

export interface DomStructure {
  selectors: string;
  headings: string;
  landmarks: string;
  forms: string;
}

export function computeDomHash(dom: DomStructure): string {
  return md5(`${dom.selectors}::${dom.headings}::${dom.landmarks}::${dom.forms}`);
}

/**
 * Collect DOM structure from a Playwright page for domHash computation.
 * Runs a single page.evaluate() — cheap (~5ms).
 */
export async function collectDomStructure(page: import("playwright").Page): Promise<DomStructure> {
  return await page.evaluate(() => {
    const selectors = Array.from(document.querySelectorAll("*"))
      .filter(el => el.id || el.className || el.tagName !== "DIV")
      .map(el => `${el.tagName}.${el.className}`)
      .sort().join("|");
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
      .map(h => h.tagName).join(",");
    const landmarks = Array.from(document.querySelectorAll("[role],nav,main,header,footer,aside"))
      .map(l => l.getAttribute("role") || l.tagName).join(",");
    const forms = Array.from(document.querySelectorAll("input,select,textarea"))
      .map(f => f.getAttribute("type") || f.tagName).join(",");
    return { selectors, headings, landmarks, forms };
  });
}

export function computeTemplateHash(manifestHash: string, cssHash: string, domHash: string): string {
  return md5(`${manifestHash}|${cssHash}|${domHash}`);
}
