# Production Deploy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy a11y-crawler-v2 to production on existing VPS via Coolify, coexisting with shared-platform.

**Architecture:** Single Docker container (Bun + Playwright) deployed as a Coolify resource. Traefik handles SSL + basic auth for `a11y.pguerrero.me`. Reuses shared-platform PostgreSQL via shared `coolify` Docker network.

**Tech Stack:** Bun, Docker, Coolify/Traefik, PostgreSQL, Let's Encrypt

**Design doc:** `docs/plans/2026-03-09-production-deploy-design.md`

---

### Task 1: Add health endpoint

**Files:**
- Modify: `src/server/index.ts:84-104` (handleApiRoute function)

**Step 1: Add `/health` route**

In `src/server/index.ts`, add at the top of `handleApiRoute`:

```typescript
if (url.pathname === "/api/health" || url.pathname === "/health") {
  return new Response("OK", { status: 200 });
}
```

Place it before the first `if` in `handleApiRoute` (line 86).

**Step 2: Test manually**

Run: `bun run src/server/index.ts &`
Run: `curl http://localhost:3000/health`
Expected: `OK` with status 200.
Kill the server.

**Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(server): add /health endpoint for container health checks"
```

---

### Task 2: Enforce crawler limits for production

**Files:**
- Modify: `src/server/types.ts:7` (maxPages max value)
- Modify: `src/server/jobs/manager.ts` (concurrent audit limit)
- Modify: `src/server/routes/audits.ts:29-53` (createAudit function)

**Step 1: Cap maxPages at 50 in production**

In `src/server/types.ts`, change line 7:

```typescript
// Before:
maxPages: z.number().int().min(1).max(500).default(100),

// After:
maxPages: z.number().int().min(1).max(50).default(30),
```

**Step 2: Add max concurrent audit check in job manager**

In `src/server/jobs/manager.ts`, add at the top of `startCrawl`:

```typescript
const MAX_CONCURRENT_AUDITS = 1;

export function startCrawl(auditId: string, url: string, config: Record<string, unknown>) {
  if (activeJobs.size >= MAX_CONCURRENT_AUDITS) {
    throw new Error("Maximum concurrent audits reached. Please wait for the current audit to finish.");
  }
  // ... rest of existing code
}
```

**Step 3: Handle the error in createAudit**

In `src/server/routes/audits.ts`, wrap the `startCrawl` call in createAudit:

```typescript
try {
  startCrawl(audit.id, auditUrl, config);
} catch (err) {
  // Mark audit as failed since we couldn't start it
  await db`UPDATE audits SET status = 'failed', error = ${(err as Error).message} WHERE id = ${audit.id}`;
  return Response.json({ error: (err as Error).message }, { status: 429 });
}
```

**Step 4: Test manually**

Run: `bun run src/server/index.ts &`

Test maxPages cap:
```bash
curl -X POST http://localhost:3000/api/audits \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","maxPages":100}'
```
Expected: Validation error (max is 50).

Kill the server.

**Step 5: Commit**

```bash
git add src/server/types.ts src/server/jobs/manager.ts src/server/routes/audits.ts
git commit -m "feat(server): enforce production crawler limits — max 1 concurrent audit, 50 pages"
```

---

### Task 3: Create .env.example

**Files:**
- Create: `.env.example`

**Step 1: Create the file**

```env
# Required
DATABASE_URL=postgresql://user:password@host:5432/a11y
LLM_API_KEY=your-moonshot-api-key

# Optional (shown with defaults)
LLM_API_BASE_URL=https://api.moonshot.ai/v1
PORT=3000
NODE_ENV=production
REPORTS_DIR=./reports
```

**Step 2: Verify .env is already in .gitignore**

Check `.gitignore` — `.env` is already listed on line 10. No change needed.

**Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: add .env.example with required environment variables"
```

---

### Task 4: Create docker-compose.coolify.yml

**Files:**
- Create: `docker-compose.coolify.yml`

**Step 1: Create the compose file**

Reference: `shared-platform/docker-compose.coolify.yml` for Traefik label patterns.

