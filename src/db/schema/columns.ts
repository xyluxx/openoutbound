import { customType, text, timestamp } from "drizzle-orm/pg-core";
import { type IdPrefix, newId } from "../../core/ids.js";

/**
 * Column helpers shared by every schema file (spec section 7 conventions). Property names are
 * snake_case, identical to the SQL columns and the API fields, so rows map to outputs 1:1.
 */

/** Text primary key filled by `newId(prefix)` when not provided. */
export const idColumn = (prefix: IdPrefix) =>
  text("id")
    .primaryKey()
    .$defaultFn(() => newId(prefix));

/** timestamp with time zone, mode date. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const createdAt = () => tstz("created_at").notNull().defaultNow();

/** Defaults to now() and is refreshed by drizzle on every update. */
export const updatedAt = () =>
  tstz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Postgres tsvector (full-text search). Read as text; normally only used in SQL. */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
