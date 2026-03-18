/**
 * Build a CSS selector for a DOM element, suitable for issue reporting.
 * Prefers #id > tag.class1.class2.class3 > tag
 * Max 3 classes to keep selectors readable.
 */
export function buildCssSelector(tagName: string, id: string, className: string): string {
  if (id) return `#${id}`;
  const tag = tagName.toLowerCase();
  if (className && typeof className === "string") {
    const classes = className.trim().split(/\s+/).slice(0, 3).join(".");
    if (classes) return `${tag}.${classes}`;
  }
  return tag;
}

/**
 * CSS selector matching known consent/cookie banner containers.
 * Use with el.closest() inside page.evaluate() to skip elements inside banners.
 * Must be kept in sync with consent-blocker.ts CONSENT_PREHIDE_CSS.
 */
export const CONSENT_BANNER_SELECTOR = [
  "#CybotCookiebotDialog", "#onetrust-banner-sdk", "#onetrust-consent-sdk",
  "[id*='cookie-banner']", "[id*='cookie-consent']", "[id*='cookieConsent']",
  "[class*='cookie-banner']", "[class*='cookie-consent']", "[class*='cookieConsent']",
  "[id*='gdpr-banner']", "[class*='gdpr-banner']",
  "[id*='consent-banner']", "[class*='consent-banner']",
  "#cmpbox", "#cmpbox2", "#cmpwrapper", ".klaro",
].join(", ");
