import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Browser, Page } from "playwright";
import { testLabelNameMismatch, testInteractiveNesting } from "./wcag-name-role-value-extra";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

const URL = "http://test.local/";

// ---- WCAG 2.5.3 label-content-name-mismatch ----

test("label mismatch: custom select whose aria-labelledby mirrors the selected value", async () => {
  await page.setContent(`
    <label for="servicio">Servicio relacionado con la consulta</label>
    <app-select id="servicio">
      <div role="combobox" tabindex="0" aria-labelledby="val">
        <span id="val">Nuevo Contacto</span>
      </div>
    </app-select>
  `);
  const issues = await testLabelNameMismatch(page, URL);
  expect(issues.length).toBe(1);
  expect(issues[0].rule).toBe("label-content-name-mismatch");
  expect(issues[0].wcagCriterion).toBe("2.5.3");
});

test("label mismatch: control named naturally by its label is not flagged", async () => {
  await page.setContent(`<label for="email">Email</label><input id="email" type="email">`);
  expect(await testLabelNameMismatch(page, URL)).toEqual([]);
});

test("label mismatch: aria-label that contains the visible label is not flagged", async () => {
  await page.setContent(`<label for="q">Buscar</label><input id="q" aria-label="Buscar en el sitio">`);
  expect(await testLabelNameMismatch(page, URL)).toEqual([]);
});

test("label mismatch: required asterisk and case are normalized", async () => {
  await page.setContent(`<label for="n">* Nombre</label><input id="n" aria-label="nombre">`);
  expect(await testLabelNameMismatch(page, URL)).toEqual([]);
});

test("label mismatch: ambiguous wrapper with 2 controls is skipped", async () => {
  await page.setContent(`
    <label for="w">Fecha</label>
    <div id="w"><input aria-label="Día"><input aria-label="Mes"></div>
  `);
  expect(await testLabelNameMismatch(page, URL)).toEqual([]);
});

// ---- WCAG 4.1.2 interactive-in-interactive ----

test("nesting: button nested in button (built via DOM, as Angular projection does)", async () => {
  await page.setContent(`<div id="host"></div>`);
  await page.evaluate(() => {
    const outer = document.createElement("button");
    outer.setAttribute("aria-pressed", "false");
    const inner = document.createElement("button");
    inner.textContent = "Política de Privacidad";
    outer.appendChild(inner);
    document.getElementById("host")!.appendChild(outer);
  });
  const issues = await testInteractiveNesting(page, URL);
  expect(issues.length).toBe(1);
  expect(issues[0].rule).toBe("interactive-in-interactive");
  expect(issues[0].wcagCriterion).toBe("4.1.2");
});

test("nesting: link inside role=button is flagged", async () => {
  await page.setContent(`<div role="button" tabindex="0">Card <a href="/x">ver más</a></div>`);
  expect((await testInteractiveNesting(page, URL)).length).toBe(1);
});

test("nesting: sibling controls are not flagged", async () => {
  await page.setContent(`<form><input aria-label="a"><button>Enviar</button><a href="/x">x</a></form>`);
  expect(await testInteractiveNesting(page, URL)).toEqual([]);
});

test("nesting: hidden inner control is not flagged", async () => {
  await page.setContent(`<div role="button" tabindex="0">Card <a href="/x" style="display:none">x</a></div>`);
  expect(await testInteractiveNesting(page, URL)).toEqual([]);
});

// Containers made focusable on purpose (APG tabpanel, axe scrollable-region-focusable)
// are not widgets: their descendants are legitimately interactive.
test("nesting: tabpanel with tabindex=0 containing links is not flagged", async () => {
  await page.setContent(`
    <div role="tabpanel" tabindex="0" aria-label="Panel"><a href="/a">A</a><button>B</button></div>
  `);
  expect(await testInteractiveNesting(page, URL)).toEqual([]);
});

test("nesting: scrollable region with tabindex=0 containing links is not flagged", async () => {
  await page.setContent(`
    <div tabindex="0" role="region" aria-label="Tabla" style="overflow:auto;height:40px">
      <a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>
    </div>
  `);
  expect(await testInteractiveNesting(page, URL)).toEqual([]);
});
