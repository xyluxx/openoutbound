import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReplyCategory } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import type { EmittedEvent } from "../../core/events.js";
import { providerFailure } from "../../core/failures.js";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import {
  type Company,
  crm_links,
  type NewMessage,
  opportunities,
  type Person,
  problems,
  type Thread,
} from "../../db/schema/index.js";
import type { CrmActivity, CrmProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCompany, seedMessage, seedPerson, seedThread } from "../../testing/factories.js";
import {
  type CrmEvent,
  crmOnMeetingBooked,
  crmOnMessageSent,
  crmOnReplyClassified,
  processCrmEvent,
} from "./crm-events.js";
import { CRM_SYNC_JOB, writeLink } from "./crm-sync.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

type CrmSettings = NonNullable<WorkspaceSettingsInput["crm"]>;

function fakeCrm(id = "hubspot") {
  let n = 0;
  const crm = {
    id,
    upsertContact: vi.fn(async (_person, company, existing) => {
      n += 1;
      const contactId = existing?.contactId ?? `contact-${n}`;
      return company
        ? { contactId, companyId: existing?.companyId ?? `company-${n}` }
        : { contactId };
    }),
    upsertDeal: vi.fn(async (_opportunity, links, _options) => ({
      dealId: links.dealId ?? "deal-new",
    })),
    logActivity: vi.fn(async (_entry: CrmActivity) => {
      n += 1;
      return { activityId: `note-${n}` };
    }),
  } satisfies CrmProvider;
  return crm;
}

interface Setup {
  ctx: TestContext;
  crm: ReturnType<typeof fakeCrm>;
  company: Company;
  person: Person;
  thread: Thread;
}

async function setup(settings: CrmSettings = {}, crm = fakeCrm()): Promise<Setup> {
  const ctx = await createTestContext({
    db: testDb,
    providers: { crm: [crm] },
    settings: { crm: settings },
  });
  const company = await seedCompany(ctx, { name: "Harbor Dental" });
  const person = await seedPerson(ctx, { company_id: company.id });
  const thread = await seedThread(ctx, { person_id: person.id, company_id: company.id });
  return { ctx, crm, company, person, thread };
}

/** The person already has a contact in the CRM. */
async function linkContact(t: Setup, contactId = "c-1"): Promise<void> {
  await writeLink(t.ctx, t.crm.id, "person", t.person.id, contactId);
}

let eventCounter = 0;
const nextEventId = () => `evt_test_${++eventCounter}`;

async function replyEvent(
  t: Setup,
  category: ReplyCategory,
  overrides: Partial<NewMessage> = {},
): Promise<CrmEvent> {
  const message = await seedMessage(t.ctx, {
    thread_id: t.thread.id,
    person_id: t.person.id,
    direction: "inbound",
    status: "received",
    action: "reply",
    subject: "Re: Quick question",
    body_text: "Could you share pricing for two clinics?",
    received_at: new Date("2026-09-19T10:00:00Z"),
    classification: { category, confidence: 0.9, summary: "Asks about pricing for two clinics" },
    ...overrides,
  });
  return {
    id: nextEventId(),
    type: "reply.classified",
    data: {
      message_id: message.id,
      thread_id: t.thread.id,
      person_id: t.person.id,
      category,
      confidence: 0.9,
    },
    occurredAt: t.ctx.clock.now(),
  };
}

async function sentEvent(t: Setup, overrides: Partial<NewMessage> = {}): Promise<CrmEvent> {
  const message = await seedMessage(t.ctx, {
    thread_id: t.thread.id,
    person_id: t.person.id,
    status: "sent",
    subject: "Scheduling at Harbor Dental",
    body_text: "Hi Dana, a short note about no-shows.",
    sent_at: new Date("2026-09-19T09:00:00Z"),
    ...overrides,
  });
  return {
    id: nextEventId(),
    type: "message.sent",
    data: {
      message_id: message.id,
      thread_id: t.thread.id,
      person_id: t.person.id,
      campaign_id: null,
      channel: message.channel,
      action: message.action,
      sent_at: "2026-09-19T09:00:00.000Z",
    },
    occurredAt: t.ctx.clock.now(),
  };
}

async function seedOpportunity(t: Setup) {
  const [row] = await t.ctx.db
    .insert(opportunities)
    .values({
      workspace_id: t.ctx.workspace.id,
      person_id: t.person.id,
      company_id: t.company.id,
      stage: "meeting_booked",
    })
    .returning();
  if (!row) throw new Error("no opportunity");
  return row;
}

