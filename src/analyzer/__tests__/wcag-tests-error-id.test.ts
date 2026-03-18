import { describe, test, expect, mock } from "bun:test";
import { testErrorIdentification } from "../wcag-tests";

function mockPage(options: {
  forms?: Array<{
    action: string;
    hasRequired: boolean;
    hasValidationErrors?: boolean; // defaults to hasRequired if omitted
    ariaInvalidCount: number;
    roleAlertCount: number;
    ariaDescribedbyCount: number;
  }>;
}) {
  const forms = options.forms ?? [];
  const page: any = {
    url: mock(() => "https://example.com/contact"),
    $$: mock((selector: string) => {
      if (selector === "form") {
        return Promise.resolve(
          forms.map((f) => {
            const hasErrors = f.hasValidationErrors ?? f.hasRequired;
            return {
              $$: mock((sel: string) => {
                if (sel === '[required], [aria-required="true"]')
                  return Promise.resolve(f.hasRequired ? [{}] : []);
                return Promise.resolve([]);
              }),
              evaluate: mock((fn: Function) => {
                const fnStr = fn.toString();
                // First evaluate: check if form has invalid fields (checkValidity)
                if (fnStr.includes("checkValidity") && !fnStr.includes("ariaInvalidFields")) {
                  return Promise.resolve(hasErrors);
                }
                // Second evaluate: get error accessibility counts
                if (fnStr.includes("ariaInvalidFields")) {
                  return Promise.resolve({
                    invalidCount: hasErrors ? 1 : 0,
                    ariaInvalidCount: f.ariaInvalidCount,
                    roleAlertCount: f.roleAlertCount,
                    ariaDescribedbyCount: f.ariaDescribedbyCount,
                  });
                }
                // Third evaluate: get form selector
                if (fnStr.includes('getAttribute("action")')) {
                  return Promise.resolve(`form[action="${f.action || "self"}"]`);
                }
                return Promise.resolve(null);
              }),
            };
          }),
        );
      }
      return Promise.resolve([]);
    }),
  };
  return page;
}

describe("testErrorIdentification", () => {
  test("skips forms without required fields", async () => {
    const page = mockPage({
      forms: [
        { action: "/search", hasRequired: false, ariaInvalidCount: 0, roleAlertCount: 0, ariaDescribedbyCount: 0 },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues).toHaveLength(0);
  });

  test("skips forms where all required fields are already valid (checkValidity passes)", async () => {
    const page = mockPage({
      forms: [
        { action: "/contact", hasRequired: true, hasValidationErrors: false, ariaInvalidCount: 0, roleAlertCount: 0, ariaDescribedbyCount: 0 },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues).toHaveLength(0);
  });

  test("reports missing aria-invalid", async () => {
    const page = mockPage({
      forms: [
        { action: "/contact", hasRequired: true, ariaInvalidCount: 0, roleAlertCount: 1, ariaDescribedbyCount: 0 },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues.some((i) => i.description.includes("aria-invalid"))).toBe(true);
  });

  test("reports missing role=alert", async () => {
    const page = mockPage({
      forms: [
        { action: "/contact", hasRequired: true, ariaInvalidCount: 1, roleAlertCount: 0, ariaDescribedbyCount: 0 },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues.some((i) => i.description.includes('role="alert"'))).toBe(true);
  });

  test("reports aria-invalid without aria-describedby", async () => {
    const page = mockPage({
      forms: [
        { action: "/contact", hasRequired: true, ariaInvalidCount: 2, roleAlertCount: 1, ariaDescribedbyCount: 0 },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues.some((i) => i.description.includes("aria-describedby"))).toBe(true);
  });

  test("returns no issues when form has proper error handling", async () => {
    const page = mockPage({
      forms: [
        { action: "/contact", hasRequired: true, ariaInvalidCount: 2, roleAlertCount: 1, ariaDescribedbyCount: 2 },
      ],
    });
    const issues = await testErrorIdentification(page, "https://example.com/contact");
    expect(issues).toHaveLength(0);
  });
});
