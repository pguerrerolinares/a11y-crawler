# A11y Crawler — Arquitectura v4 (Propuesta)

> Estado: diseño aprobado. Reemplaza v3.
> Diseño detallado: `docs/plans/2026-03-12-crawler-v4-design.md`

## Visión General

Mismo modelo de despliegue que v3 (API Server + Worker + Browserless), pero con un pipeline de auditoría radicalmente diferente: **3 fases + pre-fase de descubrimiento**, con template clustering para evitar analizar páginas idénticas.

```mermaid
graph TB
    subgraph Cliente
        Browser[Navegador / Frontend React]
    end

    subgraph API["API Server (sin cambios v3→v4)"]
        REST[REST Routes]
        SSE[SSE /api/audits/:id/events]
    end

    subgraph Worker ["Worker — Pipeline v4"]
        P0[PHASE 0\nDISCOVER]
        P1[PHASE 1\nSCAN]
        P2[PHASE 2\nCLASSIFY]
        P3[PHASE 3\nPROBE]
        P0 --> P1 --> P2 --> P3
    end

    subgraph Infra
        PG[(PostgreSQL)]
        BL[Browserless]
        LLM[Moonshot AI\nkimi-k2-turbo-preview]
    end

    Browser --> REST
    REST --> PG
    Worker --> PG
    Worker --> SSE
    P1 -->|3 slots concurrentes| BL
    P3 -->|1 slot secuencial| BL
    P0 -.->|solo si SPA detectada\n~5% de páginas| LLM
```

---

## Pipeline Completo

```mermaid
flowchart TD
    Start([Job reclamado de PostgreSQL]) --> P0

    subgraph P0["PHASE 0 — DISCOVER (una vez por auditoría)"]
        D1[Resolver redirect\nfinnk.com → www.finnk.com]
        D2[discoverSitemapUrls\nexistente de v3]
        D3{SPA detectada?\napp-root / #root / #__next\ncon < 3 links}
        D4[LLM nav discovery\nkimi-k2-turbo-preview\nUNA sola llamada]
        D5[Seed URL list]
        D1 --> D2 --> D3
        D3 -->|Sí ~5%| D4 --> D5
        D3 -->|No ~95%| D5
    end

    P0 --> P1

    subgraph P1["PHASE 1 — SCAN (3 slots concurrentes)"]
        S1[SlotPool.acquire]
        S2[page.goto domcontentloaded\ntimeout 15s]
        S3[Cookie blocking\nLayer 1: network abort CDN CMPs\nLayer 2: CSS prehide]
        S4[Batch page.evaluate\nSimHash fingerprint\ncapabilities detect\nlink extraction\naxe-light 5 reglas]
        S5[Insertar issues content-level\nen DB inmediatamente]
        S6[SlotPool.release\nreciclar context cada 25 páginas]
        S1 --> S2 --> S3 --> S4 --> S5 --> S6
        S6 -->|más URLs en queue| S1
    end

    P1 --> P2

    subgraph P2["PHASE 2 — CLASSIFY (en memoria, ~50ms)"]
        C1[Agrupar por SimHash\nHamming ≤ 8 bits de 64]
        C2[Refinar con URL pattern\nsolo si AMBOS coinciden]
        C3[selectRepresentative\nforms×4 + media×3\ncarousel×2 + tables×1]
        C4{clusters > 25?}
        C5[Priorizar por\npageCount × capabilityScore\ncap MAX_PROBE_TEMPLATES=25]
        C6[TemplateCluster list\ncon representative por cluster]
        C1 --> C2 --> C3 --> C4
        C4 -->|Sí| C5 --> C6
        C4 -->|No| C6
    end

    P2 --> P3

    subgraph P3["PHASE 3 — PROBE (1 slot secuencial)"]
        PR1[Solo representantes\ntípicamente 5-15 de 50-100 páginas]
        PR2[page.goto load\ntodos los recursos]
        PR3[Cookie blocking\niguales capas que SCAN]
        PR4[runAxe completo\nwcag2a + wcag2aa + wcag22aa]
        PR5[8 nuevos tests WCAG]
        PR6[runInteractiveTests\nexistentes]
        PR7[Amplificar issues\ntemplate-level → todo el cluster]
        PR8[SlotPool.release\nreciclar cada 5 páginas]
        PR1 --> PR2 --> PR3 --> PR4 --> PR5 --> PR6 --> PR7 --> PR8
        PR8 -->|más representantes| PR1
    end

    P3 --> Post

    subgraph Post["Post-processing"]
        PP1[computeWcagScore]
        PP2[markAuditCompleted\ncon template_clusters + coverage]
        PP3[generatePdf]
        PP4[emitAuditEvent completed]
        PP1 --> PP2 --> PP3 --> PP4
    end

    Post --> Done([Auditoría completada])
```

