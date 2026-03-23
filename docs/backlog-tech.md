# Technical Backlog

Issues identificados en code reviews de v4.3/v4.4 que no bloquean producción pero deberían resolverse.

---

## MEDIUM — Code Quality

### ~~MEDIUM-1: Window global namespace pollution en hover-focus~~ ✅ CERRADO (v7)
- **Fix:** Reset globals al inicio de cada trigger + `delete` en `finally` block.

### ~~MEDIUM-2: Window global namespace pollution en status-messages~~ ✅ CERRADO (v7)
- **Fix:** Reset/disconnect observer al inicio de cada form + `delete` en `finally` block.

### ~~MEDIUM-3: ARIA states test clicks sin safety check suficiente~~ ✅ CERRADO (v7)
- **Fix:** Safety guard skips `type="submit"`, `target="_blank"`, y texto destructivo (delete/logout/purchase/pay).

### ~~MEDIUM-4: Sensory instructions LLM response sin type guard~~ ✅ CERRADO (v7)
- **Fix:** Type guard completo: valida `typeof`, `Array.isArray(violations)`, y cada violation con `index`/`confidence`/`reason`.

### ~~MEDIUM-5: `require("pixelmatch")` en contexto ESM es frágil~~ ✅ CERRADO (v7)
- **Fix:** `computePixelDiffPercent` ahora es async con `await import("pixelmatch")`.

### ~~MEDIUM-6: Pseudo-heading detection genera falsos positivos en fuentes base 18px+~~ ✅ CERRADO (v7)
- **Fix:** Compara contra `parentFontSize * 1.3` (y >= 16px). Sitios con base 18-20px ya no generan FP.

### ~~MEDIUM-7: Pseudo-list detection matchea card grids~~ ✅ CERRADO (v7)
- **Fix:** Threshold subido de 3+ a 5+ items. Card grids de 3-4 elementos ya no matchean.

---

## MEDIUM — Data Quality

### ~~MEDIUM-9: Axe best-practice rules sin wcagCriterion ni etiqueta~~ ✅ CERRADO (v5)
- **Estado:** RESUELTO en commit `17c43bf` (2026-03-19). `extractWcagCriterion` ampliado con slug lookup + rule name fallback. Resultado: 100% de issues con WCAG criterion.

### ~~MEDIUM-10: Axe issues pierden `message` en pipeline~~ ✅ CERRADO (v7)
- **Fix:** `description` ahora incluye `node.failureSummary` cuando disponible (`v.description + ". " + failureSummary`). Aplicado en scan.ts y probe.ts.

---

## MEDIUM — Observability

### ~~MEDIUM-8: LLM usage tracker no distingue llamadas de visión vs texto~~ ✅ CERRADO (v7)
- **Fix:** `chatVision()` ahora incrementa `visionCalls` y estima `estimatedImageTokens` (~1000/imagen). `chatVisionBatch()` también cuenta imágenes por mensaje.

---

## LOW — Improvements

### ~~LOW-1: Selector builder duplicado en 7+ archivos~~ ✅ CERRADO (v7.3)
- **Estado:** ACEPTADO como limitación arquitectónica de Playwright.
- **Análisis:** `buildCssSelector` existe como versión canónica en `utils.ts` (Node context). Las ~15 copias en `page.evaluate()` (browser context) no pueden importar módulos Node. Inyectar como string pierde tipado TypeScript y reduce legibilidad.
- **Decisión:** Aceptar duplicación en browser context (opción B del análisis). No merece la complejidad por -50 LOC.

### ~~LOW-2: `computeKendallTau` exportado pero duplicado en browser context~~ ✅ CERRADO (v7.3)
- **Estado:** Misma decisión que LOW-1 — duplicación browser context aceptada. La función exportada solo se usa en tests; la versión de producción vive dentro de `page.evaluate()`.

### ~~LOW-3: `isNativeTitle` siempre false en hover-focus~~ ✅ CERRADO (v7.3)
- **Estado:** Eliminado en rewrite de wcag-hover-focus.ts. El nuevo `TriggerCandidate` no tiene el campo.

### ~~LOW-4: Consent banner selector duplicado entre utils.ts y consent-blocker.ts~~ ✅ CERRADO (v7.3)
- **Fix aplicado:** `CONSENT_BANNER_SELECTOR` en utils.ts ahora se genera programáticamente desde `CONSENT_PREHIDE_CSS` de consent-blocker.ts. Una sola fuente de verdad.

---

## MEDIUM — Test Coverage Gaps (vs Auditoria manual de referencia manual audit 2026-01-30)

### ~~MEDIUM-11: `status-messages` no detecta RM-11 (WCAG 4.1.3) en /contacto/~~ ✅ CERRADO (v7)
- **Estado:** Verificado — el scanner detecta 14 issues en `/contacto/` (checkValidity + MutationObserver). Gap cerrado.

