/**
 * The send gate itself: what the sender is told to do about each blocker (the disposition, the
 * wait key and the stored reason), send mode against view mode, the wake-up of a changed
 * company hold, and messages that still wait to be planned. eligibility.test.ts drives the real
 * senders through the same gate.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NewCompany, NewMessage, Workspace } from "../../db/schema/index.js";
import {
  campaigns,
  companies,
  enrollments,
  mailboxes,
  messages,
  people,
  workspaces,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedLinkedInAccount,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { checkEligibility } from "./eligibility.js";
import { wakeOnHoldChange } from "./events.js";
import { evaluateEmailGate, evaluateLinkedInGate } from "./gate.js";

/** Tuesday 2026-09-22 10:00 in Chicago (inside the default 8-17 window and 9-18 hours). */
const NOW = "2026-09-22T15:00:00.000Z";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function emailCase(
  options: { company?: Partial<NewCompany>; message?: Partial<NewMessage> } = {},
) {
  const ctx = await createTestContext({ db, now: NOW });
  const company = await seedCompany(ctx, { name: "Harbor Supply Ltd", ...options.company });
  const person = await seedPerson(ctx, { company_id: company.id, full_name: "Dana Reyes" });
  const mailbox = await seedMailbox(ctx, { email: "sam@harbor.example.org" });
  const { campaign, steps } = await seedCampaign(ctx, {
    name: "Q4 distributors",
    status: "active",
    settings: { senders: { mailbox_ids: [mailbox.id] } },
  });
  const message = await seedMessage(ctx, {
    person_id: person.id,
    company_id: company.id,
    campaign_id: campaign.id,
    step_id: steps[0]?.id ?? null,
    status: "scheduled",
    mailbox_id: mailbox.id,
    to_address: person.email,
    scheduled_for: new Date(NOW),
    ...options.message,
  });
  return { ctx, company, person, mailbox, campaign, message };
}

/** The gate as the send job calls it. */
async function sendGate(ctx: TestContext, messageId: string, hooks = {}) {
  const workspace = await ctx.reloadWorkspace();
  const [message] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!message) throw new Error("message missing");
  return evaluateEmailGate(
    ctx,
    { personId: message.person_id ?? "", messageId },
    { mode: "send", known: { workspace, message }, hooks },
  );
}

async function setWorkspaceStatus(ctx: TestContext, status: Workspace["status"]) {
  await ctx.db.update(workspaces).set({ status }).where(eq(workspaces.id, ctx.workspace.id));
}

