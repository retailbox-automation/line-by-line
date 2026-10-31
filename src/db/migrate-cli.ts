// npm run migrate — applies pending migrations to DATABASE_URL (or a PGlite directory in PGLITE_DIR).
import { migrate, openDb } from "./index.js";

const db = await openDb();
try {
  const applied = await migrate(db);
  console.log(applied.length ? `applied migrations: ${applied.join(", ")}` : "no pending migrations");
} finally {
  await db.close();
}
