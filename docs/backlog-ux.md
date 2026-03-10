# UX Backlog

Items identificados en el análisis UX de 2026-03-09 que requieren trabajo adicional (backend, diseño o decisión pendiente).

---

## Necesita backend

### WCAG Score
- **Diseño:** Mostrar puntuación 0-100 en los resultados del scan (ej: "42/100")
- **Estado:** No existe el dato en la API actual
- **Referencia:** Sección `mkuWf` en `design.pen` — Accessibility Analyzer

### Export PDF / CSV del report
- **Diseño:** Botones "Download PDF Report" y "Export CSV" al final de los resultados
- **Estado:** Endpoint de export no implementado
- **Referencia:** Sección `XoeZd` en `design.pen` — Accessibility Analyzer

### Tiempo total del scan
- **Diseño:** Mostrar duración total del scan en el report (ej: "2m 34s")
- **Estado:** El dato existe parcialmente en ProgressView (elapsed), pero no se guarda en el audit al completarse
- **Referencia:** Sección `XoeZd` en `design.pen`

### Error detail en scans fallidos
- **Descripción:** Los scans con status `failed` deberían mostrar el motivo del fallo y el progreso hasta el punto de error
- **Estado:** La API devuelve `audit.error` pero es genérico; necesita más detalle del crawler
- **Referencia:** Issue #11 del análisis UX

---

## Necesita decisión / diseño

### Icono dark mode
- **Descripción:** El icono Sun de Lucide a 16px puede parecer un copo de nieve. Evaluar si cambiar a `SunMedium`, aumentar tamaño a `h-5 w-5`, o usar un par de iconos más reconocibles.
- **Archivo:** `frontend/src/components/dark-mode-toggle.tsx`
- **Referencia:** Issue #2 del análisis UX

### Agrupación de issues por regla en IssueTable
- **Descripción:** La tabla muestra filas individuales por issue (ej: 9 filas idénticas de `color-contrast`). Agrupar por regla con contador y expandir mejoraría mucho la legibilidad.
- **Impacto:** Alto — dificulta escanear los resultados
- **Archivo:** `frontend/src/components/issue-table.tsx`
- **Referencia:** Issue #19 del análisis UX

### Fix suggestions para público no técnico
- **Descripción:** El HTML raw en las sugerencias de fix es útil para developers pero opaco para gestores/clientes. Evaluar si existe o se puede generar una descripción en lenguaje natural.
- **Estado:** Depende de si el LLM genera descripciones no técnicas en el backend
- **Referencia:** Issue #22 del análisis UX

### Botón "Report" en scans fallidos (Reports)
- **Descripción:** Las filas con status `failed` en la tabla de Reports muestran un botón "Report" que lleva a una vista vacía. Debería deshabilitarse o cambiar a "View Error".
- **Archivo:** `frontend/src/pages/reports.tsx`
- **Referencia:** Issue #11 del análisis UX

### Tab "Summary" en AuditDetail
- **Descripción:** El tab Summary muestra un JSON raw del audit (summary + discovery + llmUsage). Evaluar si presentarlo de forma más legible o eliminarlo de la vista pública.
- **Archivo:** `frontend/src/pages/audit-detail.tsx:173-181`
- **Referencia:** Issue #23 del análisis UX

---

## Necesita refactor técnico

### Worker: race condition en reconexión a Browserless
- **Descripción:** Si Browserless se desconecta durante un audit, el worker reasigna `browser` en el handler `disconnected`, pero `runAudit()` mantiene la referencia al browser muerto. El audit en curso fallará y el nuevo browser solo se usará en el siguiente audit.
- **Impacto:** Bajo — el audit en curso falla y se marca como `failed`, el siguiente funciona normal. Solo afecta si Browserless se reinicia durante un audit activo.
- **Solución propuesta:** Usar un getter/wrapper pattern (`getBrowser()`) en lugar de pasar la referencia directa, o añadir un mutex que impida reclamar audits durante la reconexión.
- **Archivo:** `src/worker/index.ts:39-49`
- **Referencia:** Code review v3 architecture — HIGH severity

---

## Mejoras menores pendientes

| Item | Archivo | Nota |
|------|---------|------|
| Avatar "A" en header sin funcionalidad | `layout.tsx` | Decide si añadir dropdown de usuario o eliminar el elemento |
| Campana de notificaciones sin estado | `layout.tsx` | Añadir badge de count cuando haya notificaciones |
| Botón "New Audit" en Reports abre dialog con más opciones | `reports.tsx` | Confirmar si AuditFormDialog tiene campos extra respecto al scan rápido del dashboard; si no, unificar |