async function activityMarkers(t: Setup) {
  return t.ctx.db
    .select()
    .from(crm_links)
    .where(
      and(eq(crm_links.workspace_id, t.ctx.workspace.id), eq(crm_links.entity_type, "activity")),
    );
}

async function syncProblems(t: Setup) {
  return t.ctx.db
    .select()
    .from(problems)
    .where(
      and(eq(problems.workspace_id, t.ctx.workspace.id), eq(problems.kind, "crm_sync_failed")),
    );
}

describe("processCrmEvent: modes and sync_from", () => {
  it("never pushes anything in agent or off mode", async () => {
    for (const mode of ["agent", "off"] as const) {
      const t = await setup({ mode, sync_from: "contacted", log: "everything" });
      const reply = await processCrmEvent(t.ctx, await replyEvent(t, "interested"));
      const sent = await processCrmEvent(t.ctx, await sentEvent(t));
      expect(reply).toMatchObject({ skipped: `mode_${mode}`, providers: [] });
      expect(sent).toMatchObject({ skipped: `mode_${mode}`, providers: [] });
      expect(t.crm.upsertContact).not.toHaveBeenCalled();
      expect(t.crm.logActivity).not.toHaveBeenCalled();
    }
  });

  it("by default leaves replies to the deal sync: no contact, no note", async () => {
    const t = await setup();
    for (const category of ["question", "interested"] as const) {
      expect(await processCrmEvent(t.ctx, await replyEvent(t, category))).toMatchObject({
        skipped: "nothing_to_sync",
      });
    }
    expect(await processCrmEvent(t.ctx, await sentEvent(t))).toMatchObject({
      skipped: "nothing_to_sync",
    });
    expect(t.crm.upsertContact).not.toHaveBeenCalled();
  });

  it("sync_from replied creates the contact on the first human reply, once", async () => {
    const t = await setup({ sync_from: "replied" });
    const first = await processCrmEvent(t.ctx, await replyEvent(t, "question"));
    expect(first.providers).toEqual([
      { provider: "hubspot", contact: "created", note: "not_needed", error: null },
    ]);
    const links = await t.ctx.db
      .select()
      .from(crm_links)
      .where(eq(crm_links.workspace_id, t.ctx.workspace.id));
    expect(links.map((row) => `${row.entity_type}:${row.external_id}`).sort()).toEqual([
      "company:company-1",
      "person:contact-1",
    ]);

    const second = await processCrmEvent(t.ctx, await replyEvent(t, "not_now"));
    expect(second.providers[0]).toMatchObject({ contact: "linked", note: "not_needed" });
    expect(t.crm.upsertContact).toHaveBeenCalledTimes(1);
    // The engine's own sends do not count under replied.
    expect(await processCrmEvent(t.ctx, await sentEvent(t))).toMatchObject({
      skipped: "nothing_to_sync",
    });
  });

  it("never creates a contact for automatic replies, unsubscribes or privacy requests", async () => {
    const t = await setup({ sync_from: "replied", log: "everything" });
    for (const category of ["bounce", "out_of_office", "auto_reply_other"] as const) {
      expect(await processCrmEvent(t.ctx, await replyEvent(t, category))).toMatchObject({
        skipped: "automatic_reply",
      });
    }
    const unsubscribe = await processCrmEvent(t.ctx, await replyEvent(t, "unsubscribe"));
    expect(unsubscribe.providers[0]).toMatchObject({ contact: "missing", note: "no_contact" });
    expect(t.crm.upsertContact).not.toHaveBeenCalled();

    // Nothing about a privacy request reaches a CRM, not even a note on a known contact.
    await linkContact(t);
    expect(await processCrmEvent(t.ctx, await replyEvent(t, "privacy_request"))).toMatchObject({
      skipped: "privacy_request",
      providers: [],
    });
    expect(t.crm.logActivity).not.toHaveBeenCalled();
  });

  it("sync_from contacted creates the contact on the first engine send only", async () => {
    const t = await setup({ sync_from: "contacted" });
    expect(await processCrmEvent(t.ctx, await sentEvent(t, { origin: "external" }))).toMatchObject({
      skipped: "not_sent_by_engine",
    });
    expect(
      await processCrmEvent(
        t.ctx,
        await sentEvent(t, { channel: "linkedin", action: "visit", subject: null }),
      ),
    ).toMatchObject({ skipped: "nothing_to_sync" });
    expect(t.crm.upsertContact).not.toHaveBeenCalled();

    const sent = await processCrmEvent(t.ctx, await sentEvent(t));
    expect(sent.providers[0]).toMatchObject({ contact: "created", note: "not_needed" });
    expect(t.crm.upsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.person.id }),
      expect.objectContaining({ id: t.company.id }),
      { contactId: undefined, companyId: undefined },
    );
  });
});

