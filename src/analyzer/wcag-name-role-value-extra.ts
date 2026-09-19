// src/analyzer/wcag-name-role-value-extra.ts
import type { Page } from "playwright";
import type { Issue } from "../types/issue";

const MAX_INSTANCES = 8;

function makeLabelMismatchIssue(
  url: string, description: string, selector: string, html: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule: "label-content-name-mismatch",
    impact: "serious", description,
    help: "El texto del label visible de un control de formulario debe estar contenido en su nombre accesible computado (WCAG 2.5.3 Label in Name), para que coincida con lo que dicen los usuarios de control por voz.",
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/label-in-name",
    wcagTags: ["wcag253"],
    selector, html, surroundingHtml: "", xpath: "",
    viewportWidth: 1280, pageTitle: "",
    checkSource: "wcag-custom",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "2.5.3",
    violationCategory: "semantic",
  };
}

function makeInteractiveNestingIssue(
  url: string, description: string, selector: string, html: string,
): Issue {
  return {
    id: crypto.randomUUID(), url, rule: "interactive-in-interactive",
    impact: "serious", description,
    help: "No anides elementos interactivos (button, a[href], input, select, textarea, [role de widget]) dentro de otro elemento interactivo. Es HTML inválido y produce un estado de foco/activación ambiguo para tecnología de asistencia (WCAG 4.1.2 Name, Role, Value).",
    helpUrl: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value",
    wcagTags: ["wcag412"],
    selector, html, surroundingHtml: "", xpath: "",
    viewportWidth: 1280, pageTitle: "",
    checkSource: "wcag-custom",
    suggestedFix: null, fixConfidence: null,
    llmConfidence: null, wcagCriterion: "4.1.2",
    violationCategory: "interactive",
  };
}

/**
 * WCAG 2.5.3 — Label in Name: for form controls, the visible <label> text
 * must be contained in the control's computed accessible name.
 *
 * Targets controls reached via label[for="X"] where X is either the control
 * itself or a wrapper (e.g. a custom element) around exactly one focusable
 * form control/widget. Only flags controls whose accessible name is
 * *overridden* by aria-labelledby/aria-label (e.g. a value-mirroring
 * aria-labelledby that exposes the selected option instead of the field
 * label) — a control whose name comes naturally from its own label can never
 * mismatch, so it's excluded by construction.
 */
export async function testLabelNameMismatch(page: Page, url: string): Promise<Issue[]> {
  const { CONSENT_BANNER_SELECTOR } = await import("./utils");

  const findings = await page.evaluate((consentSelector: string) => {
    function normalize(s: string | null | undefined): string {
      return (s ?? "").replace(/^\*+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
    }

    function computeAccessibleName(el: Element): string {
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const texts = labelledby.split(/\s+/).filter(Boolean).map((id) => {
          const ref = document.getElementById(id);
          return ref ? (ref.textContent ?? "").trim() : "";
        }).filter(Boolean);
        if (texts.length) return texts.join(" ").trim();
      }
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return (lbl.textContent ?? "").trim();
      }
      const wrappingLabel = el.closest("label");
      if (wrappingLabel) return (wrappingLabel.textContent ?? "").trim();
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder.trim();
      const title = el.getAttribute("title");
      if (title) return title.trim();
      return "";
    }

    const FORM_CONTROL_SELECTOR =
      'input, select, textarea, button, [role="combobox"], [role="listbox"], [role="button"]';

    const results: Array<{
      controlSelector: string; labelText: string; accessibleName: string; html: string;
    }> = [];

    document.querySelectorAll("label[for]").forEach((label) => {
      if (label.closest(consentSelector)) return;

      const forId = label.getAttribute("for");
      if (!forId) return;
      const target = document.getElementById(forId);
      if (!target) return;

      // Resolve the real focusable control: either the target itself, or —
      // when the label targets a non-native wrapper (e.g. a custom element) —
      // the single form control/widget nested inside it. Ambiguous wrappers
      // (0 or 2+ candidate controls) are skipped to avoid false positives.
      let control: Element = target;
      if (!target.matches(FORM_CONTROL_SELECTOR)) {
        const inner = target.querySelectorAll(FORM_CONTROL_SELECTOR);
        if (inner.length !== 1) return;
        control = inner[0];
      }

      const cs = getComputedStyle(control);
      if (cs.display === "none" || cs.visibility === "hidden") return;

      const visibleLabelText = normalize(label.textContent);
      if (!visibleLabelText) return;

      // A control whose name comes naturally from this very label (no
      // aria-label/aria-labelledby override) cannot mismatch — skip.
      const hasOverride = control.hasAttribute("aria-labelledby") || control.hasAttribute("aria-label");
      if (!hasOverride) return;

      const accessibleName = normalize(computeAccessibleName(control));
      if (!accessibleName) return;

      if (accessibleName.includes(visibleLabelText) || visibleLabelText.includes(accessibleName)) return;

      const el = control as HTMLElement;
      const selector =
        el.id ? `#${el.id}` :
        el.className && typeof el.className === "string"
          ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : el.tagName.toLowerCase();

      results.push({
        controlSelector: selector,
        labelText: label.textContent?.trim() ?? "",
        accessibleName,
        html: el.outerHTML.slice(0, 200),
      });
    });

    return results;
  }, CONSENT_BANNER_SELECTOR);

  return findings.slice(0, MAX_INSTANCES).map((f) =>
    makeLabelMismatchIssue(
      url,
      `El control "${f.controlSelector}" tiene un label visible ("${f.labelText}") que no está contenido en su nombre accesible computado ("${f.accessibleName}"). Un usuario de control por voz dirá el label visible y el comando no coincidirá con el nombre accesible real.`,
      f.controlSelector,
      f.html,
    ),
  );
}

