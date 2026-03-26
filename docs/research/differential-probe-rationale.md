# Differential Probe: Origen, Razonamiento y Novedad

> Date: 2026-03-26
> Context: Documento de investigación que explica por qué el Differential Probe es un avance significativo en accessibility testing automatizado.

---

## 1. El Problema de Partida

Los accessibility crawlers actuales (axe-core, Pa11y, Lighthouse, WAVE) tratan cada auditoría como un trabajo desde cero. Cada vez que escaneas un sitio:

- Abres un browser
- Navegas a cada página
- Ejecutas los mismos tests
- Generas los mismos resultados para las mismas páginas

No importa si auditaste el mismo sitio ayer y solo cambió una página de 33 — vuelves a hacer todo el trabajo. Es como si `git` hiciera un full diff de todo el repositorio en cada commit en vez de comparar solo lo que cambió.

Nuestro crawler (a11y-crawler-v2) ya había optimizado esto parcialmente con **template clustering** (auditar un representativo por grupo de páginas similares) y **caches por CSS fingerprint** (reutilizar resultados de viewport y CVD entre templates con mismo CSS). Pero el principio estaba aplicado de forma ad-hoc, sin una estructura unificadora.

La pregunta era: **¿se puede generalizar este patrón a todo el pipeline?**

---

## 2. Lo que Encontramos en la Literatura

### Sprinter (Princeton University, NSDI 2024)

Paper: *"Speeding Up High-Fidelity Crawling of the Modern Web"*
https://www.usenix.org/system/files/nsdi24-goel.pdf

Sprinter resuelve un problema análogo al nuestro pero en el dominio del crawling: cómo obtener la fidelidad de un browser real (ejecución de JavaScript, renderizado, layouts) sin pagar el coste computacional de ejecutar un browser para cada página.

Su insight clave: **compute memoization**. Las páginas de un mismo sitio comparten la mayoría de su JavaScript, CSS y lógica de layout. Si ejecutas JS en una página con un browser real, puedes **reusar esas computaciones** en páginas similares sin browser.

Sprinter crawlea en 4 fases:
1. Crawl estático de todas las páginas (sin browser)
2. Browser real solo en un subset representativo (set cover de JS bundles)
3. Crawl estático del resto, reusando computaciones del paso 2
4. Browser solo para las páginas donde el reuse falló

Resultado: **5x más rápido**, misma fidelidad.

### STILE (Journal of Systems & Software, 2024)

Paper: *"A tool for optimizing E2E web test scripts parallelization"*

STILE ataca la paralelización de tests E2E respetando dependencias entre tests. Su insight: no paralelices todo a ciegas — identifica qué tests son independientes, cuáles dependen de otros, y genera schedules óptimos.

Resultado: **-80% tiempo** vs ejecución secuencial.

### La conexión con nuestro trabajo

Cuando mapeamos estos papers contra nuestra arquitectura, descubrimos que **ya estábamos haciendo lo que Sprinter propone** — pero sin saberlo y de forma incompleta:

| Concepto de Sprinter | Nuestro equivalente |
|---|---|
| Set cover (subset representativo) | Template clustering + representativo por grupo |
| Compute memoization (reusar JS execution) | cvdCache, viewportCache (reusar por CSS fingerprint) |
| 4 fases alternando browser/static | 4-tier system (Manifest → CSSOM → Interaction → Vision) |
| Shadow DOM (ejecutar sin browser real) | Tier 1 CSSOM analysis (resolver sin hover real) |

Lo que nos faltaba era:
1. **Generalizar** el patrón de memoization a TODAS las fases (no solo P3/P4)
2. **Persistir** los resultados entre auditorías (cross-audit, no solo intra-audit)
3. **Estructura jerárquica** para saber exactamente qué cambió a qué nivel

---

## 3. El Concepto: "No Re-Computes Lo Que No Ha Cambiado"

El Differential Probe unifica todo bajo un principio: la misma idea que hace que git sea rápido (comparar hashes, procesar solo deltas) aplicada a accessibility testing.

### Hash Tree Jerárquico

Organizamos toda la información de una auditoría en un Merkle tree:

```
                    templateHash
                   /      |      \
          manifestHash  cssHash  domHash
             /    \
      elemHash1  elemHash2  elemHash3
```

Cada nivel tiene un hash determinístico:

- **templateHash**: identifica unívocamente un template (estructura + estilo + elementos)
- **manifestHash**: los elementos interactivos de la página
- **cssHash**: las hojas de estilo (ya existía como `computeCssFingerprint`)
- **domHash**: la estructura del DOM (headings, landmarks, formularios)
- **elementHash**: un elemento individual (tag + role + ARIA + estilo)

### Tres niveles de dedup

| Nivel | Pregunta | Acción |
|-------|----------|--------|
| **Cross-element** | ¿Este botón es igual a otro que ya testeé? | Skip hover+focus de ese elemento |
| **Cross-page** | ¿Este template tiene el mismo CSS que otro? | Skip viewport tests + screenshots |
| **Cross-audit** | ¿Esta página cambió desde la última auditoría? | Skip el template entero |

---

## 4. Por Qué Es Novedoso

### En el dominio de accessibility testing

Ninguna herramienta de accessibility testing hace differential auditing:

