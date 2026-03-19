# Technical Backlog

Issues identificados en code reviews de v4.3/v4.4 que no bloquean producción pero deberían resolverse.

---

## MEDIUM — Code Quality

### MEDIUM-1: Window global namespace pollution en hover-focus
- **Archivo:** `src/analyzer/wcag-hover-focus.ts:72-106`
- **Issue:** `__hoverPopup` y `__hoverObs` se inyectan en `window` y no se limpian en el success path. Si un trigger anterior deja datos stale, el siguiente puede leerlos.
- **Fix:** Resetear globals al inicio de cada iteración de trigger y hacer `delete` en finally.

### MEDIUM-2: Window global namespace pollution en status-messages
- **Archivo:** `src/analyzer/wcag-status-messages.ts:42,98`
- **Issue:** `__statusMsgLog` y `__statusMsgObs` acumulan entries entre iteraciones de forms.
- **Fix:** Clear globals al inicio de cada form iteration.

### MEDIUM-3: ARIA states test clicks sin safety check suficiente
- **Archivo:** `src/analyzer/wcag-aria-states.ts:81`
- **Issue:** `handle.click()` en producción puede disparar acciones destructivas (submit, delete, purchase). El selector `[aria-haspopup]` puede matchear botones peligrosos.
- **Fix:** Skip `type="submit"` buttons. Considerar `dispatchEvent(new MouseEvent('click'))` cancelable.

### MEDIUM-4: Sensory instructions LLM response sin type guard
- **Archivo:** `src/analyzer/wcag-sensory-instructions.ts:120`
- **Issue:** `extractJsonFromLlm()` se castea directamente sin validación runtime. Si el LLM responde con shape inesperado, `.violations.filter()` crashea.
- **Fix:** Añadir type guard como `isLlmColorAnalysis()` en wcag-color-use.ts.

### MEDIUM-5: `require("pixelmatch")` en contexto ESM es frágil
- **Archivo:** `src/analyzer/wcag-color-use.ts:39`
- **Issue:** `require()` en módulo ESM/TS. Funciona en Bun pero es hazard de mantenimiento.
- **Fix:** Usar `await import("pixelmatch")` (requiere hacer `computePixelDiffPercent` async).

### MEDIUM-6: Pseudo-heading detection genera falsos positivos en fuentes base 18px+
- **Archivo:** `src/analyzer/wcag-semantic-structure.ts:65`
- **Issue:** `fontSize >= 18` flags cualquier `<div>/<p>/<span>` con texto >= 18px. Muchos sitios modernos usan 18-20px como font base.
- **Fix:** Comparar contra el font-size del parent: `fontSize >= parentFontSize * 1.3 && fontSize >= 16`.

### MEDIUM-7: Pseudo-list detection matchea card grids
- **Archivo:** `src/analyzer/wcag-semantic-structure.ts:87-125`
- **Issue:** Detecta como "pseudo-list" cualquier container con 3+ hijos uniformes. Matchea card grids, product listings — ruido.
- **Fix:** Subir threshold mínimo a 5+ items, o añadir heurísticas de contenido (links/images repetidos).

---

## MEDIUM — Data Quality

### MEDIUM-9: Axe best-practice rules sin wcagCriterion ni etiqueta
- **Archivo:** Pipeline de axe-core → DB (scan-light results)
- **Issue:** Reglas como `region` (27 issues) y `landmark-one-main` (1) de axe-core quedan con `wcagCriterion: null`. No se distingue entre "sin mapeo WCAG" y "es best-practice". Afecta al reporting: 28/50 issues (56%) sin criterio WCAG asignado en auditoría de example-client.com.
- **Fix:** Mapear `region` → 1.3.1, `landmark-one-main` → best-practice. Crear lookup table de axe rules → WCAG criterion, o extraerlo de `axe.result.tags` (axe incluye tags como `wcag2a`, `wcag131`, `best-practice`).

### MEDIUM-10: Axe issues pierden `message` en pipeline
- **Archivo:** Pipeline de axe-core → DB
- **Issue:** Issues de `scan-light` (axe) llegan con `message: null`. Axe provee `help` y `description` por regla + `message` por nodo. Se pierde información útil para el usuario final.
- **Fix:** Persistir `node.failureSummary` o `rule.help` como `message` del issue.

---

## MEDIUM — Observability

### MEDIUM-8: LLM usage tracker no distingue llamadas de visión vs texto
- **Archivo:** `src/llm/client.ts:17-23,118-121`
- **Issue:** `LLMUsageTracker` agrupa `chatVision()` y `chat()` bajo el mismo `enrichmentCalls`. No hay forma de saber cuántas llamadas fueron de visión ni estimar costes reales. Además, `prompt_tokens` de Moonshot puede no incluir tokens de imagen (base64), subestimando el coste real (estimado $0.15-0.25 vs $0.03-0.05 reportado para 33 páginas).
- **Fix:** Añadir `visionCalls: number` y `estimatedImageTokens: number` al tracker. En `chatVision()`, contar imágenes enviadas y estimar tokens de imagen (~1k tokens/imagen). Persistir en DB para reporting preciso.

---

## LOW — Improvements

