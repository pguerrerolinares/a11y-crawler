import type { Page } from "playwright";

const NAV_PATTERNS = /\b(navigation|link|button|menuitem|menu|tab)\b/i;

/**
 * Get ARIA snapshot from page. Returns YAML string.
 */
export async function getAriaSnapshot(page: Page): Promise<string> {
  try {
    return await page.locator("body").ariaSnapshot();
  } catch {
    return "";
  }
}

/**
 * Count navigation-relevant nodes in ARIA YAML.
 */
export function countNavNodes(ariaYaml: string): number {
  if (!ariaYaml) return 0;
  const lines = ariaYaml.split("\n");
  return lines.filter((line) => NAV_PATTERNS.test(line)).length;
}
