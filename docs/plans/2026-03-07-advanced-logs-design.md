# Advanced Logs System — Design

## Overview

Upgrade the logs page from a basic request table to a full HTTP API inspector with advanced filtering, request/response detail viewing, and live WebSocket streaming.

## Decisions

- **Response capture:** metadata always (size, content-type) + truncated body (first 2KB)
- **Date filtering:** date-time range pickers (from / to)
- **Detail view:** centered modal with tabs (General, Request, Response, Error)
- **Live updates:** WebSocket streaming (reuse existing WS infra), filter out noise (internal routes)
- **Search:** structured filters only (no full-text body search)
- **Refresh:** manual button only (no polling), live WS for new entries

## 1. Backend — Schema Changes

Add columns to `request_logs`:

```sql
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS response_body TEXT;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS content_type TEXT;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS query_params JSONB;
```

Existing columns already present: `ip`, `user_agent`, `request_body`, `response_size`, `error`.

## 2. Backend — Middleware Changes (`logger.ts`)

Capture additional data on every API request:

- `response_body` — first 2048 chars of response body (truncated)
- `content_type` — response Content-Type header
- `query_params` — parsed URL search params as JSONB object
- `response_size` — byte length of response body

The middleware needs access to the Response object to extract body/headers. This requires cloning the response to read its body.

## 3. Backend — API Changes (`routes/logs.ts`)

### `GET /api/logs` — Enhanced filters

| Param | Type | Description |
|-------|------|-------------|
| `method` | string | Comma-separated methods: `GET,POST` |
| `path` | string | LIKE search on path |
| `status` | string | Exact code or range: `404`, `4xx`, `5xx` |
| `ip` | string | Exact match |
| `from` | string | ISO datetime, inclusive |
| `to` | string | ISO datetime, inclusive |
| `minDuration` | number | Minimum duration in ms |
| `limit` | number | Pagination (default 50) |
| `offset` | number | Pagination (default 0) |

### `GET /api/logs/:id` — New endpoint

Returns full log entry including request_body, response_body, query_params, user_agent. Used by the detail modal.

### Response mapping

Extend the row mapper to include all new fields in camelCase.

## 4. Backend — WebSocket Log Streaming

When a log is inserted in the middleware:

1. Call `pg_notify('new_log', log_id::text)` after INSERT
2. The existing WS server subscribes to `new_log` channel
3. On notification, fetch the log row and broadcast to connected log viewers
4. **Noise filter:** skip emitting logs for paths matching: `/api/logs`, `/ws`, `/health`, static assets (`/assets/`, `.js`, `.css`, `.svg`, `.ico`)

Frontend WS clients subscribe with a message like `{ type: "subscribe_logs" }`.

## 5. Frontend — Filter Bar

Horizontal bar above the table:

- **Method** — multi-select chip buttons (GET, POST, PUT, DELETE, PATCH)
- **Path** — text input with debounce
- **Status** — select with options: All, 2xx, 3xx, 4xx, 5xx, or type exact code
- **IP** — text input
- **Date from** — datetime-local input
- **Date to** — datetime-local input
- **Min duration** — number input (ms)
- **Clear all** — button to reset all filters
- **Refresh** — manual refresh button

Filters update the query and re-fetch. Offset resets to 0 on filter change.

## 6. Frontend — Enhanced Table

Columns:

| Column | Content |
|--------|---------|
| Time | `toLocaleString()` |
| Method | Colored badge |
| Path | Monospace, includes query params preview |
| Status | Colored badge |
| Duration | `Nms`, highlight slow (>1000ms) |
| IP | Address |
| Size | Formatted bytes (B/KB/MB) |

Row is clickable — opens detail modal.

## 7. Frontend — Detail Modal

Tabs inside a centered dialog:

### General tab
- Method + Path (large)
- Status code badge
- Duration
- IP address
- User-Agent
- Timestamp

### Request tab
- Query params as key-value table
- Request body as formatted JSON (with `<pre>` + syntax coloring via CSS)

### Response tab
- Content-Type
- Response size
- Response body as formatted JSON (truncated indicator if >2KB)

### Error tab (conditional)
- Only shown if error field is non-null
- Error message in red

## 8. Frontend — Live Indicator

- Green pulsing dot + "Live" text when WS connected
- Gray dot + "Disconnected" when WS down
- New logs appear at top with subtle fade-in CSS animation
- Live logs respect active filters (client-side filtering of WS events)

## Tech Stack

- Backend: Bun.serve + Bun.sql (existing)
- Frontend: React 19 + TanStack Query + shadcn/ui (existing)
- WebSocket: existing pg_notify infrastructure
- No new dependencies needed
