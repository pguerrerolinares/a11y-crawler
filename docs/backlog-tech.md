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
- **Issue:** Reglas como `region` (27 issues) y `landmark-one-main` (1) de axe-core quedan con `wcagCriterion: null`. No se distingue entre "sin mapeo WCAG" y "es best-practice". Afecta al reporting: 28/50 issues (56%) sin criterio WCAG asignado en auditoría de kutxabankinvestment.es.
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

## MEDIUM — Test Coverage Gaps (vs Aiblu manual audit 2026-01-30)

### MEDIUM-11: `status-messages` no detecta RM-11 (WCAG 4.1.3) en /contacto/
- **Referencia Aiblu:** RM-11 — formulario de contacto muestra mensajes confirmación/error sin `role="status"` o `aria-live`
- **Issue:** El test `wcag-status-messages.ts` no generó issues para `/contacto/`. Posible causa: el formulario requiere interacción más compleja (submit real) que el test no realiza, o el MutationObserver no captura el cambio.
- **Fix:** Investigar si el test ejecuta submit en `/contacto/`. Si no, ampliar la interacción (rellenar campos + submit) o verificar que el observer espera suficiente tiempo tras la acción.

### MEDIUM-12: `hover-focus` no detecta RM-15 (WCAG 1.4.13) en /equipo/
- **Referencia Aiblu:** RM-15 — tarjetas de personas en `/equipo/` muestran info en hover que no es persistente, hoverable ni descartable
- **Issue:** El test `wcag-hover-focus.ts` no generó issues pese a que Aiblu confirmó incumplimiento. Posible causa: las tarjetas usan CSS `:hover` puro sin JS, y el test puede no estar detectando contenido CSS-only que aparece/desaparece.
- **Fix:** Verificar que el test detecta `opacity`/`visibility`/`display` transitions activadas por `:hover` CSS (no solo JS hover handlers). Revisar si los triggers en `/equipo/` están siendo descubiertos.

### MEDIUM-13: `sensory-instructions` no detecta RM-13 (WCAG 1.3.3) en /formulario/
- **Referencia Aiblu:** RM-13 — formulario con instrucciones implícitas que dependen del contexto visual (obligatoriedad por estilo/color)
- **Issue:** `/formulario/` no aparece en las 33 URLs crawleadas. Puede ser una URL dinámica, protegida, o no enlazada desde la navegación principal.
- **Fix:** Verificar si `/formulario/` es accesible públicamente. Si es alcanzable pero no descubierta, investigar por qué el crawler no la encontró (posible JS-only navigation o enlace condicional).

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
- **Fix aplicado:** `waitForTimeout` reemplazado por `dispatchEvent` + `disableAnimations` en Tier 2 (`src/worker/unified-interaction.ts`). El adaptive wait (`adaptiveWait`) usa `waitForFunction` con ceiling en vez de fixed sleep. Resultado: 702 interacciones en 52s en audit de kutxabankinvestment.es (vs ~640s estimados antes).

### HIGH-4: Sistema de monitorización automática de auditorías (visualización CI-style)
- **Contexto:** La monitorización del progreso de auditorías se hace manualmente via curl + polling de API.
- **Propuesta:** Sistema automatizado que tracka el progreso en tiempo real, capturando timing tier-a-tier, conteo de issues y transiciones de fase.
- **Visualización frontend:** Grafo de pipeline estilo GitHub CI mostrando `DISCOVER → SCAN → CLASSIFY → PROBE (Tier0→1→2→3)` con timing por fase, estado verde/rojo y progreso en vivo.
- **API disponible:** `GET /api/audits/:id/performance` provee todos los datos de tier necesarios.
- **SSE:** Reutilizar eventos SSE para actualizaciones en tiempo real.

