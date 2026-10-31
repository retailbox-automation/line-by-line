import type { Db } from "./db.js";
import { createPgDb } from "./pg.js";

export type { Db, Queryable } from "./db.js";
export { migrate } from "./migrate.js";

/**
 * DATABASE_URL set -> Postgres. Otherwise an in-process PGlite (local runs and the sandbox e2e only; PGlite is
 * a dev dependency, so it is imported lazily).
 */
export async function openDb(env: { DATABASE_URL?: string | undefined; PGLITE_DIR?: string | undefined } = process.env): Promise<Db> {
  if (env.DATABASE_URL) return createPgDb(env.DATABASE_URL);
  const { createPgliteDb } = await import("./pglite.js");
  return createPgliteDb(env.PGLITE_DIR);
}
