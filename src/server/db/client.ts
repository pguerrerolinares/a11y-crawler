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
}
