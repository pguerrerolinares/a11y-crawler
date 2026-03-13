import type { BrowserContext, Page } from "playwright";

export const CONSENT_SCRIPT_PATTERNS = [
  "**/consent.cookiebot.com/**",
  "**/consentcdn.cookiebot.com/**",
  "**/consent.cookiebot.eu/**",
  "**/cdn.cookielaw.org/**",
  "**/cdn-cookieyes.com/**",
  "**/*.cookieyes.com/**",
  "**/consent.trustarc.com/**",
  "**/quantcast.mgr.consensu.org/**",
  "**/cmp.quantcast.com/**",
  "**/app.usercentrics.eu/**",
  "**/web.eu1.cmp.usercentrics.eu/**",
  "**/sdk.privacy-center.org/**",
  "**/app.termly.io/consent-sync*",
  "**/app.termly.io/resource-blocker/**",
  "**/cdn.iubenda.com/cs/**",
  "**/cdn.consentmanager.net/**",
  "**/c.evidon.com/**",
  "**/cdn.privacy-mgmt.com/**",
  "**/cdn.admiral.digital/**",
];

export async function installConsentBlocker(context: BrowserContext): Promise<void> {
  for (const pattern of CONSENT_SCRIPT_PATTERNS) {
    await context.route(pattern, (route) => route.abort());
  }
}

export const CONSENT_PREHIDE_CSS = `
  #CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay,
  #onetrust-banner-sdk, #onetrust-consent-sdk, .onetrust-pc-dark-filter,
  .trustarc-banner-container, .truste_popframe, .truste_overlay,
  #cmpbox, #cmpbox2, #cmpwrapper, .klaro,
  [id*="cookie-banner"], [id*="cookie-consent"], [id*="cookieConsent"],
  [class*="cookie-banner"], [class*="cookie-consent"], [class*="cookieConsent"],
  [id*="gdpr-banner"], [class*="gdpr-banner"],
  [id*="consent-banner"], [class*="consent-banner"]
  { display: none !important; visibility: hidden !important; pointer-events: none !important; }
`;

export async function injectConsentPrehideCSS(page: Page): Promise<void> {
  await page.addStyleTag({ content: CONSENT_PREHIDE_CSS });
}