describe("processCrmEvent: what is logged", () => {
  it("key_moments logs a reply's category and summary, never its text", async () => {
    const t = await setup({ log: "key_moments" });
    await linkContact(t);
    const result = await processCrmEvent(
      t.ctx,
      await replyEvent(t, "question", { body_text: "PRIVATE-WORDS from the prospect" }),
    );
    expect(result.providers[0]).toMatchObject({ contact: "linked", note: "logged" });
    expect(t.crm.logActivity).toHaveBeenCalledWith({
      kind: "reply",
      subject: "Question",
      body: "Asks about pricing for two clinics",
      occurredAt: new Date("2026-09-19T10:00:00Z"),
      contactId: "c-1",
      dealId: null,
      companyId: null,
    });
    expect(JSON.stringify(t.crm.logActivity.mock.calls)).not.toContain("PRIVATE-WORDS");
    // Sends are not key moments.
    expect(await processCrmEvent(t.ctx, await sentEvent(t))).toMatchObject({
      skipped: "nothing_to_sync",
    });
  });

  it("key_moments: a hot reply creates the contact even under sync_from interested", async () => {
    const t = await setup({ log: "key_moments" });
    const hot = await processCrmEvent(t.ctx, await replyEvent(t, "meeting_request"));
    expect(hot.providers[0]).toMatchObject({ contact: "created", note: "logged" });
    // A lukewarm reply from someone the CRM does not have is not logged anywhere.
    const other = await setup({ log: "key_moments" });
    const cold = await processCrmEvent(other.ctx, await replyEvent(other, "question"));
    expect(cold.providers[0]).toMatchObject({ contact: "missing", note: "no_contact" });
    expect(other.crm.upsertContact).not.toHaveBeenCalled();
  });

  it("everything copies the subject and the reply's own words, cut to 2000 characters", async () => {
    const t = await setup({ log: "everything" });
    await linkContact(t);
    await processCrmEvent(
      t.ctx,
      await replyEvent(t, "interested", {
        body_text:
          "Yes, send the deck.\n\nOn Mon, Sep 14, 2026 at 9:00 AM Sam wrote:\n> Hi Dana, short note",
        classification: { category: "interested", confidence: 0.95, summary: "Wants the deck" },
      }),
    );
    const note = t.crm.logActivity.mock.calls[0]?.[0];
    expect(note).toMatchObject({
      kind: "email_received",
      subject: "Re: Quick question",
      body: "Sorted as: Interested. Wants the deck\n\nYes, send the deck.",
    });

    await processCrmEvent(t.ctx, await replyEvent(t, "question", { body_text: "x".repeat(5000) }));
    const long = t.crm.logActivity.mock.calls[1]?.[0];
    expect(long?.body?.length).toBe(2000);
    expect(long?.body?.endsWith("...")).toBe(true);
  });

  it("everything logs every engine email sent, but not LinkedIn sends", async () => {
    const t = await setup({ log: "everything" });
    await linkContact(t);
    const result = await processCrmEvent(t.ctx, await sentEvent(t));
    expect(result.providers[0]).toMatchObject({ contact: "linked", note: "logged" });
    expect(t.crm.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "email_sent",
        subject: "Scheduling at Harbor Dental",
        body: "Hi Dana, a short note about no-shows.",
        occurredAt: new Date("2026-09-19T09:00:00Z"),
        contactId: "c-1",
      }),
    );
    expect(
      await processCrmEvent(
        t.ctx,
        await sentEvent(t, { channel: "linkedin", action: "message", subject: null }),
      ),
    ).toMatchObject({ skipped: "nothing_to_sync" });
  });

  it("writes a note once per event and provider, so retries and replays never repeat it", async () => {
    const t = await setup({ log: "key_moments" });
    await linkContact(t);
    const event = await replyEvent(t, "question");
    expect((await processCrmEvent(t.ctx, event)).providers[0]?.note).toBe("logged");
    expect((await processCrmEvent(t.ctx, event)).providers[0]?.note).toBe("already_logged");
    expect(t.crm.logActivity).toHaveBeenCalledTimes(1);
    expect(await activityMarkers(t)).toEqual([
      expect.objectContaining({ provider: "hubspot", entity_id: event.id, external_id: "note-1" }),
    ]);
  });

  it("never writes a note again when the CRM did not confirm it (outcome unknown)", async () => {
    const t = await setup({ log: "key_moments" });
    await linkContact(t);
    const event = await replyEvent(t, "question");
    t.crm.logActivity.mockRejectedValueOnce(
      providerFailure({ provider: "hubspot", name: "HubSpot", class: "outcome_unknown" }),
    );
    expect((await processCrmEvent(t.ctx, event)).providers[0]?.note).toBe("unknown");
    expect((await processCrmEvent(t.ctx, event)).providers[0]?.note).toBe("already_logged");
    expect(t.crm.logActivity).toHaveBeenCalledTimes(1);
    expect(await activityMarkers(t)).toEqual([
      expect.objectContaining({ entity_id: event.id, external_id: "unknown" }),
    ]);
    expect(await syncProblems(t)).toHaveLength(0);
  });

  it("uses the older logNote hook when the provider has no logActivity", async () => {
    const logNote = vi.fn(async () => {});
    const crm = {
      id: "pipedrive",
      upsertContact: vi.fn(async () => ({ contactId: "p-1" })),
      upsertDeal: vi.fn(async () => ({ dealId: "d-1" })),
      logNote,
    } satisfies CrmProvider;
    const ctx = await createTestContext({
      db: testDb,
      providers: { crm: [crm] },
      settings: { crm: { log: "key_moments" } },
    });
    const person = await seedPerson(ctx);
    const thread = await seedThread(ctx, { person_id: person.id });
    await writeLink(ctx, "pipedrive", "person", person.id, "p-1");
    const message = await seedMessage(ctx, {
      thread_id: thread.id,
      person_id: person.id,
      direction: "inbound",
      status: "received",
      action: "reply",
      classification: { category: "not_now", confidence: 0.8, summary: "Ask again in March" },
    });
    const result = await processCrmEvent(ctx, {
      id: nextEventId(),
      type: "reply.classified",
      data: {
        message_id: message.id,
        thread_id: thread.id,
        person_id: person.id,
        category: "not_now",
        confidence: 0.8,
      },
      occurredAt: ctx.clock.now(),
    });
    expect(result.providers[0]?.note).toBe("logged");
    expect(logNote).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "p-1", text: "Reply: Not now\n\nAsk again in March" }),
    );
  });

  it("logs meetings on the deal they belong to, and not at all under log deals", async () => {
    const t = await setup({ log: "key_moments" });
    const opportunity = await seedOpportunity(t);
    await writeLink(t.ctx, "hubspot", "opportunity", opportunity.id, "deal-9");
    const base = {
      meeting_id: "mtg_1",
      person_id: t.person.id,
      opportunity_id: opportunity.id,
    };
    const booked: CrmEvent = {
      id: nextEventId(),
      type: "meeting.booked",
      data: { ...base, source: "calendly", start_at: "2026-10-08T13:00:00Z", matched_by: "email" },
      occurredAt: new Date("2026-09-19T11:00:00Z"),
    };
    const result = await processCrmEvent(t.ctx, booked);
    // A meeting is past every sync_from point: the contact is created for the note.
    expect(result.providers[0]).toMatchObject({ contact: "created", note: "logged" });
    expect(t.crm.logActivity).toHaveBeenLastCalledWith({
      kind: "meeting",
      subject: "booked for 2026-10-08 13:00 UTC",
      occurredAt: new Date("2026-09-19T11:00:00Z"),
      contactId: "contact-1",
      dealId: "deal-9",
      companyId: "company-1",
    });
    const subjects: string[] = [];
    for (const event of [
      {
        type: "meeting.rescheduled",
        data: { ...base, start_at: "2026-10-09T15:30:00Z", previous_start_at: null },
      },
      { type: "meeting.cancelled", data: base },
      { type: "meeting.no_show", data: base },
      { type: "meeting.held", data: { ...base, qualified: true } },
      { type: "meeting.held", data: { ...base, qualified: false } },
      { type: "meeting.held", data: { ...base, qualified: null } },
    ] as const) {
      await processCrmEvent(t.ctx, {
        id: nextEventId(),
        occurredAt: t.ctx.clock.now(),
        ...event,
      } as CrmEvent);
      subjects.push(String(t.crm.logActivity.mock.lastCall?.[0].subject));
    }
    expect(subjects).toEqual([
      "moved to 2026-10-09 15:30 UTC",
      "cancelled",
      "no-show",
      "held, qualified",
      "held, not qualified",
      "held",
    ]);

    const quiet = await setup();
    expect(
      await processCrmEvent(quiet.ctx, {
        ...booked,
        id: nextEventId(),
        data: { ...booked.data, person_id: quiet.person.id },
      } as CrmEvent),
    ).toMatchObject({ skipped: "nothing_to_sync" });
  });

  it("queues the deal sync for opportunity.updated", async () => {
    const t = await setup();
    const opportunity = await seedOpportunity(t);
    const result = await processCrmEvent(t.ctx, {
      id: nextEventId(),
      type: "opportunity.updated",
      data: {
        opportunity_id: opportunity.id,
        stage: "meeting_booked",
        previous_stage: "interested",
        person_id: t.person.id,
        company_id: t.company.id,
      },
      occurredAt: t.ctx.clock.now(),
    });
    expect(result).toMatchObject({ skipped: null, queued_sync: true });
    expect(t.ctx.enqueued(CRM_SYNC_JOB)[0]?.payload).toEqual({ opportunity_id: opportunity.id });
  });
});

