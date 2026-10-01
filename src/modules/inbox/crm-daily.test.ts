import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import {
  crm_links,
  event_consumers,
  events,
  type NewEventRow,
  type Person,
  workspaces,
} from "../../db/schema/index.js";
import type { CrmActivity, CrmProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedPerson } from "../../testing/factories.js";
import { listConsumers } from "../system/event-feed.js";
import {
  CRM_CONSUMER,
  CRM_DAILY_JOB,
  crmDailyJob,
  crmDailySchedule,
  readReplayPosition,
  replayCrmEvents,
} from "./crm-daily.js";
import { writeLink } from "./crm-sync.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

type CrmSettings = NonNullable<WorkspaceSettingsInput["crm"]>;
const HOUR = 3_600_000;

function fakeCrm() {
  let n = 0;
  return {
    id: "hubspot",
    upsertContact: vi.fn(async () => ({ contactId: "c-1" })),
    upsertDeal: vi.fn(async () => ({ dealId: "d-1" })),
    logActivity: vi.fn(async (_entry: CrmActivity) => {
      n += 1;
      return { activityId: `note-${n}` };
    }),
  } satisfies CrmProvider;
}

interface Setup {
  ctx: TestContext;
  crm: ReturnType<typeof fakeCrm>;
  person: Person;
}

async function setup(
  settings: CrmSettings = { timing: "daily", log: "key_moments" },
  crms?: CrmProvider[],
): Promise<Setup> {
  const crm = fakeCrm();
  const ctx = await createTestContext({
    db: testDb,
    providers: { crm: crms ?? [crm] },
    settings: { crm: settings },
  });
  const person = await seedPerson(ctx);
  await writeLink(ctx, "hubspot", "person", person.id, "c-1");
  return { ctx, crm, person };
}

