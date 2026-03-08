# Logs Refinement Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create the implementation plan from this design.

**Goal:** Refine the Request Logs screen — cleaner filter bar, icon columns for data presence, backend WS cleanup, IP fix, and content-based filtering.

**Validated with:** Gemini CLI design review

---

## Filter Bar

### Structure
- **Row 1:** Method chips (GET/POST/PUT/DELETE/PATCH) + Clear button (conditional) + Refresh button
- **Row 2:** Path | Status | IP | From | To (5 inputs, same as current minus Min ms)
- **"Filters +" button:** Opens a Popover with 3 advanced inputs: Params, Req body, Res body

### Changes from current
- Remove: Min ms input
- Add: "Filters +" popover button with Params / Req body / Res body text search inputs
- The popover button shows a badge/dot indicator when any advanced filter is active

---

## Table Columns

Final order: **Time | Method | Path | Status | Duration | IP | Size | P | Req | Res**

### New icon columns (P, Req, Res)
| Column | Icon (lucide-react) | Color | Empty state |
|--------|-------------------|-------|------------|
| P (Query Params) | `Braces` 12px | `text-slate-400` | `—` in muted |
| Req (Request Body) | `ArrowUpFromLine` 12px | `text-slate-400` | `—` in muted |
| Res (Response Body) | `ArrowDownToLine` 12px | `text-slate-400` | `—` in muted |

- Column header: icon only (no text label), `w-8` width, `title=` attribute for accessibility tooltip
- Clicking an active icon opens the detail modal focused on the correct tab (Request or Response)
- Neutral slate color avoids conflict with the HTTP method color system (GET=blue, POST=green, etc.)

### Other table improvements
- **Duration:** 3 color zones — `<500ms` default, `500–999ms` amber, `≥1000ms` red. Add `tabular-nums` class.
- **Method cell:** `min-w-[64px]` to prevent column width jumps between short (GET) and long (DELETE) badges
- **Path cell:** Add `title={log.path}` for native tooltip on truncated paths
- **Refresh button:** `animate-spin` on the RefreshCw icon during `isFetching` state

---

## Modal

- Add `initialTab?: "general" | "request" | "response"` prop to `LogDetailModal`
- When opened via icon click, `initialTab` is set to `"request"` (for P and Req icons) or `"response"` (for Res icon)
- When opened via row click, `initialTab` defaults to `"general"` (existing behavior)
- Change Tabs from `defaultValue` (uncontrolled) to `value` + `onValueChange` (controlled)

---

## Backend Changes

### 1. Remove WebSocket log streaming
- `src/server/ws.ts`: delete `logClients`, `broadcastLog()`, `/ws/logs` upgrade handler
- Keep audit WebSocket intact (`/ws/audits/:id`, `broadcastToAudit`, `startNotifyListener`)
- The `isNoisyLog()` function moves to the REST logs route as a permanent query filter

### 2. Exclude internal routes from logs
- `GET /api/logs` endpoint: always filter out requests where path starts with `/api/logs`, `/ws`, `/health`, or ends with static asset extensions
- No toggle — these never appear in results

### 3. Fix IP extraction
- Read IP from headers in order: `X-Forwarded-For` → `X-Real-IP` → `req.socket?.remoteAddress`
- Normalize `::1` and `127.0.0.1` to `localhost` instead of `unknown`

### 4. Add content-based filters to GET /api/logs
New optional query params:
- `params` — text search within `query_params` JSON column (case-insensitive)
- `reqBody` — text search within `request_body` column
- `resBody` — text search within `response_body` column

Use SQLite `LIKE '%value%'` or `json_extract` for params search.

---

## Summary of File Changes

| File | Change |
|------|--------|
| `src/server/ws.ts` | Remove log WS code |
| `src/server/routes/logs.ts` | Add isNoisyLog filter, IP fix, new query params |
| `frontend/src/components/log-filters.tsx` | Remove Min ms, add Filters+ popover |
| `frontend/src/components/log-detail-modal.tsx` | Add initialTab prop, controlled tabs |
| `frontend/src/pages/logs.tsx` | Add icon columns, duration colors, tabular-nums, title tooltip, isFetching spin |
| `frontend/src/lib/api.ts` | Add params/reqBody/resBody to log query params |
