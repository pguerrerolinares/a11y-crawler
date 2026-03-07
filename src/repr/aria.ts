import type { Page } from "playwright";

const NAV_PATTERNS = /\b(navigation|link|button|menuitem|menu|tab)\b/i;

/**
 * Remove top-level dialog blocks (cookie banners, modals) from ARIA snapshot YAML.
 * Dialogs at the start of the ARIA tree waste token budget on non-navigation content.
 */
export function removeDialogs(ariaYaml: string): string {
  if (!ariaYaml) return "";
  // Match `- dialog ...` blocks at start of line (no indentation) and all indented lines that follow
  const result = ariaYaml.replace(/^- dialog[^\n]*\n([ \t][^\n]*\n)*/gm, "");
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Get ARIA snapshot from page. Returns YAML string.
 */
export async function getAriaSnapshot(page: Page): Promise<string> {
  try {
    const raw = await page.locator("body").ariaSnapshot();
    return removeDialogs(raw);
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
