import type { Page } from "playwright";
import { adaptiveWait } from "./adaptive-wait";

/**
 * Returns an appropriate test value for a given input type.
 * Exported for testing.
 */
export function getAutoFillValue(type: string | null, tagName: string): string {
  if (tagName === 'textarea') return 'Test accessibility audit';
  switch (type) {
    case 'email': return 'test@example.com';
    case 'tel': return '+34600000000';
    case 'number': return '42';
    case 'url': return 'https://example.com';
    case 'date': return '2024-01-15';
    default: return 'Test accessibility audit';
  }
}

/**
 * Fills all fields in a form and submits it, then waits for status messages.
 * Closes GAP 1: status-messages test couldn't detect ARIA alerts from form submission.
 */
export async function autoFillAndSubmit(page: Page, formSelector: string): Promise<void> {
  const fields = await page.$$(`${formSelector} input, ${formSelector} select, ${formSelector} textarea`);

  for (const field of fields) {
    const type = await field.getAttribute('type');
    const tagName = await field.evaluate((el: Element) => el.tagName.toLowerCase());

    if (tagName === 'select') {
      await field.selectOption({ index: 1 }).catch(() => {});
    } else if (type === 'checkbox' || type === 'radio') {
      await field.check().catch(() => {});
    } else if (type === 'submit' || type === 'button' || type === 'reset' || type === 'hidden' || type === 'file') {
      // Skip non-text inputs
    } else {
      await field.fill(getAutoFillValue(type, tagName)).catch(() => {});
    }
  }

  // Find submit button
  const submitBtn = await page.$(`${formSelector} [type="submit"], ${formSelector} button:not([type="button"])`);
  if (submitBtn) {
    // Submit and wait for status messages
    await submitBtn.click().catch(() => {});
    await adaptiveWait(page, formSelector, 'submit', 2000);
  }
}