/**
 * WCAG 4.1.2 — Name, Role, Value: interactive elements must not be nested
 * inside another interactive element (invalid content model, ambiguous
 * activation/focus target for assistive tech).
 *
 * For every interactive element, walks up to its nearest ancestor that is a
 * widget with presentational children (button, link, checkbox, tab…, same
 * outer set as axe's nested-interactive) and flags the pair. Containers that
 * are merely focusable (tabindex=0 tabpanel or scrollable region, both
 * recommended patterns) are not widgets and never count as the outer
 * element. Excludes <summary> and hidden elements.
 */
export async function testInteractiveNesting(page: Page, url: string): Promise<Issue[]> {
  const { CONSENT_BANNER_SELECTOR } = await import("./utils");

  const findings = await page.evaluate((consentSelector: string) => {
    const INTERACTIVE_SELECTOR = [
      "button", "a[href]", "input", "select", "textarea",
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="tab"]', '[role="menuitem"]', '[role="switch"]',
      '[role="combobox"]', '[role="listbox"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(", ");

    // Outer candidates: widgets whose content must not contain interactive
    // descendants. Deliberately excludes plain [tabindex] containers.
    const WIDGET_SELECTOR = [
      "button", "a[href]",
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
      '[role="switch"]', '[role="option"]', '[role="slider"]',
    ].join(", ");

    const results: Array<{ outerSelector: string; innerSelector: string; innerText: string; html: string }> = [];

    document.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) => {
      if (el.tagName === "SUMMARY") return; // native disclosure widget, not ambiguous
      if (el.closest(consentSelector)) return;

      const ancestor = el.parentElement ? el.parentElement.closest(WIDGET_SELECTOR) : null;
      if (!ancestor) return;

      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return;

      const buildSelector = (e: Element): string => {
        const he = e as HTMLElement;
        return he.id ? `#${he.id}` :
          he.className && typeof he.className === "string"
            ? `${he.tagName.toLowerCase()}.${he.className.trim().split(/\s+/).slice(0, 3).join(".")}`
            : he.tagName.toLowerCase();
      };

      results.push({
        outerSelector: buildSelector(ancestor),
        innerSelector: buildSelector(el),
        innerText: (el.textContent ?? "").trim().slice(0, 40),
        html: (ancestor as HTMLElement).outerHTML.slice(0, 200),
      });
    });

    return results;
  }, CONSENT_BANNER_SELECTOR);

  return findings.slice(0, MAX_INSTANCES).map((f) =>
    makeInteractiveNestingIssue(
      url,
      `Elemento interactivo "${f.innerSelector}" ("${f.innerText}") está anidado dentro de otro elemento interactivo "${f.outerSelector}". Estado de foco/activación ambiguo para tecnología de asistencia.`,
      f.outerSelector,
      f.html,
    ),
  );
}