---

## Phase 0 — DISCOVER

```mermaid
flowchart LR
    Start[URL base] --> Redirect[Resolver redirect HTTP]
    Redirect --> Sitemap[discoverSitemapUrls\nsitemap.xml / robots.txt]
    Sitemap --> Homepage[Visitar homepage\nbatch DOM query]
    Homepage --> SPACheck{< 3 links internos\nY shell SPA detectada?}
    SPACheck -->|No| Merge[Merge: sitemap + links]
    SPACheck -->|Sí\n~5% de sitios| LLM[LLM kimi-k2-turbo-preview\ninfiere rutas del sitio\nUNA llamada]
    LLM --> Merge
    Merge --> SeedQueue[UrlQueue seed\nmaxPages + maxDepth]
```

---

## Phase 1 — SCAN (Detalle)

```mermaid
flowchart TD
    subgraph SlotPool["SlotPool — 3 slots"]
        Slot1[ContextSlot 1]
        Slot2[ContextSlot 2]
        Slot3[ContextSlot 3]
    end

    subgraph ContextSlot["ContextSlot (por slot)"]
        CS1{pagesSinceRecycle\n>= 25?}
        CS2[context.close\nnuevo BrowserContext]
        CS3[context.newPage]
        CS1 -->|Sí| CS2 --> CS3
        CS1 -->|No| CS3
    end

    subgraph PageEval["Batch page.evaluate — un solo roundtrip CDP"]
        E1[SimHash 64-bit\nskeleton DOM depth 6\n~3-8ms]
        E2[Capabilities\nhasForms / hasMedia\nhasCarousel / hasDataTables]
        E3[Links internos\nmismo origen]
        E4[axe-light\nimage-alt, link-name\nbutton-name, label\ndocument-title]
    end

    subgraph CookieBlock["Cookie Blocking — 2 capas"]
        CB1[Layer 1: context.route\nabort CDN CMPs\ncookiebot, onetrust\ncookieyes, consentmanager]
        CB2[Layer 2: CSS prehide\nsafety net selectores genéricos]
    end

    URL --> SlotPool
    SlotPool --> ContextSlot
    ContextSlot --> CookieBlock
    CookieBlock --> Navigate[page.goto domcontentloaded\ntimeout 15s]
    Navigate --> PageEval
    PageEval --> SaveContent[INSERT issues content-level\nimage-alt, link-name, button-name\nlabel, document-title]
    SaveContent --> ScanResult[ScanResult\nurl + fingerprint\n+ capabilities + links]
```

---

## Phase 2 — CLASSIFY (Detalle)

```mermaid
flowchart TD
    ScanResults[ScanResults\nMap url→ScanResult] --> Cluster

    subgraph Cluster["Clustering doble criterio"]
        CL1[Calcular SimHash Hamming\nentre todos los pares]
        CL2{Hamming ≤ 8 bits\nY mismo URL pattern?}
        CL3[Mismo cluster]
        CL4[Cluster separado]
        CL1 --> CL2
        CL2 -->|Sí — ambos| CL3
        CL2 -->|No| CL4
    end

    Cluster --> RepSelect

    subgraph RepSelect["Selección de representante"]
        RS1["score = forms×4 + media×3\n+ carousel×2 + tables×1"]
        RS2[URL con score máximo\n= representante del cluster]
        RS1 --> RS2
    end

    RepSelect --> Cap

    subgraph Cap["Cap de templates"]
        CA1{clusters.length\n> 25?}
        CA2[Ordenar por\npageCount × capabilityScore]
        CA3[Top 25 → PROBE\nResto → SCAN only\nreteniendo issues axe-light]
        CA1 -->|Sí| CA2 --> CA3
        CA1 -->|No| CA3
    end

    Cap --> TestPlan[Test plan\npor capabilities\nde cada representante]
```

---

## Phase 3 — PROBE (Detalle)

