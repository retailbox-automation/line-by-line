import pg from "pg";
import type { Db, Queryable } from "./db.js";

/** Production database: a pg.Pool over DATABASE_URL. */
export function createPgDb(connectionString: string, poolSize = 5): Db {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString, max: poolSize });
  pool.on("error", (e) => console.error(`postgres pool error: ${e.message}`));

  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await c.query(sql, params);
      return { rows: r.rows as T[] };
    },
    async exec(sql: string) {
      await c.query(sql);
    },
  });

  return {
    ...wrap(pool),
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