describe("the send gate tells the email sender what to do", () => {
  it("waits for a paused workspace and a paused campaign, with their wake keys", async () => {
    const s = await emailCase();
    await setWorkspaceStatus(s.ctx, "paused");
    const paused = await sendGate(s.ctx, s.message.id);
    expect(paused.blockers).toHaveLength(1);
    expect(paused.blockers[0]).toMatchObject({
      code: "workspace_paused",
      disposition: "wait",
      wait_key: `workspace_active:${s.ctx.workspace.id}`,
    });

    await setWorkspaceStatus(s.ctx, "active");
    await s.ctx.db
      .update(campaigns)
      .set({ status: "paused" })
      .where(eq(campaigns.id, s.campaign.id));
    const held = await sendGate(s.ctx, s.message.id);
    expect(held.blockers[0]).toMatchObject({
      code: "campaign_paused",
      disposition: "wait",
      wait_key: `campaign_active:${s.campaign.id}`,
    });
  });

  it("cancels an email to someone deleted, with the stored words", async () => {
    const s = await emailCase();
    await s.ctx.db.delete(people).where(eq(people.id, s.person.id));
    const gate = await sendGate(s.ctx, s.message.id);
    expect(gate.blockers).toEqual([
      expect.objectContaining({
        code: "person_not_found",
        disposition: "cancel",
        detail: "The person no longer exists (deleted or forgotten).",
      }),
    ]);
  });

  it("parks an email for a company hold until the hold ends, at most a day at a time", async () => {
    const s = await emailCase({
      company: { hold_until: new Date("2026-09-23T09:00:00Z"), hold_reason: "budget freeze" },
    });
    const soon = await sendGate(s.ctx, s.message.id);
    expect(soon.blockers[0]).toMatchObject({
      code: "company_on_hold",
      disposition: "wait",
      wait_key: `company_hold:${s.company.id}`,
      retry_at: "2026-09-23T09:00:00.000Z",
      until: "2026-09-23T09:00:00.000Z",
      hard: false,
    });

    await s.ctx.db
      .update(companies)
      .set({ hold_until: new Date("2027-03-01T00:00:00Z") })
      .where(eq(companies.id, s.company.id));
    const long = await sendGate(s.ctx, s.message.id);
    expect(long.blockers[0]?.retry_at).toBe("2026-09-23T15:00:00.000Z");
  });

  it("skips for good when the hold comes with an opt-out, with every code in the reason", async () => {
    const s = await emailCase({ company: { hold_until: new Date("2026-10-06T07:00:00Z") } });
    await s.ctx.db.update(people).set({ status: "unsubscribed" }).where(eq(people.id, s.person.id));
    const gate = await sendGate(s.ctx, s.message.id);
    expect(gate.blockers.map((item) => item.code)).toEqual([
      "person_unsubscribed",
      "company_on_hold",
    ]);
    for (const item of gate.blockers) {
      expect(item).toMatchObject({
        disposition: "skip",
        detail: "person_unsubscribed, company_on_hold",
      });
    }
    // The hold blocker says the hold ends, but the email is skipped for good.
    expect(gate.blockers[1]).toMatchObject({ until: null, hard: true });
  });

  it("cancels a sequence step in a thread a person took over", async () => {
    const s = await emailCase();
    const thread = await seedThread(s.ctx, { person_id: s.person.id, owner: "person" });
    await s.ctx.db
      .update(messages)
      .set({ thread_id: thread.id })
      .where(eq(messages.id, s.message.id));
    const gate = await sendGate(s.ctx, s.message.id);
    expect(gate.blockers[0]).toMatchObject({
      code: "thread_owned_by_person",
      disposition: "cancel",
      detail: "superseded_by_person",
    });
  });

  it("cancels a step whose sequence or campaign ended, and holds a paused one", async () => {
    const s = await emailCase();
    const enrollment = await seedEnrollment(s.ctx, {
      campaign_id: s.campaign.id,
      person_id: s.person.id,
      status: "stopped",
      stop_reason: "person_took_over",
    });
    await s.ctx.db
      .update(messages)
      .set({ enrollment_id: enrollment.id })
      .where(eq(messages.id, s.message.id));
    const stopped = await sendGate(s.ctx, s.message.id);
    expect(stopped.blockers).toEqual([
      expect.objectContaining({
        code: "enrollment_ended",
        disposition: "cancel",
        detail: "enrollment_stopped:person_took_over",
      }),
    ]);

    const setEnrollment = (values: Partial<typeof enrollments.$inferInsert>) =>
      s.ctx.db.update(enrollments).set(values).where(eq(enrollments.id, enrollment.id));
    await setEnrollment({
      status: "paused",
      stop_reason: "out_of_office",
      paused_until: new Date("2026-09-28T13:00:00Z"),
    });
    const paused = await sendGate(s.ctx, s.message.id);
    expect(paused.blockers[0]).toMatchObject({
      code: "enrollment_paused",
      disposition: "wait",
      retry_at: "2026-09-28T13:00:00.000Z",
      until: "2026-09-28T13:00:00.000Z",
    });
    // Paused with no end date: looked at again within the hour.
    await setEnrollment({ paused_until: null });
    const open = await sendGate(s.ctx, s.message.id);
    expect(open.blockers[0]).toMatchObject({
      code: "enrollment_paused",
      disposition: "wait",
      retry_at: "2026-09-22T16:00:00.000Z",
    });

    await setEnrollment({ status: "active", stop_reason: null });
    await s.ctx.db
      .update(campaigns)
      .set({ status: "archived" })
      .where(eq(campaigns.id, s.campaign.id));
    const archived = await sendGate(s.ctx, s.message.id);
    expect(archived.blockers).toEqual([
      expect.objectContaining({
        code: "campaign_inactive",
        disposition: "cancel",
        detail: "campaign_archived",
      }),
    ]);
    // The view shows the sender's blocker.
    const view = await checkEligibility(s.ctx, {
      personId: s.person.id,
      channel: "email",
      messageId: s.message.id,
    });
    expect(view.blockers.map((item) => item.code)).toEqual(["campaign_inactive"]);

    // A reply in the same campaign is not a sequence step: it still goes.
    await s.ctx.db
      .update(messages)
      .set({ step_id: null, action: "reply" })
      .where(eq(messages.id, s.message.id));
    await setEnrollment({ status: "stopped", stop_reason: "replied" });
    await s.ctx.db
      .update(campaigns)
      .set({ status: "active" })
      .where(eq(campaigns.id, s.campaign.id));
    expect((await sendGate(s.ctx, s.message.id)).blockers).toEqual([]);
  });

  it("moves an email off a mailbox that cannot send and fails one without a subject", async () => {
    const s = await emailCase();
    await s.ctx.db
      .update(mailboxes)
      .set({ status: "error", status_reason: "Login failed" })
      .where(eq(mailboxes.id, s.mailbox.id));
    const down = await sendGate(s.ctx, s.message.id);
    expect(down.blockers[0]).toMatchObject({
      code: "mailbox_error",
      disposition: "move",
      detail: "Mailbox sam@harbor.example.org is error.",
    });
    expect(down.mailbox?.id).toBe(s.mailbox.id);

    await s.ctx.db
      .update(mailboxes)
      .set({ status: "active", status_reason: null })
      .where(eq(mailboxes.id, s.mailbox.id));
    await s.ctx.db.update(messages).set({ subject: " " }).where(eq(messages.id, s.message.id));
    const empty = await sendGate(s.ctx, s.message.id);
    expect(empty.blockers[0]).toMatchObject({
      code: "message_no_subject",
      disposition: "fail",
      detail: "The message has no subject.",
    });
  });

  it("runs the sender's re-verification only when sending", async () => {
    const s = await emailCase();
    const reverify = vi.fn(async () => ["invalid_email"]);
    const view = await evaluateEmailGate(
      s.ctx,
      { personId: s.person.id, messageId: s.message.id },
      { hooks: { reverify } },
    );
    expect(view.blockers).toEqual([]);
    expect(reverify).not.toHaveBeenCalled();

    const send = await sendGate(s.ctx, s.message.id, { reverify });
    expect(reverify).toHaveBeenCalledTimes(1);
    expect(send.blockers[0]).toMatchObject({
      code: "invalid_email",
      disposition: "skip",
      detail: "invalid_email",
    });
  });

  it("shows the views plain blockers, without what the sender does", async () => {
    const s = await emailCase({ company: { hold_until: new Date("2026-10-06T07:00:00Z") } });
    const view = await checkEligibility(s.ctx, {
      personId: s.person.id,
      channel: "email",
      messageId: s.message.id,
    });
    expect(view.blockers).toHaveLength(1);
    expect(Object.keys(view.blockers[0] ?? {}).sort()).toEqual([
      "code",
      "fix",
      "hard",
      "message",
      "until",
    ]);
  });
});

