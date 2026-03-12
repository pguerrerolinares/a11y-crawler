# A11y Crawler — Arquitectura v3 (Actual)

> Estado: en producción. Desplegado en `a11y.pguerrero.me` via Coolify.

## Visión General

Sistema de dos procesos independientes que se comunican a través de PostgreSQL:
- **API Server** — expone REST + SSE, gestiona el frontend, escribe jobs en DB
- **Worker** — procesa auditorías, usa Browserless para Chromium

```mermaid
graph TB
    subgraph Cliente
        Browser[Navegador / Frontend React]
    end

    subgraph API Server ["API Server (Bun.serve :3000)"]
        Routes[REST Routes]
        SSE[SSE /api/audits/:id/events]
        Static[Static Frontend]
    end

    subgraph Worker ["Worker (proceso separado)"]
        Poll[Poll cada 5s]
        Audit[runAudit]
        subgraph Pipeline["Pipeline por página (secuencial)"]
            Nav[1. goto networkidle]
            Cookie[2. dismissCookieBanner]
            Axe[3. runAxe full]
            Interactive[4. runInteractiveTests]
            Repr[5. buildRepresentation]
            LLM[6. discoverNavTargets LLM]
            Links[7. extractLinks + interactWithTargets]
        end
    end

    subgraph Infra
        PG[(PostgreSQL)]
        Browserless[Browserless :3001]
    end

    Browser -->|POST /api/audits| Routes
    Browser -->|GET /api/audits/:id/events| SSE
    Routes -->|INSERT status=pending| PG
    SSE -->|SELECT audit_events| PG
    Poll -->|FOR UPDATE SKIP LOCKED| PG
    Poll --> Audit
    Audit --> Pipeline
    Nav -->|WS CDP| Browserless
    Audit -->|INSERT pages/issues/events| PG
```

---

## Componentes

### API Server (`src/server/`)

Sirve el frontend React (build estático en `dist/frontend`) y expone la API REST.

```mermaid
graph LR
    subgraph Rutas
        A[POST /api/audits] --> DB1[(audits INSERT)]
        B[GET /api/audits] --> DB2[(audits SELECT)]
        C[GET /api/audits/:id] --> DB3[(audits + summary)]
        D[GET /api/audits/:id/pages] --> DB4[(pages)]
        E[GET /api/audits/:id/issues] --> DB5[(issues)]
        F[GET /api/audits/:id/export/csv] --> DB6[(streaming)]
        G[GET /api/audits/:id/export/pdf] --> FS[reports/uuid.pdf]
        H[GET /api/audits/:id/events] --> SSE_Stream[SSE stream]
        SSE_Stream --> DB7[(audit_events polling)]
    end
```

**SSE:** El cliente hace `EventSource` al endpoint `/events`. El servidor hace long-poll sobre `audit_events` y envía cada evento como `data: {...}\n\n`. Conexiones de hasta 255s (Bun `idleTimeout`).

---

### Worker (`src/worker/`)

Proceso independiente. Arranca una sola instancia de Browserless y procesa auditorías en serie.

```mermaid
flowchart TD
    Start([Worker arranca]) --> InitDB[initWorkerDb]
    InitDB --> Launch[launchBrowser\nBrowserless WS o local Chromium]
    Launch --> Loop{Polling loop\ncada 5s}
    Loop -->|No hay jobs| Wait[sleep 5s] --> Loop
    Loop -->|Job encontrado| Claim[claimNextAudit\nFOR UPDATE SKIP LOCKED]
    Claim --> Run[runAudit]
    Run --> Complete[markAuditCompleted]
    Complete --> Loop
    Run -->|Error| Failed[markAuditFailed]
    Failed --> Loop
    Launch -->|disconnect event| Reconnect[launchBrowser retry x5]
```

---

### Pipeline de Auditoría (`src/worker/audit.ts`)

Por cada auditoría, se procesan las páginas **en serie** (una a la vez).

```mermaid
flowchart TD
    Start([runAudit]) --> Resolve[Resolver redirect\nfinnk.com → www.finnk.com]
    Resolve --> Seed[Seed queue con URL base]
    Seed --> Sitemap[discoverSitemapUrls]
    Sitemap --> Queue[UrlQueue con maxPages + maxDepth]

    Queue --> NextUrl{Siguiente URL}
    NextUrl -->|Cola vacía| PostProc[Post-processing]
    NextUrl -->|URL disponible| NewCtx[browser.newContext\nnueva instancia por página]

    NewCtx --> Goto[page.goto networkidle\ntimeout 30s]
    Goto --> Cookie[dismissCookieBanner\n13 selectores DOM\nhasta 6.5s worst-case]
    Cookie --> Axe[runAxe completo\nwcag2a + wcag2aa + wcag22aa]
    Axe --> ITests[runInteractiveTests\ntab order, focus, keyboard traps, skip nav]
    ITests --> BuildRepr[buildRepresentation\nARIA tier 1-3]
    BuildRepr --> NavLLM[discoverNavTargets\nkimi-k2-turbo-preview\ncachéado si repr igual]
    NavLLM --> ExtractLinks[extractLinks + interactWithTargets]
    ExtractLinks --> SaveDB[insertPage + insertIssues\nemitAuditEvent SSE]
    SaveDB --> CtxClose[context.close]
    CtxClose --> NextUrl

    PostProc --> SharedIssues[detectSharedIssues]
    SharedIssues --> MarkDone[markAuditCompleted\nwcag_score + crawl_errors]
    MarkDone --> PDF[generatePdf\nvía Browserless]
    PDF --> Done([Auditoría completada])
```

