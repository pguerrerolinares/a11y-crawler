/**
 * Map WCAG Understanding slugs (used in URLs) to criterion numbers.
 * Covers interactive test slugs and common axe-core rule names.
 */
const SLUG_TO_CRITERION: Record<string, string> = {
  // Interactive test slugs
  "focus-order": "2.4.3",
  "focus-visible": "2.4.7",
  "no-keyboard-trap": "2.1.2",
  "bypass-blocks": "2.4.1",
  "keyboard": "2.1.1",
  // Legal checks (not WCAG but mapped for reporting)
  "accessibility-declaration-missing": "11/2023",
  // Axe best-practice rules without specific WCAG criterion tag
  "region": "1.3.1",
  "landmark-one-main": "1.3.1",
  "heading-order": "1.3.1",
  "empty-heading": "1.3.1",
  "tabindex": "2.4.3",
  "link-name": "2.4.4",
};

/**
 * Derive a WCAG criterion string (e.g. "1.4.1") from wcag_tags array.
 *
 * Resolution order:
 * 1. Axe-style numeric tags: "wcag141" → "1.4.1", "wcag1413" → "1.4.13"
 * 2. WCAG Understanding slugs in tags: "focus-visible" → "2.4.7"
 * 3. Rule name fallback: "region" → "1.3.1"
 */
export function extractWcagCriterion(tags: unknown, rule?: unknown): string | null {
  if (Array.isArray(tags)) {
    const strTags = tags as string[];

    // 1. Axe-style numeric tag (most specific)
    // Supports 3-5 digits: wcag141 → 1.4.1, wcag1410 → 1.4.10, wcag258 → 2.5.8
    // Also handles malformed tags with dots: wcag14.10 → 1.4.10 (legacy data)
    const wcagTag = strTags.find(t => /^wcag[\d.]{3,6}$/.test(t));
    if (wcagTag) {
      const cleaned = wcagTag.replace("wcag", "").replaceAll(".", "");
      if (cleaned.length === 3) return `${cleaned[0]}.${cleaned[1]}.${cleaned[2]}`;
      if (cleaned.length >= 4) return `${cleaned[0]}.${cleaned[1]}.${cleaned.slice(2)}`;
    }

    // 2. Slug lookup from tags (interactive tests)
    for (const tag of strTags) {
      if (SLUG_TO_CRITERION[tag]) return SLUG_TO_CRITERION[tag];
    }
  }

  // 3. Rule name fallback (axe best-practice rules without wcag tags)
  if (typeof rule === "string" && SLUG_TO_CRITERION[rule]) {
    return SLUG_TO_CRITERION[rule];
  }

  return null;
}
