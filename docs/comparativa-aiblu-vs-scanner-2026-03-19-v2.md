# Comparativa v2: Aiblu (manual) vs a11y-crawler-v2 (automatizado)

> Fecha: 2026-03-19
> Sitio: kutxabankinvestment.es
> Informe Aiblu: 30 enero 2026 (6 páginas, revisión manual + automática)
> Audit scanner: 19 marzo 2026 (audit `bdb0087b`, 33 páginas, pipeline v4.1)
> Comparativa anterior: `comparativa-aiblu-vs-scanner-2026-03-19.md` (audit `289c61ee`, 30 páginas)

---

## Datos generales

| Métrica | Aiblu (manual) | Scanner (anterior) | Scanner (actual) |
|---|---|---|---|
| Páginas analizadas | 6 | 30 | **33** |
| Hallazgos reportados | 27 | 2,251 | **2,487** |
| Reglas con issues | — | 28 | **31** |
| Issues por fuente | — | — | axe: 689, wcag-custom: 682, scan-light: 672, interactive: 443, llm-vision: 1 |
| Duración | Semanas | 931s (15 min) | **1,734s (29 min)** |
| LLM calls | — | 26 | **26** |
| LLM tokens (input) | — | 56K | **56K** |
| Coste estimado | Miles de euros | ~$0.05 (subestimado) | **~$0.15-0.25** |
| Pipeline | — | v4.1 | v4.1 |

### Nota sobre coste

El coste anterior (~$0.05) subestimaba las llamadas de visión. El tracker LLM no distingue `chat()` de `chatVision()` y Moonshot puede no reportar tokens de imagen en `prompt_tokens`. Coste real estimado: $0.15-0.25 (ver backlog MEDIUM-8).

---

## Evolución entre auditorías del scanner

| Métrica | Anterior (289c61ee) | Actual (bdb0087b) | Delta |
|---------|---------------------|-------------------|-------|
| Páginas | 30 | 33 | +3 |
| Duración | 931s | 1,734s | +86% |
| Issues totales | 2,251 | 2,487 | +10.5% |
| Reglas detectadas | 28 | 31 | +3 |
| Gaps vs Aiblu | 3 (2 parciales + 1 no cubierto) | 3 nuevos | diferentes |

**3 tests nuevos** desde la auditoría anterior: `skip-nav-missing`, `state-change-contrast`, `accessibility-declaration-missing` — cerraron los 3 gaps identificados en la comparativa v1.

**Duración +86%**: los tests nuevos (especialmente `state-change-contrast` con screenshots por estado) explican el aumento.

**Issues +10.5%**: 3 páginas extra + 3 reglas nuevas generan ~236 issues adicionales. Los 2,487 issues se desglosan en: scan-light 672, axe 689, wcag-custom 682, interactive 443, llm-vision 1.

---

## Comparativa hallazgo por hallazgo

### Revisión Automática Aiblu

