import { mkdirSync } from "node:fs";
import type { PGlite, PGliteInterface } from "@electric-sql/pglite";
import type { SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import type { DatabaseConfig } from "../core/config.js";
import { acquirePgliteLock } from "./pglite-lock.js";
import * as schema from "./schema/index.js";

export type Schema = typeof schema;

/**
 * The database type every module uses. Works with both drivers (node-postgres and PGlite) and
 * with transactions (`db.transaction(async (tx) => ...)`, tx is also a Db).
 * `db.query.<table>.findFirst/findMany` is available (schema registered, no relations).
 */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export type DbDriver = "pg" | "pglite";

export interface DbHandle {
  db: Db;
  driver: DbDriver;
  close(): Promise<void>;
  /** Underlying PGlite instance (pglite driver only). */
  pglite?: PGliteInterface;
  /** Underlying pg pool (pg driver only). */
  pool?: Pool;
}

/**
 * Opens the database described by `config.database`: Postgres through a pg Pool, PGlite on disk
 * (directory created if missing) or PGlite in memory. Does not migrate; call `migrate(handle)`.
 */
export async function createDb(config: { database: DatabaseConfig }): Promise<DbHandle> {
  const database = config.database;
  if (database.kind === "postgres") {
    const [{ default: pg }, { drizzle }] = await Promise.all([
      import("pg"),
      import("drizzle-orm/node-postgres"),
    ]);
    const pool = new pg.Pool({ connectionString: database.url, max: 10 });
    const db = drizzle({ client: pool, schema }) as unknown as Db;
    return {
      db,
      driver: "pg",
      pool,
      close: async () => {
        await pool.end();
      },
    };
  }
  const { PGlite: PGliteClass } = await import("@electric-sql/pglite");
  if (database.kind === "pglite") {
    mkdirSync(database.dataDir, { recursive: true });
    const release = acquirePgliteLock(database.dataDir);
    let handle: DbHandle;
    try {
      handle = await wrapPglite(await PGliteClass.create(database.dataDir));
    } catch (error) {
      release();
      throw error;
    }
    const close = handle.close;
    return {
      ...handle,
      close: async () => {
        try {
          await close();
        } finally {
          release();
        }
      },
    };
  }
  return wrapPglite(await PGliteClass.create());
}

/** Wraps an existing PGlite instance (e.g. a test clone) in a DbHandle. */
export async function wrapPglite(client: PGliteInterface): Promise<DbHandle> {
  const { drizzle } = await import("drizzle-orm/pglite");
  const db = drizzle({ client: client as PGlite, schema }) as unknown as Db;
  return {
    db,
    driver: "pglite",
    pglite: client,
    close: async () => {
      if (!client.closed) await client.close();
    },
  };
}

/**
 * Runs a raw SQL query and returns its rows with either driver (both return `{ rows }`).
 * Prefer the query builder; use this for SQL it cannot express.
 */
export async function queryRows<T>(db: Db, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows?: T[] };
  return result.rows ?? [];
}