**Problema crítico:** Se crea un `BrowserContext` nuevo por cada página y nunca se recicla → memory leak de ~30MB/página acumulativo (Playwright issue #6319).

---

### Análisis de Accesibilidad

```mermaid
graph TB
    subgraph axe["runAxe (src/analyzer/axe.ts)"]
        A1[injectAxe via @axe-core/playwright]
        A2[run con tags wcag2a/aa/wcag22aa]
        A3[Mapear violations → Issue]
        A1 --> A2 --> A3
    end

    subgraph interactive["runInteractiveTests (src/analyzer/interactive.ts)"]
        I1[testTabOrder — foco secuencial]
        I2[testFocusVisibility — outline visible]
        I3[testKeyboardTraps — foco atrapado]
        I4[testSkipNavigation — skip links]
    end

    subgraph repr["buildRepresentation (src/repr/tier.ts)"]
        R1[Tier 1: ARIA pruned HTML]
        R2[Tier 2: Heuristic summary]
        R3[Tier 3: Full HTML fallback]
    end
```

**Problema:** `testFocusVisibility` testa elementos del banner CookieBot → 330 falsos positivos.

---

## Base de Datos

```mermaid
erDiagram
    audits {
        uuid id PK
        text url
        jsonb config
        text status
        timestamptz created_at
        timestamptz started_at
        timestamptz finished_at
        text error
        jsonb summary
        jsonb discovery
        jsonb llm_usage
        int wcag_score
        int duration_seconds
        jsonb crawl_errors
    }

    pages {
        uuid id PK
        uuid audit_id FK
        text url
        text title
        int issue_count
        jsonb issues_by_impact
        int duration_ms
    }

    issues {
        uuid id PK
        uuid page_id FK
        uuid audit_id FK
        text rule
        text impact
        text description
        text selector
        text html
        text check_source
        text category
        jsonb wcag_tags
    }

    shared_issues {
        uuid id PK
        uuid audit_id FK
        text rule
        text impact
        int page_count
        jsonb page_urls
    }

    audit_events {
        serial id PK
        uuid audit_id FK
        text event_type
        jsonb data
        timestamptz created_at
    }

    audits ||--o{ pages : "tiene"
    audits ||--o{ issues : "agrupa"
    audits ||--o{ shared_issues : "detecta"
    audits ||--o{ audit_events : "emite"
    pages ||--o{ issues : "contiene"
```

---

## Flujo de Datos: SSE Progress

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant API as API Server
    participant DB as PostgreSQL
    participant W as Worker

    FE->>API: GET /api/audits/:id/events (EventSource)
    API->>DB: SELECT audit_events WHERE audit_id = ?
    loop Procesando páginas
        W->>DB: INSERT audit_events (page_analyzed)
        API->>DB: Poll nuevos eventos
        API-->>FE: data: {"type":"page_analyzed",...}
    end
    W->>DB: INSERT audit_events (completed)
    API->>DB: Poll
    API-->>FE: data: {"type":"completed",...}
    FE->>FE: cerrar EventSource
```

---

## Despliegue (Docker)

```mermaid
graph TB
    subgraph VPS ["VPS 4GB RAM (YOUR_VPS_IP)"]
        subgraph Coolify
            Proxy[Traefik Proxy :443]
        end
        subgraph Containers
            Server[a11y-server\nbun src/server/index.ts\n:3000]
            Worker[a11y-worker\nbun dist/worker.js]
            BL[browserless/chromium\n:3001]
            PG2[PostgreSQL\n:5432]
        end
        Proxy -->|a11y.pguerrero.me| Server
        Worker -->|WS CDP| BL
        Server -->|DATABASE_URL| PG2
        Worker -->|DATABASE_URL| PG2
    end
```

**Restricciones de memoria:**
- Browserless: ~400-600MB por auditoría activa
- Worker: ~200MB + leak de BrowserContext por auditoría
- PostgreSQL: ~200MB
- Disponible para todo: ~1.8GB (4GB - Coolify - otros servicios)

---

## Problemas Identificados en v3

| Problema | Impacto |
|----------|---------|
| `networkidle` wait por página | +3-5s/página en sitios lentos |
| Nuevo BrowserContext por página | Memory leak ~30MB/página, crash en auditorías largas |
| 13 selectores cookie banner | Hasta 6.5s, 330 falsos positivos |
| LLM en cada página | Cost + latencia constante |
| Sin template awareness | Mismo issue reportado 15× en páginas de producto |
| WCAG coverage ~50% | Faltan 8 criterios WCAG 2.2 AA |
| Sin observabilidad | Imposible saber dónde se gasta el tiempo |
| ~10-15s por página | 50 páginas = 500-750s total |
