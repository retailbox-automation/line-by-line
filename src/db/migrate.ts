import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

// The same relative path works from src/db/ (tsx, tests) and dist/db/ (built server).
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

const FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

/** Applies migrations/NNN_*.sql in order, each in its own transaction. Returns the versions applied now. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(dir)).filter((f) => FILE.test(f)).sort();
  const versions = new Set<string>();
  for (const f of files) {
    const v = FILE.exec(f)![1]!;
    if (versions.has(v)) throw new Error(`two migrations share version ${v}`);
    versions.add(v);
  }
  const done = new Set((await db.query<{ version: string }>(`SELECT version FROM schema_migrations`)).rows.map((r) => r.version));
  const applied: string[] = [];
  for (const f of files) {
    const version = FILE.exec(f)![1]!;
    if (done.has(version)) continue;
    const sql = await readFile(`${dir}${dir.endsWith("/") ? "" : "/"}${f}`, "utf8");
    await db.tx(async (q) => {
      await q.exec(sql);
      await q.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
    });
    applied.push(version);
  }
  return applied;
}