| # | ID | WCAG | Criterio | Scanner detecta? | Reglas scanner | Notas |
|---|---|---|---|---|---|---|
| 1 | RA-1 | 4.1.2 | Botones sin nombre (header) | **SI** | `button-name` (4 issues) | Hamburguesa, contraste, idioma |
| 2 | RA-2 | 3.1.1 | `<html>` sin `lang` | **SI** | `html-has-lang` (3 issues) | Todas las páginas |
| 3 | RA-3 | 1.4.3 | Contraste mínimo (#e88d83) | **SI** | `color-contrast` (2 issues) | Transversal |
| 4 | RA-4 | 1.1.1 | Imágenes sin `alt` | **SI** | `image-alt` (4 issues) | Selectores exactos |
| 5 | RA-5 | 1.3.1 | Formularios sin label/required | **SI** | `label` (8), `select-name` (1) | En /contacto/ |

**Resultado revisión automática: 5/5 (100%)**

---

### Revisión Manual Aiblu

| # | ID | WCAG | Criterio | Scanner detecta? | Reglas scanner | Notas |
|---|---|---|---|---|---|---|
| 6 | RM-1 | 2.1.1 | Navegación por teclado | **SI** | `keyboard-trap`, `tabindex` | En detectedRules |
| 7 | RM-2 | 2.4.7 | Enfoque visible | **SI** | `focus-not-visible`, `focus-indicator-missing` | En detectedRules |
| 8 | RM-3 | 2.4.3 | Orden del foco | **SI** | `tabindex-positive`, `meaningful-sequence` | En detectedRules |
| 9 | RM-4 | 1.3.1+2.4.1 | Roles emblemáticos | **SI** | `region` (27), `landmark-one-main` (1) | Problema dominante |
| 10 | RM-5 | 2.4.1 | Skip navigation | **SI** | `skip-nav-missing` | **Nuevo** — era GAP 1 en v1 |
| 11 | RM-6 | 4.1.2 | Widgets nativos (formulario) | **SI** | `label`, `button-name`, `select-name` | |
| 12 | RM-7 | 1.3.1 | Estructura semántica | **SI** | `semantic-pseudo-heading`, `semantic-pseudo-list`, `semantic-missing-fieldset` | En detectedRules |
| 13 | RM-8 | 4.1.2 | Menús/controles dinámicos | **PARCIAL** | `button-name`, `link-name` | `aria-states` no en detectedRules — no verificó aria-expanded en submenús |
| 14 | RM-9 | 1.3.1+4.1.2 | Señales de estado | **SI** | `state-change-contrast` | **Nuevo** — era GAP 2 en v1 |
| 15 | RM-10 | 2.1.1 | Submenús por teclado | **PARCIAL** | `keyboard-trap` | Detecta traps pero no operabilidad completa de submenús |
| 16 | RM-11 | 4.1.3 | Mensajes de estado | **NO DETECTADO** | — | Test `status-messages` no generó issues. Backlog MEDIUM-11 |
| 17 | RM-12 | 1.4.1 | Color como significado | **SI** | `color-use-cvd`, `color-use-link-color-only`, `color-use-llm` | 3-tier con CVD + LLM vision |
| 18 | RM-13 | 1.3.3 | Instrucciones sensoriales | **NO DETECTADO** | — | `/formulario/` no crawleada. Backlog MEDIUM-13 |
| 19 | RM-14 | 1.4.10 | Reflujo | **SI** | `reflow` | En detectedRules |
| 20 | RM-15 | 1.4.13 | Hover/focus content | **NO DETECTADO** | — | Test `hover-focus` no generó issues pese a incumplimiento confirmado por Aiblu. Backlog MEDIUM-12 |
| 21 | RM-16 | 1.3.2 | Secuencia significativa | **SI** | `meaningful-sequence`, `meaningful-sequence-reorder` | Kendall tau DOM vs visual |
| 22 | RM-17 | 1.3.1+1.3.2 | Columnas multicolumn | **SI** | `meaningful-sequence` | Cubierto por Kendall tau |
| 23 | RM-18 | 2.5.8 | Tamaño objetivo | **SI** | `target-size` | En detectedRules |
| 24 | RM-19 | 1.4.11 | Contraste UI componentes | **SI** | `non-text-contrast` | En detectedRules |
| 25 | RM-20 | 1.4.11 | Contraste cambios estado | **SI** | `state-change-contrast` | **Nuevo** — era GAP 2 en v1 |
| 26 | RM-21 | 1.4.11 | Contraste gráficos | **SI** | `non-text-contrast` | En detectedRules |
| 27 | RM-22 | Ley 11/2023 | Declaración accesibilidad | **SI** | `accessibility-declaration-missing` | **Nuevo** — era GAP 3 en v1 |

---

## Resumen de cobertura

| Categoría | Total Aiblu | Completo | Parcial | No detectado |
|---|---|---|---|---|
| Revisión automática | 5 | **5** | 0 | 0 |
| Revisión manual | 22 | **15** | **2** | **3** (-2 no son gaps del test sino del site/crawler) |
| **Total** | **27** | **20** | **2** | **3** |

### Cobertura: 20/27 completos + 2 parciales = **81.5%** (74.1% estricto)

### vs comparativa anterior: 23/27 + 2 parciales = 92.6% (85.2% estricto)

**La cobertura baja porque la comparativa anterior era teórica** — asumía que los tests detectarían issues sin verificar contra resultados reales. Esta comparativa se basa en `detectedRules` de la auditoría real.

---

## Gaps resueltos desde comparativa v1

| Gap v1 | WCAG | Solución | Regla nueva |
|---------|------|----------|-------------|
| GAP 1: Skip Navigation | 2.4.1 | Test DOM heurístico | `skip-nav-missing` |
| GAP 2: Contraste cambios estado | 1.4.11 | Screenshots por estado | `state-change-contrast` |
| GAP 3: Declaración accesibilidad | Ley 11/2023 | Check legal DOM | `accessibility-declaration-missing` |

---

## Nuevos gaps (verificados contra resultados reales)

### GAP 1: WCAG 4.1.3 — Mensajes de estado (RM-11)

**Estado:** NO DETECTADO
**Aiblu:** Formulario de /contacto/ muestra mensajes sin `role="status"` o `aria-live`
**Scanner:** Test `status-messages` no generó issues. Causa probable: el formulario requiere submit real con campos válidos; el test puede no completar la interacción.
**Backlog:** MEDIUM-11

### GAP 2: WCAG 1.4.13 — Contenido en hover/focus (RM-15)

**Estado:** NO DETECTADO
**Aiblu:** Tarjetas de personas en /equipo/ con hover no persistente/hoverable/descartable
**Scanner:** Test `hover-focus` no generó issues. Causa probable: CSS `:hover` puro sin JS, el test no detecta transitions CSS-only.
**Backlog:** MEDIUM-12

### GAP 3: WCAG 1.3.3 — Instrucciones sensoriales (RM-13)

**Estado:** NO DETECTADO
**Aiblu:** Formulario en /formulario/ con instrucciones visuales implícitas
**Scanner:** URL `/formulario/` no fue descubierta en las 33 URLs crawleadas. Posible URL dinámica o no enlazada.
**Backlog:** MEDIUM-13

### GAP 4 (parcial): WCAG 4.1.2 — Menús dinámicos (RM-8)

**Estado:** PARCIAL
**Scanner:** Detecta `button-name` y `link-name` pero `aria-states` no aparece en detectedRules — no verificó `aria-expanded` en submenús de navegación.

### GAP 5 (parcial): WCAG 2.1.1 — Submenús por teclado (RM-10)

**Estado:** PARCIAL
**Scanner:** `keyboard-trap` detecta trampas de teclado pero no verifica operabilidad completa de submenús con Enter/Espacio.

---

## ~~Bug crítico detectado: API `/issues` incompleta~~ DESCARTADO

~~**Backlog HIGH-1**~~ — **FALSO POSITIVO**. El endpoint funciona correctamente. Los 2,487 issues (31 reglas, 5 sources) están en DB. El error fue consultar con el limit default (50), que solo devolvía los primeros issues (todos `scan-light` por orden de creación). Con `?limit=200` se paginan correctamente todas las fuentes.

---

## Lo que el scanner detecta y Aiblu NO

| Regla scanner | WCAG | Descripción |
|---|---|---|
| `resize-text` | 1.4.4 | Texto redimensionable hasta 200% |
| `text-spacing` | 1.4.12 | Espaciado de texto configurable |
| `empty-heading` | 1.3.1 | Headings vacíos |
| `heading-order` | 1.3.1 | Jerarquía de headings incorrecta |
| `link-name` | 4.1.2 | Enlaces sin nombre accesible |
| `color-use-cvd` | 1.4.1 | Simulación daltonismo con screenshots CDP |
| `color-use-llm` | 1.4.1 | Confirmación LLM vision de problemas de color |
| `meaningful-sequence-reorder` | 1.3.2 | Kendall tau cuantifica reordenamiento CSS |
| `state-change-contrast` | 1.4.11 | Contraste en estados dinámicos (hover/focus/active) |
| `skip-nav-missing` | 2.4.1 | Ausencia de enlace "Saltar al contenido" |
| `accessibility-declaration-missing` | Ley 11/2023 | Ausencia de declaración de accesibilidad |

---

## Conclusión

### Cobertura real verificada: 81.5% (74.1% estricto)

Menor que la comparativa v1 (92.6%) porque se basa en resultados reales, no en capacidades teóricas de los tests.

### 3 gaps anteriores resueltos
Los tests `skip-nav-missing`, `state-change-contrast` y `accessibility-declaration-missing` cerraron los 3 gaps de la comparativa v1.

### 3 nuevos gaps + 2 parciales identificados
Todos documentados en backlog (MEDIUM-11, 12, 13) + 1 bug crítico (HIGH-1).

### Ventajas del scanner
- **5.5x más páginas** (33 vs 6)
- **~92x más issues** individuales localizados (2,487 vs 27 genéricos)
- **11 reglas extra** que Aiblu no evaluó
- **72.3% de issues de tests propios** (wcag-custom + interactive + llm-vision), no solo axe-core
- **Coste ~$0.20** vs miles de euros
- **29 minutos** vs semanas
- **Repetible** en cada deploy
- **Evidencia cuantitativa** (selectores CSS, screenshots, Kendall tau, LLM confidence)

### Dato calidad: 66.6% de issues sin WCAG criterion
1,657 de 2,487 issues no tienen `wcagCriterion` mapeado. Priorizado como backlog MEDIUM-9 (elevado a HIGH). Afecta al valor del reporte para el usuario final.

---

## V5 Update (2026-03-19)

Pipeline v5.0 desplegado con sistema de Intelligent Probe por tiers:
- **33 páginas en 261s (4.35 min)** vs 1,734s (29 min) en v4.5 — **85% más rápido**
- **2,815 issues** vs 2,487 — **+13% más detección**
- **33 reglas** vs 31 — **+2 reglas nuevas**
- **Coste LLM idéntico** (~$0.50) — optimizaciones Tier 3 (crop, batch, cache) aún no activadas
- Performance endpoint: `GET /api/audits/:id/performance` con desglose completo por tier
- Tier 2 unified interaction pass: 702 interacciones en 52s (vs ~640s antes del fix)
