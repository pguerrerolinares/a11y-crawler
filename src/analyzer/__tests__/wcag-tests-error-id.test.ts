import { describe, test, expect, mock } from "bun:test";
import { testErrorIdentification } from "../wcag-tests";

function mockPage(options: {
  forms?: Array<{
    action: string;
    hasRequired: boolean;
    hasSubmitBtn: boolean;
    ariaInvalidCount: number;
    roleAlertCount: number;
    ariaDescribedbyCount: number;
    navigates: boolean;
  }>;
}) {
  const forms = options.forms ?? [];
  const page: any = {
    url: mock(() => "https://example.com/contact"),
    $$: mock((selector: string) => {
      if (selector === "form") {
        return Promise.resolve(
          forms.map((f) => ({
            getAttribute: mock((attr: string) => (attr === "action" ? f.action : null)),
            $$: mock((sel: string) => {
              if (sel === '[required], [aria-required="true"]')
                return Promise.resolve(f.hasRequired ? [{}] : []);
              if (sel === '[aria-invalid="true"]')
                return Promise.resolve(Array(f.ariaInvalidCount).fill({}));
              if (sel === '[aria-invalid="true"][aria-describedby]')
                return Promise.resolve(Array(f.ariaDescribedbyCount).fill({}));
              if (sel === '[role="alert"]')
                return Promise.resolve(Array(f.roleAlertCount).fill({}));
              return Promise.resolve([]);
            }),
            $: mock((sel: string) => {
              if (
                sel === 'button[type="submit"], input[type="submit"], button:not([type])' &&
                f.hasSubmitBtn
              )
                return Promise.resolve({
                  click: mock(() => Promise.resolve()),
                });
              return Promise.resolve(null);
            }),
          })),
        );
      }
      if (selector === '[role="alert"]')
        return Promise.resolve(
          forms.length > 0 ? Array(forms[0].roleAlertCount).fill({}) : [],
        );
      return Promise.resolve([]);
    }),
    waitForTimeout: mock(() => Promise.resolve()),
    goBack: mock(() => Promise.resolve()),
  };
  return page;
}

describe("testErrorIdentification", () => {
  test("skips forms with payment/auth action URLs", async () => {
    const page = mockPage({
      forms: [
        { action: "https://stripe.com/checkout", hasRequired: true, hasSubmitBtn: true, ariaInvalidCount: 0, roleAlertCount: 0, ariaDescribedbyCount: 0, navigates: false },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues).toHaveLength(0);
  });

  test("skips forms without required fields", async () => {
    const page = mockPage({
      forms: [
        { action: "/search", hasRequired: false, hasSubmitBtn: true, ariaInvalidCount: 0, roleAlertCount: 0, ariaDescribedbyCount: 0, navigates: false },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues).toHaveLength(0);
  });

  test("reports missing aria-invalid after empty submission", async () => {
    const page = mockPage({
      forms: [
        { action: "/contact", hasRequired: true, hasSubmitBtn: true, ariaInvalidCount: 0, roleAlertCount: 1, ariaDescribedbyCount: 0, navigates: false },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues.some((i) => i.description.includes("aria-invalid"))).toBe(true);
  });

  test("reports missing role=alert after empty submission", async () => {
    const page = mockPage({
      forms: [
        { action: "/contact", hasRequired: true, hasSubmitBtn: true, ariaInvalidCount: 1, roleAlertCount: 0, ariaDescribedbyCount: 0, navigates: false },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues.some((i) => i.description.includes("role=\"alert\""))).toBe(true);
  });

  test("reports aria-invalid without aria-describedby", async () => {
    const page = mockPage({
      forms: [
        { action: "/contact", hasRequired: true, hasSubmitBtn: true, ariaInvalidCount: 2, roleAlertCount: 1, ariaDescribedbyCount: 0, navigates: false },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues.some((i) => i.description.includes("aria-describedby"))).toBe(true);
  });

  test("returns no issues when form has proper error handling", async () => {
    const page = mockPage({
      forms: [
        { action: "/contact", hasRequired: true, hasSubmitBtn: true, ariaInvalidCount: 2, roleAlertCount: 1, ariaDescribedbyCount: 2, navigates: false },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues).toHaveLength(0);
  });
});
