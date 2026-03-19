/**
 * Derive a WCAG criterion string (e.g. "1.4.1") from axe-core wcag_tags array.
 * Matches tags like "wcag141", "wcag1411" (4-digit for sub-criteria).
 */
export function extractWcagCriterion(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  const wcagTag = (tags as string[]).find(t => /^wcag\d{3,4}$/.test(t));
  if (!wcagTag) return null;
  const digits = wcagTag.replace("wcag", "");
  if (digits.length === 3) return `${digits[0]}.${digits[1]}.${digits[2]}`;
  if (digits.length === 4) return `${digits[0]}.${digits[1]}.${digits.slice(2)}`;
  return null;
}
