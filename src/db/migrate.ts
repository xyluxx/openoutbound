import { fileURLToPath } from "node:url";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { DbHandle, Schema } from "./client.js";

/** The generated SQL migrations (`drizzle/`), resolved the same way from src/ and dist/. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Stable advisory lock id so concurrent processes never migrate Postgres at the same time. */
const MIGRATION_LOCK_ID = 7_070_001;

/** Applies pending migrations with the migrator matching the driver. Safe to call on every start. */
export async function migrate(
  handle: Pick<DbHandle, "db" | "driver" | "pool">,
  options: { migrationsFolder?: string } = {},
): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  if (handle.driver === "pglite") {
    const { migrate: migratePglite } = await import("drizzle-orm/pglite/migrator");
    await migratePglite(handle.db as unknown as PgliteDatabase<Schema>, { migrationsFolder });
    return;
  }
  const { migrate: migratePg } = await import("drizzle-orm/node-postgres/migrator");
  const lockClient = handle.pool ? await handle.pool.connect() : null;
  try {
    await lockClient?.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await migratePg(handle.db as unknown as NodePgDatabase<Schema>, { migrationsFolder });
  } finally {
    if (lockClient) {
      await lockClient.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
      lockClient.release();
    }
  }
}