### ~~MEDIUM-12: `hover-focus` no detecta RM-15 (WCAG 1.4.13) en /equipo/ — popup CSS-only~~ ✅ CERRADO (v7.3)
- **Fix aplicado:** Detección CSS-only añadida a `wcag-hover-focus.ts` con doble estrategia:
  1. **Discovery ampliado:** Además de triggers explícitos (aria-describedby, data-tooltip), ahora busca elementos con hijos ocultos (opacity:0/display:none/visibility:hidden) que matchean patrones popup (tooltip, popover, dropdown, submenu, overlay) + siblings ocultos de elementos interactivos.
  2. **Detección before/after:** Antes del `handle.hover()` (real mouse, activa CSS `:hover`), captura snapshot de visibilidad de children/siblings. Después compara: si algo pasó de oculto a visible, es un CSS-only popup. Se usa como fallback si MutationObserver no detecta nada.
- **Impacto en performance:** Mínimo — el snapshot es un solo `page.evaluate()` antes del hover.

### ~~MEDIUM-13: `sensory-instructions` no detecta RM-13 (WCAG 1.3.3) en /formulario/~~ WON'T FIX
- **Estado:** Limitación de cobertura de crawling, no de detección. `testSensoryInstructions` funciona correctamente en las páginas que el crawler descubre. `/formulario/` no se crawlea (URL dinámica/JS-only/no enlazada). Para resolverlo se necesitaría soporte de seed URLs manuales o mejorar el crawler para JS navigation — ROI insuficiente para un edge-case.

---

## ~~HIGH — API Bug~~ DESCARTADO

### ~~HIGH-1: Endpoint `/issues` no devuelve issues de tests custom~~
- **Estado:** FALSO POSITIVO — descartado 2026-03-19
- **Causa real:** Paginación default `limit=50`. Los 2,487 issues (31 reglas, 5 sources) están correctamente en DB. El endpoint funciona bien con `?limit=200`.

---

## MEDIUM — Data Quality (actualizado)

### ~~MEDIUM-9: Axe best-practice rules sin wcagCriterion ni etiqueta~~ RESUELTO
- **Estado:** RESUELTO en commit `17c43bf` (2026-03-19)
- **Fix aplicado:** `extractWcagCriterion` ampliado con slug lookup + rule name fallback + soporte tags legacy con puntos. `makeWcagIssue` corregido con `replaceAll`. Resultado: 100% de issues con WCAG criterion.

---

## HIGH — Performance

### ~~HIGH-2: Per-test timing necesario para diagnosticar regresiones de rendimiento~~ RESUELTO
- **Estado:** RESUELTO en v5 (2026-03-19)
- **Fix aplicado:** `TierTimer` implementado en `src/worker/manifest.ts`. Timing por tier (Tier 0/1/2/3) persistido en `audit_spans`. Endpoint `GET /api/audits/:id/performance` expone breakdown completo con `perTemplate`, `tierBreakdown`, `savings`.

### ~~HIGH-3: `waitForTimeout` excesivo en tests interactivos~~ RESUELTO
- **Estado:** RESUELTO en v5 (2026-03-19)
- **Fix aplicado:** `waitForTimeout` reemplazado por `dispatchEvent` + `disableAnimations` en Tier 2 (`src/worker/unified-interaction.ts`). El adaptive wait (`adaptiveWait`) usa `waitForFunction` con ceiling en vez de fixed sleep. Resultado: 702 interacciones en 52s en audit de example-client.com (vs ~640s estimados antes).

### HIGH-4: Sistema de monitorización automática de auditorías (visualización CI-style)
- **Contexto:** La monitorización del progreso de auditorías se hace manualmente via curl + polling de API.
- **Propuesta:** Sistema automatizado que tracka el progreso en tiempo real, capturando timing tier-a-tier, conteo de issues y transiciones de fase.
- **Visualización frontend:** Grafo de pipeline estilo GitHub CI mostrando `DISCOVER → SCAN → CLASSIFY → PROBE (Tier0→1→2→3)` con timing por fase, estado verde/rojo y progreso en vivo.
- **API disponible:** `GET /api/audits/:id/performance` provee todos los datos de tier necesarios.
- **SSE:** Reutilizar eventos SSE para actualizaciones en tiempo real.

### ~~HIGH-5: Tier 1 CSSOM no resuelve ningún elemento~~ ✅ CERRADO (v6)
- **Fix:** Short-circuit en `tier1.ts` detecta cross-origin CSS y promueve todos los elementos directamente a Tier 2. Ahorra ~1s/audit en sitios con CDN CSS.

### ~~MEDIUM-14: Tests interactivos podrían fusionar pasadas por elemento~~ ✅ CERRADO (v6)
- **Fix:** Probe reestructurado en 4 fases. Tier 2 hace una sola pasada unificada hover→focus→click→keyboard. Legacy `testKeyboardOperability` eliminado (absorbido por Tier 2 con focusability pre-check).