```yaml
# docker-compose.coolify.yml — Coolify deployment
# Coolify's Traefik handles SSL + domain routing + basic auth.
# Reuses PostgreSQL from shared-platform via shared coolify network.

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    expose:
      - "3000"
    networks:
      - coolify
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - LLM_API_KEY=${LLM_API_KEY}
      - LLM_API_BASE_URL=${LLM_API_BASE_URL:-https://api.moonshot.ai/v1}
      - NODE_ENV=production
      - PORT=3000
      - REPORTS_DIR=/app/reports
    volumes:
      - reports:/app/reports
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.a11y-https.rule=Host(`a11y.pguerrero.me`)"
      - "traefik.http.routers.a11y-https.entrypoints=https"
      - "traefik.http.routers.a11y-https.tls=true"
      - "traefik.http.routers.a11y-https.tls.certresolver=letsencrypt"
      - "traefik.http.routers.a11y-http.rule=Host(`a11y.pguerrero.me`)"
      - "traefik.http.routers.a11y-http.entrypoints=http"
      - "traefik.http.routers.a11y-http.middlewares=a11y-redirect"
      - "traefik.http.middlewares.a11y-redirect.redirectscheme.scheme=https"
      - "traefik.http.routers.a11y-https.middlewares=a11y-auth"
      - "traefik.http.middlewares.a11y-auth.basicauth.users=${BASIC_AUTH_USER}"
      - "traefik.http.services.a11y.loadbalancer.server.port=3000"
      - "traefik.docker.network=coolify"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3

networks:
  coolify:
    external: true

volumes:
  reports:
```

**Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('docker-compose.coolify.yml'))"`
Expected: No errors.

**Step 3: Commit**

```bash
git add docker-compose.coolify.yml
git commit -m "feat(deploy): add docker-compose.coolify.yml for production via Traefik"
```

---

### Task 5: Build and test Docker image locally

**Step 1: Build the image**

Run: `docker build -t a11y-crawler .`
Expected: Successful build (multi-stage: frontend + production).

**Step 2: Test it runs**

Run (with local postgres, just to verify startup):
```bash
docker run --rm -e DATABASE_URL=postgresql://postgres:dev@host.docker.internal:5433/a11y \
  -e LLM_API_KEY=test -e NODE_ENV=production -p 3000:3000 a11y-crawler
```
Expected: Server starts, "Database initialized" in logs.

**Step 3: Test health endpoint**

Run: `curl http://localhost:3000/health`
Expected: `OK`

Stop the container.

No commit — this is validation only.

---

### Task 6: Deploy to VPS via Coolify

This task is manual in the Coolify UI + VPS SSH.

**Step 1: Create the `a11y` database on VPS**

```bash
ssh root@YOUR_VPS_IP
docker exec -it db-qwg00wcsoksgg84c0ww0ck8s-235209502575 \
  psql -U ainews -c "CREATE DATABASE a11y;"
```

**Step 2: Add DNS A record**

In your domain registrar (for `pguerrero.me`):
- Type: A
- Name: `a11y`
- Value: `YOUR_VPS_IP`
- TTL: 300

**Step 3: Generate basic auth password**

```bash
# On VPS or local machine with htpasswd or openssl:
echo "$(openssl passwd -apr1 YOUR_PASSWORD_HERE)"
# Format for Traefik: user:hashed_password
# Double any $ signs → $$ for Docker Compose
```

**Step 4: Add resource in Coolify**

1. Open Coolify dashboard (VPS:8000)
2. Go to existing shared-platform project
3. Add new resource → Docker Compose
4. Point to a11y-crawler git repo
5. Set compose file path: `docker-compose.coolify.yml`
6. Add environment variables:
   - `DATABASE_URL=postgresql://ainews:PASSWORD@db-qwg00wcsoksgg84c0ww0ck8s-235209502575:5432/a11y`
   - `LLM_API_KEY=your-key`
   - `LLM_API_BASE_URL=https://api.moonshot.ai/v1`
   - `BASIC_AUTH_USER=user:$$apr1$$...` (htpasswd hash, $ doubled)
7. Deploy

**Step 5: Verify**

```bash
curl -u user:password https://a11y.pguerrero.me/health
```
Expected: `OK`

**Step 6: Test full audit**

```bash
curl -u user:password -X POST https://a11y.pguerrero.me/api/audits \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","maxPages":5}'
```
Expected: 201 with audit JSON.

---

## Summary

| Task | What | Type |
|------|------|------|
| 1 | Health endpoint | Code change |
| 2 | Crawler limits | Code change |
| 3 | .env.example | Documentation |
| 4 | docker-compose.coolify.yml | Infrastructure |
| 5 | Docker build test | Validation |
| 6 | Deploy to VPS | Manual deployment |
