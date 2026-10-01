import type { PGliteInterface } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { createDb, type Db, type DbHandle, queryRows, wrapPglite } from "../db/client.js";
import { migrate } from "../db/migrate.js";

/** A migrated in-memory PGlite database. Call `close()` in afterAll/afterEach. */
export interface TestDb extends DbHandle {
  driver: "pglite";
  pglite: PGliteInterface;
}

let template: Promise<PGliteInterface> | undefined;

/** Builds (once per test process) an in-memory database with every migration applied. */
function migratedTemplate(): Promise<PGliteInterface> {
  template ??= (async () => {
    const handle = await createDb({ database: { kind: "memory" } });
    await migrate(handle);
    if (!handle.pglite) throw new Error("createTestDb: expected a PGlite handle");
    return handle.pglite;
  })();
  return template;
}

/**
 * Fresh in-memory PGlite with the full schema. Fast: migrations run once per test process
 * and every call clones that template.
 */
export async function createTestDb(): Promise<TestDb> {
  const base = await migratedTemplate();
  const clone = await base.clone();
  return (await wrapPglite(clone)) as TestDb;
}

/** Empties every table (keeps the schema and migration history). */
export async function truncateAll(db: Db): Promise<void> {
  const tables = await queryRows<{ tablename: string }>(
    db,
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename.replaceAll('"', '""')}"`).join(", ");
  await db.execute(sql.raw(`truncate table ${list} restart identity cascade`));
}
