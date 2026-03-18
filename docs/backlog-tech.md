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

## Fecha: 2026-03-18
## Source: Code review v4.3/v4.4