### LOW-1: Selector builder duplicado en 7+ archivos
- **Archivos:** Todos los `wcag-*.ts` dentro de `page.evaluate()`
- **Issue:** El pattern `el.id ? '#'+id : tag+'.'+classes : tag` está copy-pasted. `buildCssSelector` de `utils.ts` no puede usarse en browser context.
- **Fix:** Aceptar la duplicación con comentario apuntando a la versión canónica, o crear un helper inyectable como string.

### LOW-2: `computeKendallTau` exportado pero duplicado en browser context
- **Archivo:** `src/analyzer/wcag-meaningful-sequence.ts:28-42`
- **Issue:** La función exportada solo se usa en tests. La versión de producción vive dentro de `page.evaluate()`.
- **Fix:** Documentar con JSDoc: `/** Exported for unit testing only */`.

### LOW-3: `isNativeTitle` siempre false en hover-focus
- **Archivo:** `src/analyzer/wcag-hover-focus.ts:52,64`
- **Issue:** El campo existe pero siempre es `false`. El check `if (trigger.isNativeTitle) continue` es dead code.
- **Fix:** Eliminar el campo y el check, o implementar detección real de `[title]` exempt.

### LOW-4: Consent banner selector duplicado entre utils.ts y consent-blocker.ts
- **Archivos:** `src/analyzer/utils.ts`, `src/analyzer/consent-blocker.ts`
- **Issue:** `CONSENT_BANNER_SELECTOR` en utils.ts es un subset manual de `CONSENT_PREHIDE_CSS` en consent-blocker.ts. Pueden divergir.
- **Fix:** Generar `CONSENT_BANNER_SELECTOR` programáticamente desde `CONSENT_PREHIDE_CSS`, o mantener una sola fuente.

---

## MEDIUM — Test Coverage Gaps (vs Auditoria manual de referencia manual audit 2026-01-30)

### MEDIUM-11: `status-messages` no detecta RM-11 (WCAG 4.1.3) en /contacto/
- **Referencia Auditoria manual de referencia:** RM-11 — formulario de contacto muestra mensajes confirmación/error sin `role="status"` o `aria-live`
- **Issue:** El test `wcag-status-messages.ts` no generó issues para `/contacto/`. Posible causa: el formulario requiere interacción más compleja (submit real) que el test no realiza, o el MutationObserver no captura el cambio.
- **Fix:** Investigar si el test ejecuta submit en `/contacto/`. Si no, ampliar la interacción (rellenar campos + submit) o verificar que el observer espera suficiente tiempo tras la acción.

### MEDIUM-12: `hover-focus` no detecta RM-15 (WCAG 1.4.13) en /equipo/
- **Referencia Auditoria manual de referencia:** RM-15 — tarjetas de personas en `/equipo/` muestran info en hover que no es persistente, hoverable ni descartable
- **Issue:** El test `wcag-hover-focus.ts` no generó issues pese a que Auditoria manual de referencia confirmó incumplimiento. Posible causa: las tarjetas usan CSS `:hover` puro sin JS, y el test puede no estar detectando contenido CSS-only que aparece/desaparece.
- **Fix:** Verificar que el test detecta `opacity`/`visibility`/`display` transitions activadas por `:hover` CSS (no solo JS hover handlers). Revisar si los triggers en `/equipo/` están siendo descubiertos.

### MEDIUM-13: `sensory-instructions` no detecta RM-13 (WCAG 1.3.3) en /formulario/
- **Referencia Auditoria manual de referencia:** RM-13 — formulario con instrucciones implícitas que dependen del contexto visual (obligatoriedad por estilo/color)
- **Issue:** `/formulario/` no aparece en las 33 URLs crawleadas. Puede ser una URL dinámica, protegida, o no enlazada desde la navegación principal.
- **Fix:** Verificar si `/formulario/` es accesible públicamente. Si es alcanzable pero no descubierta, investigar por qué el crawler no la encontró (posible JS-only navigation o enlace condicional).

---

## ~~HIGH — API Bug~~ DESCARTADO

### ~~HIGH-1: Endpoint `/issues` no devuelve issues de tests custom~~
- **Estado:** FALSO POSITIVO — descartado 2026-03-19
- **Causa real:** Paginación default `limit=50`. Los 2,487 issues (31 reglas, 5 sources) están correctamente en DB. El endpoint funciona bien con `?limit=200`.

---

## MEDIUM — Data Quality (actualizado)

### MEDIUM-9 (actualizado): 1,657 issues (66.6%) sin wcagCriterion
- **Prioridad actualizada:** MEDIUM → **HIGH** — afecta a 2/3 de todos los issues, no solo `region`
- **Archivo:** Pipeline de issues → DB (`wcag_tags` vacío para reglas custom e interactive)
- **Issue:** 1,657 de 2,487 issues no tienen WCAG criterion. Afecta a reglas de todas las fuentes: `region` (scan-light), `focus-indicator-missing` (interactive), `color-use-link-color-only` (wcag-custom), `skip-nav-missing`, `keyboard-trap`, `target-size`, etc.
- **Fix:** Crear lookup table rule → WCAG criterion para todas las reglas custom e interactive. Para axe-core, extraer de `axe.result.tags`. Persistir en `wcag_tags` al insertar.

---

## Fecha: 2026-03-19
## Source: Code review v4.3/v4.4 + comparativa Auditoria manual de referencia audit (verificado con audit bdb0087b)
