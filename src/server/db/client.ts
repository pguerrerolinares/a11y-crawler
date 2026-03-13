import { SQL } from "bun";

let db: InstanceType<typeof SQL> | null = null;

export function getDb() {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    db = new SQL(url);
  }
  return db;
}

export async function initDb() {
  const conn = getDb();
  const schema = await Bun.file(
    new URL("./schema.sql", import.meta.url)
  ).text();
  await conn.unsafe(schema);
  await runMigrations(conn);
}

async function runMigrations(conn: InstanceType<typeof SQL>) {
  // Ensure migrations table exists
  await conn.unsafe(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await conn.unsafe(`SELECT id FROM migrations`);
  const appliedSet = new Set(applied.map((r: { id: string }) => r.id));

  // Migration: clean legacy data for v4 pipeline
  if (!appliedSet.has("v4-clean")) {
    console.log("Running migration: v4-clean");
    await conn.begin(async (tx) => {
      await tx.unsafe(`TRUNCATE audits CASCADE`);
      await tx.unsafe(`DROP TABLE IF EXISTS shared_issues`);
      await tx.unsafe(`INSERT INTO migrations (id) VALUES ('v4-clean')`);
    });
    console.log("Migration v4-clean applied");
  }
}
