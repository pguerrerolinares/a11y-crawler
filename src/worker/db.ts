import postgres, { type JSONValue } from "postgres";

let db: ReturnType<typeof postgres>;

export const json = (value: unknown) => db.json(value as JSONValue);

export async function initWorkerDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  db = postgres(url);
  await runWorkerMigrations();
}

async function runWorkerMigrations(): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  const applied = await db`SELECT id FROM migrations`;
  const appliedSet = new Set(applied.map((r) => r.id));

  if (!appliedSet.has("v4-pipeline-columns")) {
    console.log("Running migration: v4-pipeline-columns");
    await db.begin(async (tx) => {
      await tx.unsafe(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS template_id TEXT`);
      await tx.unsafe(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS is_representative BOOLEAN DEFAULT false`);
      await tx.unsafe(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS fingerprint TEXT`);
      await tx.unsafe(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS element_count INTEGER`);
      await tx.unsafe(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS capabilities JSONB`);
      await tx.unsafe(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS template_id TEXT`);
      await tx.unsafe(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS affected_pages INTEGER DEFAULT 1`);
      await tx.unsafe(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS amplified_from TEXT`);
      await tx.unsafe(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS wcag_score INT`);
      await tx.unsafe(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS duration_seconds INT`);
      await tx.unsafe(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS crawl_errors JSONB`);
      await tx.unsafe(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS template_clusters JSONB`);
      await tx.unsafe(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS coverage JSONB`);
      await tx.unsafe(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS regression JSONB`);
      await tx.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_audit_url ON pages(audit_id, url)`);
      await tx`INSERT INTO migrations (id) VALUES ('v4-pipeline-columns')`;
    });
    console.log("Migration v4-pipeline-columns applied");
  }

  if (!appliedSet.has("v4.3-llm-confidence")) {
    console.log("Running migration: v4.3-llm-confidence");
    await db.begin(async (tx) => {
      await tx.unsafe(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS llm_confidence TEXT`);
      await tx`INSERT INTO migrations (id) VALUES ('v4.3-llm-confidence')`;
    });
    console.log("Migration v4.3-llm-confidence applied");
  }

  if (!appliedSet.has("v4.4-issues-indexes")) {
    console.log("Running migration: v4.4-issues-indexes");
    await db.begin(async (tx) => {
      await tx.unsafe(`CREATE INDEX IF NOT EXISTS idx_issues_audit_impact ON issues(audit_id, impact)`);
      await tx.unsafe(`CREATE INDEX IF NOT EXISTS idx_issues_audit_rule ON issues(audit_id, rule)`);
      await tx.unsafe(`CREATE INDEX IF NOT EXISTS idx_issues_audit_source ON issues(audit_id, check_source)`);
      await tx.unsafe(`CREATE INDEX IF NOT EXISTS idx_issues_page ON issues(page_id)`);
      await tx`INSERT INTO migrations (id) VALUES ('v4.4-issues-indexes')`;
    });
    console.log("Migration v4.4-issues-indexes applied");
  }
}

export function getWorkerDb() {
  if (!db) throw new Error("Worker DB not initialized. Call initWorkerDb() first.");
  return db;
}
