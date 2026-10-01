/**
 * Upgrade path: a database migrated with only the v0.1 migration (0000) takes the later ones cleanly,
 * keeps its rows (new columns get their defaults) and accepts rows in every new table.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle, queryRows } from "./client.js";
import { MIGRATIONS_FOLDER, migrate } from "./migrate.js";
import {
  change_log,
  change_proposals,
  companies,
  event_consumers,
  lead_facts,
  mailboxes,
  meetings,
  messages,
  people,
  problems,
  threads,
  workspaces,
} from "./schema/index.js";

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

/** A copy of the migrations folder that stops after the first (v0.1) migration. */
function v01MigrationsFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "oo-migrations-v01-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  const first = journal.entries.filter((entry) => entry.idx === 0);
  expect(first.map((entry) => entry.tag)).toEqual(["0000_initial"]);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: first }));
  copyFileSync(join(MIGRATIONS_FOLDER, "0000_initial.sql"), join(dir, "0000_initial.sql"));
  return dir;
}

let handle: DbHandle;
let v01Folder: string;

beforeAll(async () => {
  v01Folder = v01MigrationsFolder();
  handle = await createDb({ database: { kind: "memory" } });
});

afterAll(async () => {
  await handle?.close();
  rmSync(v01Folder, { recursive: true, force: true });
});

describe("migrations", () => {
  it("upgrades a v0.1 database to the current schema without touching its data", async () => {
    const { db } = handle;
    await migrate(handle, { migrationsFolder: v01Folder });
    const before = await queryRows<{ meetings: string | null }>(
      db,
      sql`select to_regclass('public.meetings')::text as meetings`,
    );
    expect(before[0]?.meetings).toBeNull();

    // v0.1 rows, written with raw SQL because the new columns do not exist yet.
    await db.execute(sql`insert into workspaces (id, slug, name) values ('ws_v01', 'v01', 'V01')`);
    await db.execute(
      sql`insert into companies (id, workspace_id, name, domain) values ('co_v01', 'ws_v01', 'Harbor Dental', 'harbor.example.com')`,
    );
    await db.execute(
      sql`insert into people (id, workspace_id, company_id, email) values ('pe_v01', 'ws_v01', 'co_v01', 'dana@harbor.example.com')`,
    );
    await db.execute(
      sql`insert into threads (id, workspace_id, person_id, channel) values ('thr_v01', 'ws_v01', 'pe_v01', 'email')`,
    );
    await db.execute(
      sql`insert into messages (id, workspace_id, thread_id, channel, action, direction, status) values ('msg_v01', 'ws_v01', 'thr_v01', 'email', 'email', 'outbound', 'sent')`,
    );
    await db.execute(
      sql`insert into mailboxes (id, workspace_id, email) values ('mbx_v01', 'ws_v01', 'sam@example.org')`,
    );

    await migrate(handle);

    const applied = await queryRows<{ n: number }>(
      db,
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
    ) as Journal;
    expect(applied[0]?.n).toBe(journal.entries.length);

    const [thread] = await db.select().from(threads).where(eq(threads.id, "thr_v01"));
    expect(thread?.owner).toBe("engine");
    expect(thread?.owner_changed_at).toBeNull();
    const [message] = await db.select().from(messages).where(eq(messages.id, "msg_v01"));
    expect(message?.origin).toBe("engine");
    expect(message?.reconcile_checks).toBe(0);
    expect(message?.dispatch_started_at).toBeNull();
    const [company] = await db.select().from(companies).where(eq(companies.id, "co_v01"));
    expect(company?.crm_open_deal).toBe(false);
    expect(company?.hold_until).toBeNull();
    const [person] = await db.select().from(people).where(eq(people.id, "pe_v01"));
    expect(person?.booking_ref).toBeNull();
    const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, "mbx_v01"));
    expect(mailbox?.saves_sent_copies).toBeNull();

    // One row in each new table.
    const [meeting] = await db
      .insert(meetings)
      .values({
        workspace_id: "ws_v01",
        person_id: "pe_v01",
        source: "manual",
        matched_by: "manual",
      })
      .returning();
    expect(meeting?.id).toMatch(/^mt_/);
    expect(meeting?.status).toBe("scheduled");

    const [fact] = await db
      .insert(lead_facts)
      .values({
        workspace_id: "ws_v01",
        person_id: "pe_v01",
        scope: "person",
        kind: "timing",
        text: "Budget planning starts in November.",
        source: "manual",
        observed_at: new Date("2026-09-27T10:00:00Z"),
      })
      .returning();
    expect(fact?.id).toMatch(/^lf_/);
    expect(fact?.status).toBe("active");

    const [problem] = await db
      .insert(problems)
      .values({
        workspace_id: "ws_v01",
        kind: "send_unknown",
        severity: "high",
        title: "Check one send",
        reason: "The mailbox timed out after the message was handed over.",
        remedy: "Check the Sent folder.",
      })
      .returning();
    expect(problem?.id).toMatch(/^pb_/);
    expect(problem?.owner).toBe("anyone");
    expect(problem?.status).toBe("open");
    expect(problem?.data).toEqual({});

    const [change] = await db
      .insert(change_log)
      .values({
        workspace_id: "ws_v01",
        version: 1,
        area: "settings",
        diff: [{ path: "booking.mode", before: "link", after: "handoff" }],
      })
      .returning();
    expect(change?.id).toMatch(/^chg_/);

    const [proposal] = await db
      .insert(change_proposals)
      .values({
        workspace_id: "ws_v01",
        title: "Hand meetings to a person",
        reason: "The client books by phone.",
        operation: "workspaces.update",
        input: { settings: { booking: { mode: "handoff" } } },
      })
      .returning();
    expect(proposal?.id).toMatch(/^prop_/);
    expect(proposal?.status).toBe("proposed");
    expect(proposal?.evidence).toEqual([]);

    const [consumer] = await db
      .insert(event_consumers)
      .values({ workspace_id: "ws_v01", name: "crm" })
      .returning();
    expect(consumer?.cursor).toBeNull();

    // Running the migrations again is a no-op.
    await migrate(handle);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, "ws_v01"));
    expect(ws?.slug).toBe("v01");
  });

  it("migrates a fresh database in one go", async () => {
    const fresh = await createDb({ database: { kind: "memory" } });
    try {
      await migrate(fresh);
      const tables = await queryRows<{ tablename: string }>(
        fresh.db,
        sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
      );
      const names = tables.map((row) => row.tablename);
      for (const table of [
        "meetings",
        "lead_facts",
        "problems",
        "change_log",
        "change_proposals",
        "event_consumers",
        "crm_webhooks",
      ]) {
        expect(names).toContain(table);
      }
    } finally {
      await fresh.close();
    }
  });
});
