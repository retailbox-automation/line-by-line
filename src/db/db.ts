// The database seam: Postgres through pg.Pool in production, PGlite in tests. Both speak the same SQL.

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Several statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /**
   * Runs `fn` in one transaction. Inside, use only the `q` passed in: on PGlite a query on the outer Db waits
   * for the transaction to end, so it would deadlock.
   */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
