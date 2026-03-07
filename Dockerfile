# Stage 1: Build frontend
FROM oven/bun:1 AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock* ./
RUN bun install --frozen-lockfile
COPY frontend/ .
RUN bun run build

# Stage 2: Production
FROM oven/bun:1 AS production
WORKDIR /app

# Install Playwright + Chromium
RUN bunx playwright install --with-deps chromium

# Install production dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/

# Copy built frontend
COPY --from=frontend-build /app/dist/frontend/ dist/frontend/

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/server/index.ts"]