### HIGH-5: Tier 1 CSSOM no resuelve ningún elemento (skippedByFingerprint=0)
- **Observado:** En audit v5 de kutxabankinvestment.es: Tier 1 promovió TODOS los 351 elementos a Tier 2, resolvió 0, saltó 0.
- **Causa probable:** Todo el CSS es cross-origin (CDN), el análisis CSSOM hover devuelve null para todo.
- **Impacto:** Tier 1 añade ~1s de overhead sin beneficio en este tipo de sitio.
- **Fix options:** (a) detectar cross-origin temprano y saltar análisis CSSOM; (b) añadir más heurísticas Tier 1 que no dependan de CSSOM (ej. atributos `data-*`, clases con patrones hover conocidos).

### MEDIUM-14: Tests interactivos podrían fusionar pasadas por elemento
- **Archivos:** `src/analyzer/wcag-state-change-contrast.ts`, `src/analyzer/wcag-hover-focus.ts`
- **Issue:** `state-change-contrast` y `hover-focus` ambos hacen hover → read styles → reset → focus → read styles. Se ejecutan secuencialmente haciendo la misma interacción 2 veces por elemento.
- **Fix:** Fusionar en una sola pasada: hover → read (ambos tests) → focus → read (ambos tests). Requiere refactor del interfaz pero ahorraría ~50% del tiempo de ambos tests.

### MEDIUM-15: Screenshots LLM vision enviadas sin crop — coste y tokens innecesarios
- **Archivo:** `src/analyzer/wcag-color-use.ts:130-200`
- **Issue:** Tier 2 captura screenshot del viewport completo (1280×720+) y Tier 3 envía 2 imágenes resize a 800px al LLM. Pero si Tier 1 (DOM heuristics) ya identificó elementos concretos (links sin underline, status indicators), el LLM solo necesita ver la región relevante, no la página entera.
- **Fix:** Después de Tier 1, hacer crop del bounding box de los elementos sospechosos (+padding de contexto ~50px). Enviar al LLM solo los crops (~200-400px) en vez del viewport completo (800px). Reduce tokens de imagen de ~1000+ a ~200-400 por imagen. Ahorro estimado: 50-70% del coste de visión.

### MEDIUM-16: Screenshots de evidencia se guardan para todas las deficiencias
- **Archivo:** `src/analyzer/wcag-color-use.ts:267-274`
- **Issue:** Se guardan screenshots normal+CVD para CADA deficiency (deuteranopia, achromatopsia) independientemente del `diffPercent`. Para deficiencies con diff < 0.5% (sin issues), los screenshots ocupan espacio sin aportar evidencia.
- **Fix:** Solo guardar screenshots de evidencia cuando `diffPercent > threshold` (0.5%). Reduce almacenamiento y I/O en auditorías sin problemas de color.

### MEDIUM-17: Tier 3 LLM podría recibir contexto textual + crop en vez de página completa
- **Archivo:** `src/analyzer/wcag-color-use.ts:186-226`
- **Issue:** El LLM recibe 2 screenshots completas (800px) y debe descubrir qué zonas comparar. Si pixelmatch ya calculó las regiones de diferencia, se podría enviar: (a) crop de la zona con mayor diff, (b) descripción textual de qué elementos están en esa zona (de Tier 1). Reduce tokens y mejora accuracy del LLM al focalizarlo.
- **Fix:** Usar pixelmatch para localizar bounding box del diff, crop ambas imágenes a esa región (+padding), y añadir al prompt qué elementos de Tier 1 están en esa zona.

### LOW-5: Template dedup no reduce ejecuciones de tests CSS-only
- **Archivo:** `src/worker/probe.ts`
- **Issue:** Tests como `state-change-contrast` que evalúan CSS (no contenido) se ejecutan en 32 URLs representativas, pero muchas comparten template CSS. Bastaría con 1 URL por template (25 en vez de 32) para tests que no dependen del contenido.
- **Fix:** Marcar tests como `content-dependent` vs `style-dependent`. Para `style-dependent`, ejecutar solo en 1 URL por template. Requiere clasificación de tests.

---

## Fecha: 2026-03-19
## Source: Code review v4.3/v4.4 + comparativa Aiblu audit (verificado con audit bdb0087b)
