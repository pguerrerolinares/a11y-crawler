# eval/ — harness de evaluación del crawler

Mide la calidad del crawler contra **ground-truth verificado** (auditoría humana + verificación
en DOM real), no contra sí mismo. Convierte "creo que mejoré" en "subí el recall de X% a Y% sin
romper nada".

## Correr

```bash
# el crawler (server+worker) y el sitio deben estar levantados
bun run eval/run-eval.ts --oracle <sitio> --label baseline
# tras aplicar una mejora:
bun run eval/run-eval.ts --oracle <sitio> --label "W3-label-mismatch"
```

Salida: matriz por criterio + **recall automatizable** + especificidad + **delta vs la corrida
anterior** (qué FN se resolvieron, qué regresó). Cada corrida guarda snapshot en `private/eval/results/`.

Flags: `--base` (URL del sitio, override del oracle) · `--api` (URL del crawler, def `:3000`).

## La métrica

- **Recall automatizable** = de las violaciones reales que un motor *puede* detectar, cuántas
  detecta el crawler. Es la métrica honesta: excluye lo que el sitio ya cumple y lo no-automatizable.
- **Especificidad** = cuando el sitio cumple un criterio, ¿el crawler se calla? (no mete FP).
- No-automatizables (juicio humano) quedan **fuera** de la métrica — vender "100% WCAG automático"
  es overclaim; marcar la frontera es un feature.

## El oracle

`private/eval/oracles/<sitio>.json` (gitignored; override con `$A11Y_EVAL_DIR`) codifica el ground-truth — son datos de cliente, nunca al repo. Por criterio: `verdict` (VIOLATES/PASSES),
`automatable`, `pages`, `evidence`, `needsState` (violación solo visible tras interacción).
`auditRoutes` = rutas que el runner crawlea.

## Añadir un sitio (evita overfitting)

Un oracle de 1 sitio mide poco. Para que las mejoras generalicen, añade oráculos de otros sitios
con ground-truth (otra auditoría profesional, o axe-devtools manual). Copia un oracle existente,
cambia `baseUrl`/`auditRoutes`/`entries`. El runner es agnóstico al sitio.
