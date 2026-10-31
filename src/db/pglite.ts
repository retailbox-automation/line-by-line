import { PGlite } from "@electric-sql/pglite";
import type { Db, Queryable } from "./db.js";

/** In-process Postgres for tests and local runs without DATABASE_URL. `dataDir` omitted = in memory. */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  return wrapPglite(pg);
}

type PgliteLike = Pick<PGlite, "query" | "exec" | "transaction" | "close">;

export function wrapPglite(pg: PgliteLike): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await pg.query<T>(sql, params);
      return { rows: r.rows };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction(async (t) =>
        fn({
          async query<R>(sql: string, params: unknown[] = []) {
            const r = await t.query<R>(sql, params);
            return { rows: r.rows };
          },
          async exec(sql: string) {
            await t.exec(sql);
          },
        }),
      );
    },
    async close() {
      await pg.close();
    },
  };
}