describe("a message that waits to be planned", () => {
  it("is checked like a new email, not as a message with a lost mailbox", async () => {
    // 18:30 in Chicago: the campaign window opens tomorrow 08:00.
    const s = await emailCase({
      message: { status: "approved", mailbox_id: null, scheduled_for: null },
    });
    s.ctx.clock.set("2026-09-22T23:30:00.000Z");
    const late = await checkEligibility(s.ctx, {
      personId: s.person.id,
      channel: "email",
      messageId: s.message.id,
    });
    expect(late.blockers.map((item) => item.code)).toEqual(["outside_window"]);
    expect(late.blockers[0]).toMatchObject({ until: "2026-09-23T13:00:00.000Z", hard: false });

    s.ctx.clock.set(NOW);
    const now = await checkEligibility(s.ctx, {
      personId: s.person.id,
      channel: "email",
      messageId: s.message.id,
    });
    expect(now).toEqual({ ok: true, blockers: [] });
  });
});

describe("the send gate tells the LinkedIn sender what to do", () => {
  async function linkedinCase(message: Partial<NewMessage> = {}) {
    const ctx = await createTestContext({ db, now: NOW });
    const account = await seedLinkedInAccount(ctx, {
      provider: "unipile",
      name: "Sam on LinkedIn",
    });
    const person = await seedPerson(ctx, {
      full_name: "Omar Haddad",
      linkedin_url: "https://www.linkedin.com/in/omar-haddad-example",
    });
    const row = await seedMessage(ctx, {
      channel: "linkedin",
      action: "invite",
      status: "scheduled",
      subject: null,
      body_text: "",
      linkedin_account_id: account.id,
      person_id: person.id,
      scheduled_for: new Date(NOW),
      ...message,
    });
    return { ctx, account, person, message: row };
  }

  async function linkedinGate(ctx: TestContext, messageId: string, mode: "send" | "view") {
    const workspace = await ctx.reloadWorkspace();
    const [message] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
    if (!message) throw new Error("message missing");
    return evaluateLinkedInGate(
      ctx,
      { personId: message.person_id ?? "", messageId },
      { mode, known: { workspace, message } },
    );
  }

  it("waits for its slot when the job wakes early; the view has nothing to say", async () => {
    const slot = new Date(Date.parse(NOW) + 2 * 3_600_000);
    const s = await linkedinCase({ scheduled_for: slot });
    const send = await linkedinGate(s.ctx, s.message.id, "send");
    expect(send.blockers).toEqual([
      expect.objectContaining({
        code: "not_due_yet",
        disposition: "wait",
        wait_key: `linkedin.slot:${s.message.id}`,
        retry_at: slot.toISOString(),
      }),
    ]);
    const view = await linkedinGate(s.ctx, s.message.id, "view");
    expect(view.blockers.map((item) => item.code)).not.toContain("not_due_yet");
  });

  it("parks an action of an archived workspace and waits for a paused one", async () => {
    const s = await linkedinCase();
    await setWorkspaceStatus(s.ctx, "archived");
    const archived = await linkedinGate(s.ctx, s.message.id, "send");
    expect(archived.blockers[0]).toMatchObject({
      code: "workspace_archived",
      disposition: "move",
      detail: "workspace archived",
    });
    await setWorkspaceStatus(s.ctx, "paused");
    const paused = await linkedinGate(s.ctx, s.message.id, "send");
    expect(paused.blockers[0]).toMatchObject({
      code: "workspace_paused",
      disposition: "wait",
      wait_key: `workspace_active:${s.ctx.workspace.id}`,
    });
  });

  it("fails an action without a person and makes a campaign step wait for a company hold", async () => {
    const s = await linkedinCase({ person_id: null });
    const orphan = await linkedinGate(s.ctx, s.message.id, "send");
    expect(orphan.blockers[0]).toMatchObject({ disposition: "fail", detail: "missing_person" });

    const company = await seedCompany(s.ctx, {
      name: "Harbor Supply Ltd",
      hold_until: new Date("2026-10-06T07:00:00Z"),
    });
    await s.ctx.db.update(people).set({ company_id: company.id }).where(eq(people.id, s.person.id));
    const { steps } = await seedCampaign(s.ctx, {
      status: "active",
      steps: [{ type: "linkedin_invite" }],
    });
    const step = await seedMessage(s.ctx, {
      channel: "linkedin",
      action: "invite",
      status: "scheduled",
      body_text: "",
      linkedin_account_id: s.account.id,
      person_id: s.person.id,
      campaign_id: steps[0]?.campaign_id ?? null,
      step_id: steps[0]?.id ?? null,
      scheduled_for: new Date(NOW),
    });
    const held = await linkedinGate(s.ctx, step.id, "send");
    expect(held.blockers[0]).toMatchObject({
      code: "company_on_hold",
      disposition: "wait",
      wait_key: `company_hold:${company.id}`,
    });
  });
});

describe("a changed company hold", () => {
  it("wakes the sends waiting for it", async () => {
    const ctx = await createTestContext({ db, now: NOW });
    const company = await seedCompany(ctx, { name: "Harbor Supply Ltd" });
    await wakeOnHoldChange.handler(ctx.jobContext(), {
      id: "evt_test",
      type: "company.hold_changed",
      workspaceId: ctx.workspace.id,
      subject: { type: "company", id: company.id },
      data: { company_id: company.id, hold_until: null, reason: null },
      occurredAt: ctx.clock.now(),
    });
    expect(ctx.recorded.wakes).toContain(`company_hold:${company.id}`);
  });
});
