# Production Deploy Design — a11y-crawler-v2

**Date:** 2026-03-09
**VPS:** root@89.167.115.45
**Coexists with:** ai-news-platform (same Coolify project)

## Architecture

Single Docker container deployed via Coolify as a new resource within the existing ai-news-platform project. Traefik (managed by Coolify) handles SSL, domain routing, and basic auth. No nginx needed.

```
Internet → Traefik (Coolify) → a11y-crawler:3000
                                    ↓
                              PostgreSQL (ai-news db container, network: coolify)
```

## Domain

`a11y.pguerrero.me` — DNS A record pointing to VPS IP (89.167.115.45).

## Docker Compose (Coolify)

`docker-compose.coolify.yml` with one service:

- **app**: Builds from existing Dockerfile, exposes port 3000
  - Network: `coolify` (external) — gives access to Traefik + ai-news PostgreSQL
  - Traefik labels for `a11y.pguerrero.me` with HTTPS + Let's Encrypt
  - Traefik basic auth middleware
  - Health check: `GET /api/audits` (already exists, returns 200)

## Database

Reuse ai-news PostgreSQL (`db` container on `coolify` network, port 5432). Create a separate database `a11y` within it.

Connection: `postgresql://ainews:PASSWORD@db:5432/a11y`

The `initDb()` function on server startup runs `schema.sql` which creates tables if they don't exist.

One-time setup: `CREATE DATABASE a11y;` on the existing PostgreSQL instance.

## Environment Variables (via Coolify UI)

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | `postgresql://ainews:PASSWORD@db:5432/a11y` |
| `LLM_API_KEY` | Moonshot API key |
| `LLM_API_BASE_URL` | `https://api.moonshot.ai/v1` |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |

No `.env` file on VPS — all managed by Coolify.

## Security

- **Basic auth** via Traefik middleware (htpasswd format in labels)
- **HTTPS** via Let's Encrypt (Traefik certresolver)
- **`.env` removed from git tracking**, `.env.example` added for documentation
- PostgreSQL not exposed to host — only accessible via Docker network

## Crawler Limits (Production)

- Max **1 concurrent audit** (hardcoded in job manager)
- Max **50 pages per audit** (hardcoded in crawler config)

## Code Changes Required

1. **Create `docker-compose.coolify.yml`** — single service with Traefik labels
2. **Add `GET /health` endpoint** — simple 200 OK response
3. **Hardcode crawler limits** — 1 concurrent audit, 50 max pages
4. **`.env` cleanup** — add to `.gitignore`, create `.env.example`

## Changes to ai-news-platform

**None.** The `db` container is already on the `coolify` network and accessible by DNS name `db`.

## Deployment Steps

1. Add DNS A record: `a11y.pguerrero.me` → `89.167.115.45`
2. Create database: `docker exec` into ai-news pg container, `CREATE DATABASE a11y;`
3. In Coolify UI: add new resource (Docker Compose) to existing project
4. Point to a11y-crawler git repo, set compose file to `docker-compose.coolify.yml`
5. Configure env vars in Coolify UI
6. Set basic auth credentials
7. Deploy