describe("processCrmEvent: failures", () => {
  it("opens crm_sync_failed when a provider refuses, and resolves it after the next success", async () => {
    const t = await setup({ log: "key_moments" });
    await linkContact(t);
    t.crm.logActivity.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "HubSpot rejected the token.", {
        details: { reason: "unauthorized", status: 401 },
      }),
    );
    const failed = await processCrmEvent(t.ctx, await replyEvent(t, "question"));
    expect(failed.providers[0]).toMatchObject({ error: "HubSpot rejected the token." });
    expect(await syncProblems(t)).toEqual([
      expect.objectContaining({
        status: "open",
        severity: "high",
        owner: "person",
        dedupe_key: "crm_sync_failed:hubspot",
      }),
    ]);
    await processCrmEvent(t.ctx, await replyEvent(t, "question"));
    expect(await syncProblems(t)).toEqual([expect.objectContaining({ status: "resolved" })]);
  });

  it("throws on temporary failures so the job retries, and opens the problem on the last attempt", async () => {
    const t = await setup({ log: "key_moments" });
    await linkContact(t);
    const event = await replyEvent(t, "question");
    t.crm.logActivity.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      processCrmEvent(t.ctx.jobContext({ attempt: 1, maxAttempts: 5 }), event),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(await syncProblems(t)).toHaveLength(0);
    t.crm.logActivity.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "HubSpot rate limit reached.", {
        retryAfterSeconds: 10,
      }),
    );
    await expect(
      processCrmEvent(t.ctx.jobContext({ attempt: 5, maxAttempts: 5 }), event),
    ).rejects.toMatchObject({ retryAfterSeconds: 10 });
    expect(await syncProblems(t)).toHaveLength(1);
    // Nothing was logged, so the marker is not there and a later retry writes the note.
    expect(await activityMarkers(t)).toHaveLength(0);
  });
});