```mermaid
flowchart TD
    Representatives[Representantes\nmáx 25] --> ProbeSlot[ContextSlot\nreciclar cada 5 páginas]

    ProbeSlot --> Navigate[page.goto load\ntodos los recursos\ntimeout 30s]
    Navigate --> CookieBlock[Cookie blocking\nmismas 2 capas]
    CookieBlock --> AxeFull[runAxe completo\nwcag2a + wcag2aa + wcag22aa]
    AxeFull --> NewTests

    subgraph NewTests["8 Nuevos Tests WCAG 2.2 AA"]
        subgraph TierA["Tier A — v4.0"]
            T1[Reflow 320px\nsin scroll horizontal]
            T2[Text Spacing\nline-height/letter-spacing override]
            T3[Resize Text 200%\nsin overflow]
        end
        subgraph TierB["Tier B — v4.1"]
            T4[Non-text Contrast 3:1\nborders + iconos]
            T5[Multimedia\naudio-description, captions]
            T6[Timed Events\nauto-refresh detection]
        end
        subgraph TierC["Tier C — v4.2"]
            T7[Error Identification\nempty form submit]
            T8[Target Size 24×24px\nbotones pequeños]
        end
    end

    NewTests --> InteractiveTests[runInteractiveTests\ntab order, focus\nkeyboard traps, skip nav]
    InteractiveTests --> Amplify

    subgraph Amplify["Amplificación de issues"]
        AM1{Tipo de issue}
        AM2[Template-level\nCSS, estructura, contraste\n→ amplificar a TODAS las URLs del cluster]
        AM3[Content-level\nalt, link-name, label\n→ NO amplificar, ya en SCAN]
        AM4[Capability-level\nforms, multimedia\n→ solo reportar en representante]
        AM1 -->|template| AM2
        AM1 -->|content| AM3
        AM1 -->|capability| AM4
    end

    Amplify --> SaveDB[INSERT issues con\ntemplate_id + amplified_from\nsi aplica]
```

---

## Amplificación de Issues

```mermaid
graph LR
    subgraph Cluster["Template cluster: /products/:slug (8 páginas)"]
        Rep["Representante\n/products/widget-pro\n✓ PROBE completo"]
        P2[/products/basic-plan]
        P3[/products/enterprise]
        P4[/products/team]
        P5[/products/...]
    end

    subgraph Issues
        TI["Issue template-level\ncolor-contrast ratio 2.1:1\nen h2.product-title\n(CSS compartido)"]
        CI["Issue content-level\nimage-alt vacío\n(específico de página)"]
    end

    Rep -->|PROBE detecta| TI
    TI -->|amplificado a| P2
    TI -->|amplificado a| P3
    TI -->|amplificado a| P4
    TI -->|amplificado a| P5
    Rep -->|SCAN detectó| CI
    CI -->|NO se amplifica| CI
```

---

## Gestión de Memoria — SlotPool + Context Recycling

```mermaid
sequenceDiagram
    participant Q as URL Queue
    participant SP as SlotPool
    participant CS as ContextSlot
    participant BL as Browserless

    Q->>SP: acquire()
    SP->>CS: entregar slot disponible
    CS->>CS: pagesSinceRecycle >= 25?
    alt context saturado
        CS->>BL: context.close()
        CS->>BL: browser.newContext()
        Note over CS,BL: ~150MB liberados
    end
    CS->>BL: context.newPage()
    BL-->>CS: page
    CS-->>SP: page lista
    SP-->>Q: slot con page

    Note over Q,BL: ... procesamiento de página ...

    Q->>SP: release(slot)
    SP->>SP: ¿hay waiting?
    alt hay waiter
        SP->>Q: entregar slot a siguiente URL
    else no hay waiter
        SP->>SP: available.push(slot)
    end
```

**SCAN:** 3 slots concurrentes, recycle cada 25 páginas (~150MB liberados por recycle)
**PROBE:** 1 slot secuencial, recycle cada 5 páginas (páginas más pesadas con full load)

---

## Base de Datos — Cambios v3 → v4