### ~~HIGH-6: P4 Capture (color-use CVD) consume 49% del tiempo de auditoría~~ ✅ CERRADO (v7)
- **Fix aplicado (v7.0):** Combo A+C+MEDIUM-16:
  - (A) Solo deuteranopia (skip achromatopsia <0.01% prevalencia) → -50% screenshots/CDP
  - (C) CDP session reutilizada (1 create/detach por página, no por deficiency)
  - (MEDIUM-16) Screenshots solo se guardan si diffPercent > 0.5% → reduce I/O
- **Fix aplicado (v7.1):**
  - (D) CSS fingerprint cache — templates con mismos stylesheets reusan resultados CVD (13/25 cache hit)
  - (E) Pixelmatch a 640×360 en vez de 1280×720 (75% menos píxeles)
- **Fix aplicado (v7.3):** testColorUse + testStatusMessages en `Promise.all` (paralelos)
- **Resultado real:** P4 de 103.8s → 43.7s (−58%)

### ~~HIGH-7: Navigation consume 19% del tiempo de auditoría~~ ✅ CERRADO (v7)
- **Fix aplicado:** `waitUntil: "domcontentloaded"` + timeout 60s→30s en probe phased path
- Legacy probe path sin cambios (rollback seguro con PROBE_V2=false)
- **Resultado real:** Nav de 40.8s → 7.3s (−82%)

### ~~HIGH-8: P2 Interaction consume 26% del tiempo de auditoría~~ ✅ CERRADO (v7)
- **Fix aplicado (v7.2):** Batched hover+focus en un solo `page.evaluate` por elemento (elimina ~10 roundtrips IPC → 1). Popup sub-tests mantienen multi-call (path raro).
- **Resultado real:** P2 de 55.0s → 6.1s (−89%)

### ~~MEDIUM-15: Screenshots LLM vision enviadas sin crop~~ ✅ CERRADO (v7)
- **Fix:** pixelmatch computes diff bounding box → screenshots cropped to diff region (+50px padding) → resized to max 400px (was 800px). Estimated 50-70% token reduction.

### ~~MEDIUM-16: Screenshots de evidencia se guardan para todas las deficiencies~~ ✅ CERRADO (v7)
- **Fix aplicado:** Guard `if (r.diffPercent <= 0.5) continue;` antes de `Bun.write()`. Solo guarda evidencia cuando hay diferencia significativa.

### ~~MEDIUM-17: Tier 3 LLM podría recibir contexto textual + crop~~ ✅ CERRADO (v7)
- **Fix:** Tier 1 DOM heuristic findings (element descriptions) passed as context in Tier 3 LLM prompt. LLM now receives: cropped diff region + list of suspected color-only elements to verify.

### ~~LOW-5: Template dedup no reduce ejecuciones de tests CSS-only~~ ✅ CERRADO (v7.3)
- **Fix aplicado:** `viewportCache` en probe.ts — Phase 3 (reflow, resize-text, text-spacing) cachea resultados por CSS fingerprint (reutiliza `computeCssFingerprint` de screenshot-cvd.ts). Templates con mismos stylesheets reusan resultados. Mismo patrón que `cvdCache` de Phase 4.

---

---

## Refactoring v7.3 (2026-03-23)

### Completado:

| Cambio | Impacto |
|--------|---------|
| Eliminar 8 tests stub/rotos (stubs `typeof`, placeholders, integración sin servidor) | Suite limpia: 252 pass, 0 fail (antes 273 pass, 16 fail) |
| Eliminar legacy probe path (`runProbeLegacy` + flag `PROBE_V2`) | probe.ts 535 → 412 líneas (-23%) |
| Eliminar funciones v3 DB dead code (`insertPage`, `insertIssues`) | db.ts 519 → 450 líneas |
| Unificar issue factories → `makeWcagIssue` con opts | 3 bugs arreglados en tier2 (helpUrl sin slug, wcagTags sin formato, id no-UUID) |
| Split db.ts monolítico → db.ts + db-audit.ts + db-pages.ts + db-tier3.ts | Max archivo 182 LOC (antes 450) |
| Extraer screenshot/CVD/pixel-diff → screenshot-cvd.ts | wcag-color-use.ts 421 → 266 líneas (-37%), utilities reutilizables |

**Total: -512 LOC netas, 3 bugs arreglados, 2 monolitos divididos.**

### No merece la pena (analizado y descartado):

- **Split probe.ts en phase1-4.ts:** Las fases son funciones internas de 20-60 líneas, ya bien organizadas. 412 líneas es razonable para un orquestador.
- **Extraer `buildCssSelector` / `isElementHidden` como inyectable:** Browser context (page.evaluate) no puede importar Node modules. Complejidad > beneficio.
- **Extraer viewport save/restore:** Solo 2 ocurrencias de try/finally de 3 líneas.

---

## Fecha: 2026-03-19 (original) / 2026-03-23 (refactoring update)
## Source: Code review v4.3/v4.4 + comparativa Auditoria manual de referencia audit (verificado con audit bdb0087b)