describe("live handlers", () => {
  function emitted<T extends CrmEvent["type"]>(
    t: Setup,
    event: CrmEvent & { type: T },
  ): EmittedEvent<T> {
    return {
      id: event.id,
      type: event.type,
      workspaceId: t.ctx.workspace.id,
      subject: null,
      data: event.data,
      occurredAt: event.occurredAt,
    } as EmittedEvent<T>;
  }

  it("run in built_in mode with live timing only", async () => {
    const live = await setup({ sync_from: "contacted" });
    await crmOnMessageSent.handler(
      live.ctx.jobContext(),
      emitted(live, (await sentEvent(live)) as CrmEvent & { type: "message.sent" }),
    );
    expect(live.crm.upsertContact).toHaveBeenCalledTimes(1);

    for (const crm of [
      { sync_from: "replied", timing: "daily" },
      { sync_from: "replied", mode: "agent" },
      { sync_from: "replied", mode: "off" },
    ] as const) {
      const t = await setup(crm);
      await crmOnReplyClassified.handler(
        t.ctx.jobContext(),
        emitted(t, (await replyEvent(t, "question")) as CrmEvent & { type: "reply.classified" }),
      );
      expect(t.crm.upsertContact).not.toHaveBeenCalled();
    }
  });

  it("meeting handlers write their note live", async () => {
    const t = await setup({ log: "key_moments" });
    await linkContact(t);
    await crmOnMeetingBooked.handler(t.ctx.jobContext(), {
      id: nextEventId(),
      type: "meeting.booked",
      workspaceId: t.ctx.workspace.id,
      subject: null,
      data: {
        meeting_id: "mtg_2",
        person_id: t.person.id,
        opportunity_id: null,
        source: "manual",
        start_at: null,
        matched_by: "manual",
      },
      occurredAt: t.ctx.clock.now(),
    });
    expect(t.crm.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "meeting", subject: "booked", contactId: "c-1" }),
    );
  });
});
