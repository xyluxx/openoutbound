/**
 * Small database helpers for scenario setups and checks (direct Drizzle access to the eval
 * database; never used by the agent).
 */
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../../src/db/client.js";
import {
  companies,
  enrollments,
  messages,
  opportunities,
  type Person,
  people,
  suppressions,
  tasks,
  threads,
} from "../../src/db/schema/index.js";

/** People with a valid email and status new, oldest first (sandbox fixtures). */
export async function contactablePeople(
  db: Db,
  workspaceId: string,
  limit: number,
): Promise<Person[]> {
  const suppressed = await db
    .select({ value: suppressions.value })
    .from(suppressions)
    .where(eq(suppressions.workspace_id, workspaceId));
  const blocked = new Set(suppressed.map((row) => row.value));
  const rows = await db
    .select()
    .from(people)
    .where(
      and(
        eq(people.workspace_id, workspaceId),
        eq(people.status, "new"),
        eq(people.email_status, "valid"),
        isNotNull(people.email),
        isNotNull(people.company_id),
      ),
    )
    .orderBy(asc(people.id));
  return rows
    .filter((row) => !blocked.has(row.email ?? "") && !blocked.has(row.id))
    .slice(0, limit);
}

/** Removes messages, threads, opportunities, tasks and enrollments of a workspace. */
export async function clearActivity(db: Db, workspaceId: string): Promise<void> {
  await db.delete(messages).where(eq(messages.workspace_id, workspaceId));
  await db.delete(threads).where(eq(threads.workspace_id, workspaceId));
  await db.delete(opportunities).where(eq(opportunities.workspace_id, workspaceId));
  await db.delete(tasks).where(eq(tasks.workspace_id, workspaceId));
  await db.delete(enrollments).where(eq(enrollments.workspace_id, workspaceId));
}

/** Row count of a query builder result (`select({ n: count() })`). */
export async function countOf(rows: Promise<Array<{ n: number }>>): Promise<number> {
  const [row] = await rows;
  return Number(row?.n ?? 0);
}

/** Outbound messages of a workspace that reached a send state (sending, sent, bounced). */
export async function sentMessages(db: Db, workspaceId: string) {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspaceId),
        eq(messages.direction, "outbound"),
        inArray(messages.status, ["scheduled", "sending", "sent", "bounced"]),
      ),
    );
}

/** Company name by id. */
export async function companyName(db: Db, companyId: string | null): Promise<string | null> {
  if (!companyId) return null;
  const [row] = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId));
  return row?.name ?? null;
}