- **axe-core**: ejecuta reglas sobre el DOM actual. Sin cache, sin comparación.
- **Pa11y-CI**: corre tests secuencialmente. Recomiendan `concurrency: 1` en entornos limitados.
- **Lighthouse**: full audit cada vez, sin noción de "qué cambió".
- **WAVE**: evaluación puntual sin persistencia.

Nuestro approach es el primero que aplica compute memoization (Sprinter) al testing de accesibilidad interactivo.

### En el dominio de web crawling

Sprinter aplica memoization a **resource fetching** (qué URLs descargar). Nosotros lo aplicamos a **accessibility testing** (qué elementos interactuar). La diferencia es fundamental:

- Sprinter memoiza ejecución de JavaScript (determinístico dado el mismo input)
- Nosotros memoizamos resultados de interacción (hover, focus, click, keyboard) que son observaciones sobre comportamiento visual

El level de element-level dedup (mismos botones con diferente texto pero mismo estilo producen las mismas issues de accessibility) no tiene equivalente en la literatura.

### En el dominio de testing

STILE paraleliza tests respetando dependencias, pero asume que todos los tests son necesarios. Nuestro approach va un paso más allá: **elimina tests innecesarios** cuando la información necesaria ya se computó para un elemento/página/auditoría anterior.

Es la diferencia entre "hacer lo mismo más rápido" (STILE) y "hacer menos trabajo" (Differential Probe).

---

## 5. Cómo Se Integra en el Proyecto

### Arquitectura existente que lo habilita

El diseño del probe en v5 (tier system) ya preparaba el terreno sin saberlo:

1. **Tier 0 (Manifest)**: recolecta metadatos de cada elemento → la base para `elementHash` y `manifestHash`
2. **Tier 1 (CSSOM)**: análisis estático de hojas de estilo → natural cachear por `cssHash`
3. **Tier 2 (Interaction)**: hover + focus + click + keyboard → separable en cacheable (hover+focus) y no-cacheable (click+keyboard)
4. **Tier 3 (LLM Vision)**: ya tiene `tier3_cache` en DB → el único que ya hacía cross-audit memoization

Los caches existentes (`viewportCache`, `cvdCache`, `axeCache`) demuestran que el patrón funciona. El Differential Probe simplemente lo completa y lo estructura.

### Implementación en 3 fases

**Phase 1 — Extended Memoization (intra-audit)**
Añadir caches para las fases que faltan: P1 evaluate tests (por `domHash`), P1 Tier 1 (por `cssHash`), P2 hover+focus (por `elementHash`), P4 color-use (por fingerprint extendido). Sin cambios arquitectónicos — mismo patrón Map<string, Result> que ya funciona.

**Phase 2 — Batch Parallel**
Reorganizar el probe loop para procesar 2 páginas en paralelo durante las fases read-only (P1+P2), mientras las fases mutantes (P3+P4) siguen secuenciales. Lease-based ProbeContextManager con RAM guard para degradar gracefully.

**Phase 3 — Cross-audit Differential**
Persistir el hash tree en PostgreSQL (`probe_cache` table). Cache inmutable por auditoría — solo se leen resultados de auditorías completadas exitosamente. Dependency matrix per-test determina qué re-ejecutar cuando solo parte del hash tree cambia.

### Impacto esperado

| Métrica | v7.3 (actual) | Phase 1 | Phase 2 | Phase 3 (recurrente) |
|---------|--------------|---------|---------|---------------------|
| Duración (33 páginas) | 68s | ~55-60s | ~52-55s | ~25-35s |
| Interactions P2 | 702 | ~250 h+f únicas | ~250 | ~50 (delta) |
| Screenshots P4 | 12 | ~8 | ~8 | ~2-3 (delta) |

---

## 6. Potencial Más Allá de A11y

El patrón de **hierarchical content-addressable caching with partial invalidation** es genérico. Cualquier sistema que:

- Procese datos en múltiples fases/tiers
- Tenga inputs que cambian parcialmente entre ejecuciones
- Necesite saber "qué re-procesar" sin re-ejecutar todo

...se beneficia de esta estructura. Ejemplos:

- **CI/CD**: qué tests re-ejecutar cuando cambia un archivo (como Turborepo pero per-test)
- **ETL pipelines**: qué datos re-procesar cuando cambia una fuente
- **Visual regression testing**: qué screenshots re-tomar cuando cambia el CSS
- **Monitoring**: qué métricas recalcular cuando cambian los inputs

Plan a futuro: extraer el `ProbeCache` como librería npm cuando la API esté validada en producción.

---

## 7. Referencias

- Goel, A. et al. "Sprinter: Speeding Up High-Fidelity Crawling of the Modern Web." NSDI 2024. https://www.usenix.org/system/files/nsdi24-goel.pdf
- Olianas, D. et al. "STILE: A tool for optimizing E2E web test scripts parallelization." Journal of Systems and Software, 2024. https://www.sciencedirect.com/science/article/pii/S0164121424003480
- Spec completo: `docs/superpowers/specs/2026-03-25-differential-probe-design.md`
- Research Sprinter: `docs/research/sprinter-high-fidelity-crawling.md`
- Plan de implementación Phase 1: `docs/superpowers/plans/2026-03-25-differential-probe-phase1.md`