```mermaid
erDiagram
    audits {
        uuid id PK
        text url
        jsonb config
        text status
        jsonb summary
        int wcag_score
        jsonb crawl_errors
        jsonb template_clusters "NUEVO — clusters con representantes"
        jsonb coverage "NUEVO — matriz WCAG 2.2 AA"
        jsonb regression "NUEVO v4.1 — diff con auditoría anterior"
    }

    pages {
        uuid id PK
        uuid audit_id FK
        text url
        text title
        int issue_count
        text template_id "NUEVO — cluster al que pertenece"
        text coverage_type "NUEVO — full/scan-only"
    }

    issues {
        uuid id PK
        uuid page_id FK
        uuid audit_id FK
        text rule
        text impact
        text check_source
        uuid amplified_from "NUEVO — page_id del representante origen"
    }

    audit_spans {
        uuid id PK
        uuid audit_id FK
        text name "NUEVO — audit:scan, audit:classify, audit:probe"
        text status "NUEVO — ok/error/timeout"
        timestamptz started_at
        timestamptz ended_at
        int duration_ms
        jsonb metadata
    }

    audits ||--o{ pages : "tiene"
    audits ||--o{ issues : "agrupa"
    audits ||--o{ audit_spans : "observabilidad"
    pages ||--o{ issues : "contiene"
```

---

## Observabilidad — Structured Spans

```mermaid
gantt
    title Audit Spans — ejemplo 50 páginas
    dateFormat  s
    axisFormat %Ss

    section Phase 0
    discover        :0, 5s

    section Phase 1 SCAN
    scan:slot1      :5, 50s
    scan:slot2      :5, 50s
    scan:slot3      :5, 50s

    section Phase 2
    classify        :55, 1s

    section Phase 3 PROBE
    probe:p1        :56, 18s
    probe:p2        :74, 18s
    probe:p3        :92, 18s
    probe:p4        :110, 18s
    probe:p5        :128, 18s

    section Post
    pdf             :146, 10s
```

Cada span se inserta en `audit_spans` con flush al final de cada fase (no solo al terminar la auditoría).

---

## Comparativa v3 → v4

| Aspecto | v3 (actual) | v4 (propuesta) |
|---------|-------------|----------------|
| Pipeline | Secuencial, 1 página a la vez | 3 fases + pre-discover |
| Concurrencia | 1 página | 3 concurrentes en SCAN, 1 en PROBE |
| Wait strategy | `networkidle` (~8s/página) | `domcontentloaded` SCAN, `load` PROBE |
| Cookie handling | 13 selectores DOM, hasta 6.5s | Network abort CDN + CSS prehide |
| WCAG coverage | ~50% (17/29 criterios) | ~75% v4.0 → ~90% v4.2 |
| Template awareness | Ninguna | SimHash + URL pattern clustering |
| Memory leak | ~30MB/página acumulativo | Context recycling cada 25/5 páginas |
| LLM usage | Cada página (nav discovery) | Solo si SPA detectada (~5% páginas) |
| Observabilidad | Ninguna | Spans estructurados por fase |
| Falsos positivos cookies | ~330 | 0 |
| Tiempo 50 páginas | 500-750s | ~200s |
| Máx templates en PROBE | N/A | 25 (cap duro) |

---

## Despliegue (sin cambios respecto a v3)

```mermaid
graph TB
    subgraph VPS ["VPS 4GB RAM"]
        subgraph Coolify
            Traefik[Traefik :443]
        end
        subgraph Containers
            Server[a11y-server\n:3000]
            Worker[a11y-worker]
            BL[browserless/chromium\n:3001]
            PG2[PostgreSQL\n:5432]
        end
        Traefik -->|a11y.pguerrero.me| Server
        Worker -->|WS CDP| BL
        Server --> PG2
        Worker --> PG2
    end
```

**Nuevas variables de entorno requeridas:**
- `LLM_API_KEY` — ya existe
- `BROWSERLESS_URL` — ya existe
- Sin nuevas dependencias externas

---

## Fases de Entrega

```mermaid
gantt
    title Roadmap v4
    dateFormat YYYY-MM-DD
    section v4.0
    Pipeline 3 fases + cookie blocking  :2026-03-15, 14d
    Tier A WCAG tests (reflow, text-spacing, resize) :2026-03-22, 7d
    section v4.1
    Regression diff entre auditorías    :2026-04-01, 7d
    Tier B WCAG tests (contrast, multimedia, timed) :2026-04-01, 7d
    section v4.2
    Tier C WCAG tests (error-id, target-size) :2026-04-15, 7d
    Non-text contrast (research needed) :2026-04-15, 14d
```