/** A stored meeting event `hoursAgo` before the test clock (a no-show note each). */
async function storeEvent(t: Setup, hoursAgo: number, overrides: Partial<NewEventRow> = {}) {
  const [row] = await t.ctx.db
    .insert(events)
    .values({
      workspace_id: t.ctx.workspace.id,
      type: "meeting.no_show",
      subject_type: "meeting",
      subject_id: "mtg_1",
      data: { meeting_id: "mtg_1", person_id: t.person.id, opportunity_id: null },
      occurred_at: new Date(t.ctx.clock.now().getTime() - hoursAgo * HOUR),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("no event");
  return row;
}

/** Ids of the events written to the CRM as notes (sorted). */
async function loggedEventIds(t: Setup): Promise<string[]> {
  const rows = await t.ctx.db
    .select()
    .from(crm_links)
    .where(
      and(eq(crm_links.workspace_id, t.ctx.workspace.id), eq(crm_links.entity_type, "activity")),
    );
  return rows.map((row) => row.entity_id).sort();
}

async function setCrm(t: Setup, crm: CrmSettings): Promise<void> {
  await t.ctx.db
    .update(workspaces)
    .set({ settings: { crm } })
    .where(eq(workspaces.id, t.ctx.workspace.id));
  await t.ctx.reloadWorkspace();
}

describe("replayCrmEvents", () => {
  it("replays the last day on the first run, then only what came after its position", async () => {
    const t = await setup();
    await storeEvent(t, 30); // older than the first run's 24 hours
    const e1 = await storeEvent(t, 5);
    await storeEvent(t, 3, { type: "reply.received", data: {} }); // not a CRM event
    const e2 = await storeEvent(t, 1);
    const other = await createTestContext({ db: testDb });
    await other.db.insert(events).values({
      workspace_id: other.workspace.id,
      type: "meeting.no_show",
      data: { meeting_id: "mtg_2", person_id: t.person.id, opportunity_id: null },
      occurred_at: new Date(t.ctx.clock.now().getTime() - 2 * HOUR),
    });

    const first = await replayCrmEvents(t.ctx);
    expect(first).toEqual({
      status: "done",
      reason: null,
      processed: 2,
      position_at: e2.occurred_at.toISOString(),
    });
    expect(await loggedEventIds(t)).toEqual([e1.id, e2.id].sort());
    expect(t.crm.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "meeting", subject: "no-show", contactId: "c-1" }),
    );
    expect(await readReplayPosition(t.ctx)).toEqual({
      at: e2.occurred_at.toISOString(),
      id: e2.id,
    });
    const [consumer] = await t.ctx.db
      .select()
      .from(event_consumers)
      .where(eq(event_consumers.workspace_id, t.ctx.workspace.id));
    expect(consumer).toMatchObject({ name: CRM_CONSUMER });
    // The change feed reads the same position (event_feed action consumers).
    const listed = await listConsumers(t.ctx, { limit: 10 });
    expect(listed.items).toEqual([
      expect.objectContaining({
        name: CRM_CONSUMER,
        position_at: e2.occurred_at.toISOString(),
        gap: false,
      }),
    ]);

    expect(await replayCrmEvents(t.ctx)).toMatchObject({ status: "done", processed: 0 });
    const e3 = await storeEvent(t, 0.5);
    expect(await replayCrmEvents(t.ctx)).toMatchObject({ status: "done", processed: 1 });
    expect(await loggedEventIds(t)).toEqual([e1.id, e2.id, e3.id].sort());
    expect(t.crm.logActivity).toHaveBeenCalledTimes(3);
  });

  it("walks events of the same moment by id and continues in a follow-up job past its limit", async () => {
    const t = await setup();
    const same = [await storeEvent(t, 2), await storeEvent(t, 2), await storeEvent(t, 2)];
    const later = await storeEvent(t, 1);

    const first = await replayCrmEvents(t.ctx, { maxEvents: 2 });
    expect(first).toMatchObject({ status: "more", processed: 2 });
    expect(t.ctx.enqueued(CRM_DAILY_JOB)[0]?.options.singletonKey).toBe(
      `${CRM_DAILY_JOB}:more:${t.ctx.workspace.id}`,
    );
    const byId = same.map((row) => row.id).sort();
    expect(await readReplayPosition(t.ctx)).toMatchObject({ id: byId[1] });

    await replayCrmEvents(t.ctx, { maxEvents: 2 });
    expect(await replayCrmEvents(t.ctx, { maxEvents: 2 })).toMatchObject({
      status: "done",
      processed: 0,
    });
    expect(await loggedEventIds(t)).toEqual([...byId, later.id].sort());
    expect(t.crm.logActivity).toHaveBeenCalledTimes(4);
  });

  it("never skips an event later in the same millisecond with a smaller id", async () => {
    const t = await setup();
    const at = new Date(t.ctx.clock.now().getTime() - 2 * HOUR);
    const early = await storeEvent(t, 0, { id: "evt_zzzzzzzzzzzzzzzzzzzz", occurred_at: at });
    const late = await storeEvent(t, 0, { id: "evt_aaaaaaaaaaaaaaaaaaaa", occurred_at: at });
    await t.ctx.db.execute(
      sql`update ${events} set occurred_at = occurred_at + interval '300 microseconds' where id = ${late.id}`,
    );
    expect(await replayCrmEvents(t.ctx, { maxEvents: 1 })).toMatchObject({
      status: "more",
      processed: 1,
    });
    expect(await replayCrmEvents(t.ctx)).toMatchObject({ status: "done", processed: 1 });
    expect(await loggedEventIds(t)).toEqual([early.id, late.id].sort());
  });

  it("moves its position past newer events it does not use", async () => {
    const t = await setup();
    const note = await storeEvent(t, 3);
    const other = await storeEvent(t, 2, {
      type: "campaign.launched",
      subject_type: "campaign",
      subject_id: "cmp_1",
      data: { campaign_id: "cmp_1" },
    });
    expect(await replayCrmEvents(t.ctx)).toMatchObject({
      status: "done",
      processed: 1,
      position_at: other.occurred_at.toISOString(),
    });
    expect(await loggedEventIds(t)).toEqual([note.id]);
    expect(await readReplayPosition(t.ctx)).toEqual({
      at: other.occurred_at.toISOString(),
      id: other.id,
    });
    // Nothing new: the next run reads nothing and stays put.
    expect(await replayCrmEvents(t.ctx)).toMatchObject({ status: "done", processed: 0 });
    expect(t.crm.logActivity).toHaveBeenCalledTimes(1);
  });

  it("keeps its position at an event that fails for a temporary reason", async () => {
    const t = await setup();
    const e1 = await storeEvent(t, 3);
    const e2 = await storeEvent(t, 2);
    const e3 = await storeEvent(t, 1);
    t.crm.logActivity
      .mockResolvedValueOnce({ activityId: "note-a" })
      .mockRejectedValueOnce(new Error("socket hang up"));

    await expect(replayCrmEvents(t.ctx)).rejects.toMatchObject({ code: "provider_error" });
    expect(await readReplayPosition(t.ctx)).toEqual({
      at: e1.occurred_at.toISOString(),
      id: e1.id,
    });

    expect(await replayCrmEvents(t.ctx)).toMatchObject({ status: "done", processed: 2 });
    expect(await loggedEventIds(t)).toEqual([e1.id, e2.id, e3.id].sort());
  });

  it("only forgets its position while the built-in sync is not daily", async () => {
    const t = await setup();
    await storeEvent(t, 1);
    await replayCrmEvents(t.ctx);
    expect(await readReplayPosition(t.ctx)).not.toBeNull();

    await setCrm(t, { timing: "live", log: "key_moments" });
    expect(await replayCrmEvents(t.ctx)).toEqual({
      status: "skipped",
      reason: "timing_live",
      processed: 0,
      position_at: null,
    });
    expect(await readReplayPosition(t.ctx)).toBeNull();

    await setCrm(t, { mode: "agent", timing: "daily" });
    expect(await replayCrmEvents(t.ctx)).toMatchObject({ status: "skipped", reason: "mode_agent" });
    expect(t.crm.logActivity).toHaveBeenCalledTimes(1);

    const none = await setup({ timing: "daily" }, []);
    expect(await replayCrmEvents(none.ctx)).toMatchObject({
      status: "skipped",
      reason: "no_crm_provider",
    });
  });

  it("starts 24 hours back when its stored position cannot be read", async () => {
    const t = await setup();
    await t.ctx.db
      .insert(event_consumers)
      .values({ workspace_id: t.ctx.workspace.id, name: CRM_CONSUMER, cursor: "not-a-cursor" });
    expect(await readReplayPosition(t.ctx)).toBeNull();
    await storeEvent(t, 30);
    const recent = await storeEvent(t, 4);
    expect(await replayCrmEvents(t.ctx)).toMatchObject({ processed: 1 });
    expect(await loggedEventIds(t)).toEqual([recent.id]);
  });
});

describe("crm daily job", () => {
  it("runs the replay for the job's workspace once a day", async () => {
    const t = await setup();
    await storeEvent(t, 1);
    expect(await crmDailyJob.handler(t.ctx.jobContext(), {})).toMatchObject({
      status: "done",
      processed: 1,
    });
    expect(crmDailySchedule).toMatchObject({
      job: CRM_DAILY_JOB,
      perWorkspace: true,
      cron: "40 2 * * *",
    });
  });
});
