/**
 * Eligibility against the real senders: for each seeded situation the view is computed first,
 * then the real send job runs (sandbox transport) and both must agree: the view blocks exactly
 * when the job refuses or waits, with the same reason and the same next time. Both go through
 * the one send gate (gate.ts), so this matrix also pins what the senders do.
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isJobWaitError } from "../../core/errors.js";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import {
  approvals,
  type Campaign,
  type Company,
  campaigns,
  enrollments,
  type Mailbox,
  type Message,
  messages,
  type NewCompany,
  type NewMailbox,
  type NewMessage,
  type NewPerson,
  type NewThread,
  type Person,
  problems,
  sender_counters,
  suppressions,
  type Thread,
  workspaces,
} from "../../db/schema/index.js";
import type { LinkedInProvider } from "../../providers/types.js";
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
import { clearSandboxOutbox } from "../email/sandbox-transport.js";
import { sendEmailMessage } from "../email/send-job.js";
import { runLinkedInAction } from "../linkedin/action-job.js";
import { upsertRelation } from "../linkedin/relations.js";
import { checkEligibility } from "./eligibility.js";

/** Tuesday 2026-09-22 10:00 in Chicago (inside the default 8-17 window and 9-18 hours). */
const NOW = "2026-09-22T15:00:00.000Z";
const HOUR = 3_600_000;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
afterEach(() => {
  clearSandboxOutbox();
});

interface JobRun {
  status: string;
  reason?: string;
  retryAt?: Date;
  waitFor?: string;
}

/** The message row as stored now. */
async function messageRow(ctx: TestContext, messageId: string): Promise<Message> {
  const [row] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!row) throw new Error("message missing");
  return row;
}

/** An open privacy request of the person (the inbox opens one per request). */
async function openPrivacyRequest(ctx: TestContext, personId: string, key: string) {
  const [problem] = await ctx.db
    .insert(problems)
    .values({
      workspace_id: ctx.workspace.id,
      kind: "privacy_request",
      severity: "urgent",
      title: "Privacy request",
      reason: "Asked what data we hold.",
      remedy: "Answer within 30 days.",
      person_id: personId,
      dedupe_key: `privacy_request:${key}`,
    })
    .returning();
  if (!problem) throw new Error("problem missing");
  return problem;
}

async function runEmailJob(ctx: TestContext, messageId: string): Promise<JobRun> {
  try {
    const outcome = await sendEmailMessage(ctx.jobContext({ name: "email.send" }), messageId);
    return { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  } catch (error) {
    if (isJobWaitError(error)) {
      return {
        status: "wait",
        waitFor: error.waitFor,
        ...(error.retryAt ? { retryAt: error.retryAt } : {}),
      };
    }
    throw error;
  }
}

interface EmailSetup {
  ctx: TestContext;
  person: Person;
  company: Company;
  mailbox: Mailbox;
  campaign: Campaign | null;
  thread: Thread | null;
  message: Message;
}

async function emailSetup(
  options: {
    now?: string;
    settings?: WorkspaceSettingsInput;
    company?: Partial<NewCompany>;
    person?: Partial<NewPerson>;
    mailbox?: Partial<NewMailbox>;
    secondMailbox?: Partial<NewMailbox>;
    /** false = no campaign (an answer in a thread). */
    campaign?: { status?: Campaign["status"] } | false;
    thread?: Partial<NewThread>;
    message?: Partial<NewMessage>;
  } = {},
): Promise<EmailSetup> {
  const now = options.now ?? NOW;
  const ctx = await createTestContext({ db, now, settings: options.settings ?? {} });
  const company = await seedCompany(ctx, { name: "Harbor Supply Ltd", ...options.company });
  const person = await seedPerson(ctx, {
    company_id: company.id,
    full_name: "Dana Reyes",
    ...options.person,
  });
  const mailbox = await seedMailbox(ctx, { email: "sam@harbor.example.org", ...options.mailbox });
  const second = options.secondMailbox
    ? await seedMailbox(ctx, { email: "alex@harbor.example.org", ...options.secondMailbox })
    : null;
  let campaign: Campaign | null = null;
  let thread: Thread | null = null;
  const base: Partial<NewMessage> = {
    person_id: person.id,
    company_id: company.id,
    status: "scheduled",
    mailbox_id: mailbox.id,
    to_address: person.email,
    scheduled_for: new Date(now),
  };
  let message: Message;
  if (options.campaign === false) {
    thread = await seedThread(ctx, {
      person_id: person.id,
      company_id: company.id,
      mailbox_id: mailbox.id,
      ...options.thread,
    });
    message = await seedMessage(ctx, {
      ...base,
      action: "reply",
      thread_id: thread.id,
      ...options.message,
    });
  } else {
    const seeded = await seedCampaign(ctx, {
      name: "Q4 distributors",
      status: options.campaign?.status ?? "active",
      settings: { senders: { mailbox_ids: [mailbox.id, ...(second ? [second.id] : [])] } },
    });
    campaign = seeded.campaign;
    const enrollment = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: person.id,
      mailbox_id: mailbox.id,
    });
    message = await seedMessage(ctx, {
      ...base,
      campaign_id: campaign.id,
      enrollment_id: enrollment.id,
      step_id: seeded.steps[0]?.id ?? null,
      ...options.message,
    });
  }
  return { ctx, person, company, mailbox, campaign, thread, message };
}

/** The view first (the job changes the message), then the real send job. */
async function compare(s: EmailSetup) {
  await s.ctx.reloadWorkspace();
  const view = await checkEligibility(s.ctx, {
    personId: s.person.id,
    channel: "email",
    messageId: s.message.id,
  });
  const job = await runEmailJob(s.ctx, s.message.id);
  expect(view.ok).toBe(job.status === "sent");
  return { view, job, first: view.blockers[0] };
}

describe("email eligibility matches the send job", () => {
  it("sends when nothing blocks", async () => {
    const { view, job } = await compare(await emailSetup());
    expect(job.status).toBe("sent");
    expect(view).toEqual({ ok: true, blockers: [] });
  });

  it("skips a suppressed address", async () => {
    const s = await emailSetup();
    await s.ctx.db.insert(suppressions).values({
      workspace_id: s.ctx.workspace.id,
      type: "email",
      value: s.person.email ?? "",
      reason: "manual",
      source: "test",
    });
    const { job, first } = await compare(s);
    expect(job.status).toBe("skipped");
    expect(job.reason).toContain("suppressed_email");
    expect(first).toMatchObject({ code: "suppressed_email", hard: true });
    expect(first?.message).toBe("Dana Reyes's email address is on the suppression list.");
  });

  it("skips a person marked do not contact", async () => {
    const { job, first } = await compare(
      await emailSetup({ person: { status: "do_not_contact" } }),
    );
    expect(job.status).toBe("skipped");
    expect(first).toMatchObject({ code: "person_do_not_contact", hard: true, fix: null });
  });

  it("waits for a company hold that started after the email was queued, then sends", async () => {
    const s = await emailSetup({
      company: { hold_until: new Date("2026-10-06T07:00:00Z"), hold_reason: "signed with a rival" },
    });
    const { job, first } = await compare(s);
    // Parked until the hold ends, looked at again at least daily (a hold can move or end early).
    expect(job).toMatchObject({ status: "wait", waitFor: `company_hold:${s.company.id}` });
    expect(job.retryAt?.toISOString()).toBe("2026-09-23T15:00:00.000Z");
    expect(first).toMatchObject({
      code: "company_on_hold",
      until: "2026-10-06T07:00:00.000Z",
      hard: false,
    });
    expect(first?.message).toBe(
      "Harbor Supply Ltd is on hold until Tuesday 6 October 07:00 UTC: signed with a rival; no new outreach to anyone there.",
    );
    expect(first?.fix).toContain("manage_leads action release_company");
    expect(await messageRow(s.ctx, s.message.id)).toMatchObject({
      status: "scheduled",
      error: null,
    });

    // The hold is over (Tuesday 09:00 in Chicago, inside the window): it goes.
    s.ctx.clock.set("2026-10-06T14:00:00.000Z");
    const later = await compare(s);
    expect(later.job.status).toBe("sent");
  });

  it("skips new outreach when a company hold comes with another company rule", async () => {
    const s = await emailSetup({
      company: { hold_until: new Date("2026-10-06T07:00:00Z"), crm_open_deal: true },
    });
    const { job, view } = await compare(s);
    expect(job).toMatchObject({ status: "skipped", reason: "company_on_hold, company_open_deal" });
    expect(view.blockers.map((item) => item.code)).toEqual([
      "company_on_hold",
      "company_open_deal",
    ]);
    expect(view.blockers[0]).toMatchObject({ until: null, hard: true });
  });

  it("skips new outreach to a customer company but still answers people there", async () => {
    const outreach = await compare(await emailSetup({ company: { status: "customer" } }));
    expect(outreach.job).toMatchObject({ status: "skipped", reason: "company_customer" });
    expect(outreach.first).toMatchObject({ code: "company_customer", hard: true });
    expect(outreach.first?.message).toBe(
      "Harbor Supply Ltd is a customer, so there is no cold outreach.",
    );

    const answer = await compare(
      await emailSetup({ campaign: false, company: { status: "customer" } }),
    );
    expect(answer.job.status).toBe("sent");
  });

  it("skips every email while a privacy request is open, answers included", async () => {
    const s = await emailSetup();
    const problem = await openPrivacyRequest(s.ctx, s.person.id, s.message.id);
    const { job, first } = await compare(s);
    expect(job).toMatchObject({ status: "skipped", reason: "privacy_request_open" });
    expect(await messageRow(s.ctx, s.message.id)).toMatchObject({
      status: "skipped",
      error: "not_contactable: privacy_request_open",
    });
    expect(first).toMatchObject({ code: "privacy_request_open", hard: true });
    expect(first?.fix).toContain(`resolve_exception action resolve (problem_id ${problem.id})`);

    const reply = await emailSetup({ campaign: false });
    await openPrivacyRequest(reply.ctx, reply.person.id, reply.message.id);
    const answered = await compare(reply);
    expect(answered.job).toMatchObject({ status: "skipped", reason: "privacy_request_open" });
  });

  it("cancels a sequence step that continues a thread a person took over", async () => {
    const s = await emailSetup();
    const thread = await seedThread(s.ctx, {
      person_id: s.person.id,
      company_id: s.company.id,
      mailbox_id: s.mailbox.id,
      owner: "person",
    });
    await s.ctx.db
      .update(messages)
      .set({ thread_id: thread.id })
      .where(eq(messages.id, s.message.id));
    const { job, first } = await compare(s);
    expect(job).toMatchObject({ status: "cancelled", reason: "superseded_by_person" });
    expect(await messageRow(s.ctx, s.message.id)).toMatchObject({
      status: "cancelled",
      error: "superseded_by_person",
    });
    expect(s.ctx.emitted("message.failed").at(-1)?.data).toMatchObject({
      message_id: s.message.id,
      error: "superseded_by_person",
      retryable: false,
    });
    expect(first).toMatchObject({ code: "thread_owned_by_person", hard: true });
    expect(first?.fix).toBe(
      `Answer yourself, or hand it back with reply_to_thread action release (thread_id ${thread.id}).`,
    );
  });

  it("cancels an automatic reply in a thread a person took over", async () => {
    const s = await emailSetup({
      campaign: false,
      thread: { owner: "person" },
      message: { why: { auto_reply_for: "msg_inbound" } as NewMessage["why"] },
    });
    const { job, first } = await compare(s);
    expect(job).toMatchObject({ status: "cancelled", reason: "superseded_by_person" });
    expect(first).toMatchObject({ code: "thread_owned_by_person", hard: true });
  });

  it("still answers someone at a company on hold", async () => {
    const s = await emailSetup({
      campaign: false,
      company: { hold_until: new Date("2026-10-06T07:00:00Z") },
    });
    const { job } = await compare(s);
    expect(job.status).toBe("sent");
  });

  it("holds new outreach while the CRM has an open deal, unless the workspace allows it", async () => {
    const blocked = await compare(await emailSetup({ company: { crm_open_deal: true } }));
    expect(blocked.job.status).toBe("skipped");
    expect(blocked.first?.code).toBe("company_open_deal");
    expect(blocked.first?.fix).toContain("settings.crm.allow_outreach_with_open_deal");

    const allowed = await compare(
      await emailSetup({
        company: { crm_open_deal: true },
        settings: { crm: { allow_outreach_with_open_deal: true } },
      }),
    );
    expect(allowed.job.status).toBe("sent");
  });

  it("waits while the workspace is paused", async () => {
    const s = await emailSetup();
    await s.ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, s.ctx.workspace.id));
    const { job, first } = await compare(s);
    expect(job).toMatchObject({
      status: "wait",
      waitFor: `workspace_active:${s.ctx.workspace.id}`,
    });
    expect(first).toMatchObject({ code: "workspace_paused", hard: true });
    expect(first?.fix).toBe(
      "Resume it with manage_workspaces action resume once the reason for the pause is fixed.",
    );
  });

  it("holds a first email of a paused campaign but not a reply", async () => {
    const first = await compare(await emailSetup({ campaign: { status: "paused" } }));
    expect(first.job.status).toBe("wait");
    expect(first.first).toMatchObject({ code: "campaign_paused", hard: true });
    expect(first.first?.fix).toContain("launch_campaign action resume");

    const reply = await compare(
      await emailSetup({ campaign: { status: "paused" }, message: { action: "reply" } }),
    );
    expect(reply.job.status).toBe("sent");
  });

  it("cancels a step whose sequence stopped (a resend after an unknown outcome), not a reply", async () => {
    const s = await emailSetup();
    await s.ctx.db
      .update(enrollments)
      .set({ status: "stopped", stop_reason: "campaign_stopped" })
      .where(eq(enrollments.id, s.message.enrollment_id ?? ""));
    const { job, first } = await compare(s);
    expect(job).toMatchObject({
      status: "cancelled",
      reason: "enrollment_stopped:campaign_stopped",
    });
    expect(await messageRow(s.ctx, s.message.id)).toMatchObject({
      status: "cancelled",
      error: "cancelled: enrollment_stopped:campaign_stopped",
    });
    expect(first).toMatchObject({ code: "enrollment_ended", hard: true });
    expect(first?.message).toBe("Dana Reyes's sequence in Q4 distributors has ended (stopped).");

    const reply = await emailSetup({ message: { action: "reply", step_id: null } });
    await reply.ctx.db
      .update(enrollments)
      .set({ status: "stopped", stop_reason: "replied" })
      .where(eq(enrollments.id, reply.message.enrollment_id ?? ""));
    expect((await compare(reply)).job.status).toBe("sent");
  });

  it("cancels a step of a campaign that was archived", async () => {
    const s = await emailSetup();
    await s.ctx.db
      .update(campaigns)
      .set({ status: "archived" })
      .where(eq(campaigns.id, s.campaign?.id ?? ""));
    const { job, first } = await compare(s);
    expect(job).toMatchObject({ status: "cancelled", reason: "campaign_archived" });
    expect(first).toMatchObject({ code: "campaign_inactive", hard: true });
    expect(first?.message).toBe("Campaign Q4 distributors is archived, so it sends nothing.");
  });

  it("holds a step of a paused sequence until it resumes", async () => {
    const s = await emailSetup();
    await s.ctx.db
      .update(enrollments)
      .set({
        status: "paused",
        stop_reason: "out_of_office",
        paused_until: new Date("2026-09-28T13:00:00Z"),
      })
      .where(eq(enrollments.id, s.message.enrollment_id ?? ""));
    const { job, first } = await compare(s);
    expect(job).toMatchObject({ status: "wait" });
    expect(job.retryAt?.toISOString()).toBe("2026-09-28T13:00:00.000Z");
    expect(first).toMatchObject({ code: "enrollment_paused", hard: false });
    expect(first?.until).toBe(job.retryAt?.toISOString());
    expect(await messageRow(s.ctx, s.message.id)).toMatchObject({ status: "scheduled" });
  });

  it("waits for a paused mailbox when no other mailbox can take the email", async () => {
    const s = await emailSetup({ mailbox: { status: "paused", status_reason: "Paused by Sam" } });
    const { job, first } = await compare(s);
    expect(job).toMatchObject({ status: "wait", waitFor: `mailbox_active:${s.mailbox.id}` });
    expect(first).toMatchObject({ code: "mailbox_paused", hard: true, until: null });
    expect(first?.message).toBe("Mailbox sam@harbor.example.org is paused: Paused by Sam.");
    expect(first?.fix).toContain(`manage_mailboxes action resume (mailbox_id ${s.mailbox.id})`);
  });

  it("moves an email off a paused mailbox to another campaign mailbox", async () => {
    const s = await emailSetup({ mailbox: { status: "paused" }, secondMailbox: {} });
    const { job, first } = await compare(s);
    expect(job.status).toBe("wait");
    expect(first).toMatchObject({ code: "mailbox_paused", hard: false });
    expect(first?.until).toBe(job.retryAt?.toISOString());
    expect(first?.message).toContain("moves to alex@harbor.example.org");
  });

  it("waits out a provider throttle until the same time", async () => {
    const s = await emailSetup({
      mailbox: { health: { throttled_until: new Date(Date.parse(NOW) + 2 * HOUR).toISOString() } },
    });
    const { job, first } = await compare(s);
    expect(job.status).toBe("wait");
    expect(first).toMatchObject({ code: "mailbox_throttled", hard: false });
    expect(first?.until).toBe(job.retryAt?.toISOString());
  });

  it("waits when the mailbox hit its daily cap, until the job's next try", async () => {
    const s = await emailSetup({
      mailbox: { daily_limit: 40 },
      settings: {},
    });
    await s.ctx.db.insert(sender_counters).values({
      sender_type: "mailbox",
      sender_id: s.mailbox.id,
      day: "2026-09-22",
      action: "email",
      count: 40,
    });
    const { job, first } = await compare(s);
    expect(job.status).toBe("wait");
    expect(first).toMatchObject({ code: "daily_cap_reached", hard: false });
    expect(first?.until).toBe(job.retryAt?.toISOString());
    expect(first?.message).toBe(
      "Mailbox sam@harbor.example.org hit its daily cap of 40. Next try tomorrow 13:00 UTC.",
    );
  });

  it("waits for the next window when a late email falls outside it", async () => {
    // 18:30 in Chicago, the email was due an hour ago: the window opens tomorrow 08:00.
    const now = "2026-09-22T23:30:00.000Z";
    const s = await emailSetup({
      now,
      message: { scheduled_for: new Date(Date.parse(now) - HOUR) },
    });
    const { job, first } = await compare(s);
    expect(job.status).toBe("wait");
    expect(first).toMatchObject({ code: "outside_window", hard: false });
    expect(first?.until).toBe(job.retryAt?.toISOString());
    expect(first?.until).toBe("2026-09-23T13:00:00.000Z");
    expect(first?.message).toBe(
      "The send window for Dana Reyes is closed now. It opens tomorrow 08:00 America/Chicago.",
    );
  });

  it("sends a reply a person wrote in a thread a person took over", async () => {
    const s = await emailSetup({
      campaign: false,
      thread: { owner: "person", owner_changed_at: new Date(Date.parse(NOW) - HOUR) },
    });
    const { job } = await compare(s);
    expect(job.status).toBe("sent");
  });

  it("does not send a message that waits for approval", async () => {
    const s = await emailSetup({ message: { status: "pending_review", scheduled_for: null } });
    const [approval] = await s.ctx.db
      .insert(approvals)
      .values({
        workspace_id: s.ctx.workspace.id,
        kind: "message",
        title: "Email to Dana Reyes",
        target_type: "message",
        target_id: s.message.id,
        created_at: new Date(Date.parse(NOW) - 5 * HOUR),
      })
      .returning();
    const { job, first } = await compare(s);
    expect(job).toMatchObject({ status: "noop", reason: "status_pending_review" });
    expect(first).toMatchObject({ code: "approval_pending", hard: true });
    expect(first?.message).toBe("The message waits for approval since today 10:00 UTC.");
    expect(first?.fix).toBe(
      `Decide it with review_items action decide (approval_id ${approval?.id}).`,
    );
  });
});

describe("email eligibility without a queued message", () => {
  it("blocks every channel while a privacy request is open", async () => {
    const s = await emailSetup();
    const [problem] = await s.ctx.db
      .insert(problems)
      .values({
        workspace_id: s.ctx.workspace.id,
        kind: "privacy_request",
        severity: "urgent",
        title: "Privacy request from Dana Reyes",
        reason: "Asked what data we hold.",
        remedy: "Answer within 30 days.",
        person_id: s.person.id,
        dedupe_key: `privacy_request:${s.message.id}`,
      })
      .returning();
    for (const channel of ["email", "linkedin"] as const) {
      const view = await checkEligibility(s.ctx, { personId: s.person.id, channel });
      expect(view.blockers.map((item) => item.code)).toContain("privacy_request_open");
      const item = view.blockers.find((entry) => entry.code === "privacy_request_open");
      expect(item?.fix).toContain(`resolve_exception action resolve (problem_id ${problem?.id})`);
    }
  });

  it("finds the person's next open message when no message id is given", async () => {
    const s = await emailSetup({ person: { status: "unsubscribed" } });
    const view = await checkEligibility(s.ctx, { personId: s.person.id, channel: "email" });
    expect(view.blockers[0]).toMatchObject({ code: "person_unsubscribed" });
    expect(view.blockers[0]?.message).toBe("Dana Reyes unsubscribed.");
  });

  it("reports a closed message with its stored reason", async () => {
    const s = await emailSetup({
      message: { status: "failed", error: "Unresolved template variables: city" },
    });
    const view = await checkEligibility(s.ctx, {
      personId: s.person.id,
      channel: "email",
      messageId: s.message.id,
    });
    expect(view.blockers).toHaveLength(1);
    expect(view.blockers[0]?.message).toBe(
      "The message failed: Unresolved template variables: city.",
    );
  });

  it("says who moves a draft on: the sequencer for a step, a send for a reply", async () => {
    const step = await emailSetup({ message: { status: "draft" } });
    const stepView = await checkEligibility(step.ctx, {
      personId: step.person.id,
      channel: "email",
      messageId: step.message.id,
    });
    expect(stepView.blockers[0]).toMatchObject({
      code: "message_draft",
      hard: false,
      message: "The message is a draft: the campaign reviews or schedules it at its next run.",
      fix: `Nothing to do. To change the text first, edit it with manage_messages action update (message_id ${step.message.id}).`,
    });

    const reply = await emailSetup({ campaign: false, message: { status: "draft" } });
    const replyView = await checkEligibility(reply.ctx, {
      personId: reply.person.id,
      channel: "email",
      messageId: reply.message.id,
    });
    expect(replyView.blockers[0]).toMatchObject({
      code: "message_draft",
      hard: true,
      message: "The message is a draft: nobody has sent it or asked for a review yet.",
      fix: `Send it with reply_to_thread action send (thread_id ${reply.thread?.id}, message_id ${reply.message.id}); pass text to change the wording first.`,
    });
  });

  it("names an unknown message instead of guessing", async () => {
    const s = await emailSetup();
    const view = await checkEligibility(s.ctx, {
      personId: s.person.id,
      channel: "email",
      messageId: "msg_does_not_exist",
    });
    expect(view.blockers[0]).toMatchObject({ code: "message_not_found", hard: true });
  });

  it("checks a new email without a message: rest period and the next window", async () => {
    // Saturday 2026-09-26 12:00 UTC: outside the weekday window.
    const s = await emailSetup({ now: "2026-09-26T12:00:00.000Z" });
    await s.ctx.db
      .update(messages)
      .set({ status: "sent", sent_at: new Date("2026-09-25T15:00:00Z") })
      .where(eq(messages.id, s.message.id));
    const other = await seedCampaign(s.ctx, {
      name: "Second touch",
      status: "active",
      settings: { senders: { mailbox_ids: [s.mailbox.id] } },
    });
    const view = await checkEligibility(s.ctx, {
      personId: s.person.id,
      channel: "email",
      campaignId: other.campaign.id,
    });
    expect(view.blockers.map((item) => item.code)).toEqual([
      "active_in_other_campaign",
      "outside_window",
    ]);
    expect(view.blockers[1]).toMatchObject({ until: "2026-09-28T13:00:00.000Z", hard: false });
  });
});

function fakeLinkedIn() {
  return {
    id: "unipile",
    getProfile: async (_account: string, target: { profile_url?: string | null }) => ({
      provider_id: "ACoAAmember",
      profile_url: target.profile_url ?? "",
      connection_degree: 2 as 1 | 2 | 3 | null,
      invitation_pending: false,
    }),
    visitProfile: async () => {},
    sendInvite: async () => ({ providerRef: "ACoAAmember" }),
    sendMessage: async () => ({ messageId: "li_msg_1", chatId: "chat_1" }),
    listRecentPosts: async () => [] as Array<{ id: string; text: string; published_at: string }>,
    reactToPost: async () => {},
    commentOnPost: async () => ({ commentId: "comment_1" }),
  } satisfies LinkedInProvider;
}

async function linkedinSetup(
  options: {
    now?: string;
    account?: Parameters<typeof seedLinkedInAccount>[1];
    company?: Partial<NewCompany>;
    /** The message is a step of a LinkedIn campaign (else an action outside campaigns). */
    step?: boolean;
    /** The account and the person are connected. */
    connected?: boolean;
    message?: Partial<NewMessage>;
  } = {},
) {
  const now = options.now ?? NOW;
  const ctx = await createTestContext({ db, now, providers: { linkedin: fakeLinkedIn() } });
  const account = await seedLinkedInAccount(ctx, {
    provider: "unipile",
    name: "Sam on LinkedIn",
    ...options.account,
  });
  const company = options.company
    ? await seedCompany(ctx, { name: "Harbor Supply Ltd", ...options.company })
    : null;
  const person = await seedPerson(ctx, {
    full_name: "Omar Haddad",
    linkedin_url: "https://www.linkedin.com/in/omar-haddad-example",
    company_id: company?.id ?? null,
  });
  const action = options.message?.action ?? "invite";
  const step = options.step
    ? await seedCampaign(ctx, {
        name: "LinkedIn touch",
        status: "active",
        steps: [{ type: action === "message" ? "linkedin_message" : "linkedin_invite" }],
        settings: { senders: { linkedin_account_ids: [account.id] } },
      })
    : null;
  if (options.connected) {
    await upsertRelation(ctx.db, {
      workspaceId: ctx.workspace.id,
      accountId: account.id,
      personId: person.id,
      status: "connected",
    });
  }
  const message = await seedMessage(ctx, {
    channel: "linkedin",
    action: "invite",
    status: "scheduled",
    subject: null,
    body_text: "",
    linkedin_account_id: account.id,
    person_id: person.id,
    company_id: company?.id ?? null,
    scheduled_for: new Date(now),
    campaign_id: step?.campaign.id ?? null,
    step_id: step?.steps[0]?.id ?? null,
    ...options.message,
  });
  return { ctx, account, company, person, message };
}

async function compareLinkedIn(s: Awaited<ReturnType<typeof linkedinSetup>>) {
  await s.ctx.reloadWorkspace();
  const view = await checkEligibility(s.ctx, {
    personId: s.person.id,
    channel: "linkedin",
    messageId: s.message.id,
  });
  let job: JobRun;
  try {
    const result = await runLinkedInAction(
      s.ctx.jobContext({ name: "linkedin.action" }),
      s.message.id,
    );
    job = { status: result.status, ...("reason" in result ? { reason: result.reason } : {}) };
  } catch (error) {
    if (!isJobWaitError(error)) throw error;
    job = {
      status: "wait",
      waitFor: error.waitFor,
      ...(error.retryAt ? { retryAt: error.retryAt } : {}),
    };
  }
  expect(view.ok).toBe(job.status === "sent");
  return { view, job, first: view.blockers[0] };
}

describe("LinkedIn eligibility matches the action job", () => {
  it("sends an invitation when nothing blocks", async () => {
    const { job, view } = await compareLinkedIn(await linkedinSetup());
    expect(job.status).toBe("sent");
    expect(view.blockers).toEqual([]);
  });

  it("parks an action of a restricted account", async () => {
    const s = await linkedinSetup({
      account: { status: "restricted", status_reason: "LinkedIn asked for a verification" },
    });
    const { job, first } = await compareLinkedIn(s);
    expect(job.status).toBe("paused");
    expect(first).toMatchObject({ code: "linkedin_account_restricted", hard: true });
    expect(first?.message).toBe(
      "LinkedIn account Sam on LinkedIn is restricted by LinkedIn: LinkedIn asked for a verification.",
    );
    expect(first?.fix).toContain(`manage_linkedin action resume (account_id ${s.account.id})`);
  });

  it("waits outside working hours until the same slot", async () => {
    // 07:00 in Chicago: the account works from 09:00.
    const s = await linkedinSetup({ now: "2026-09-22T12:00:00.000Z" });
    const { job, first } = await compareLinkedIn(s);
    expect(job.status).toBe("wait");
    expect(first).toMatchObject({ code: "linkedin_outside_hours", hard: false });
    expect(first?.until).toBe(job.retryAt?.toISOString());
    expect(first?.message).toContain("Next slot today 09:");
  });

  it("skips a message to someone who is not connected", async () => {
    const s = await linkedinSetup({
      message: { action: "message", body_text: "Thanks for connecting." },
    });
    const { job, first } = await compareLinkedIn(s);
    expect(job).toMatchObject({ status: "skipped", reason: "not_connected" });
    expect(first).toMatchObject({ code: "not_connected", hard: true });
  });

  it("sends a message once connected", async () => {
    const s = await linkedinSetup({
      message: { action: "message", body_text: "Thanks for connecting." },
    });
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "connected",
    });
    const { job } = await compareLinkedIn(s);
    expect(job.status).toBe("sent");
  });

  it("waits while the workspace is paused", async () => {
    const s = await linkedinSetup();
    await s.ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, s.ctx.workspace.id));
    const { job, first } = await compareLinkedIn(s);
    expect(job).toMatchObject({
      status: "wait",
      waitFor: `workspace_active:${s.ctx.workspace.id}`,
    });
    expect(first).toMatchObject({ code: "workspace_paused", hard: true });
    expect((await messageRow(s.ctx, s.message.id)).status).toBe("scheduled");
  });

  it("skips every action while a privacy request is open", async () => {
    const s = await linkedinSetup({
      connected: true,
      message: { action: "message", body_text: "Thanks for the note." },
    });
    await openPrivacyRequest(s.ctx, s.person.id, s.message.id);
    const { job, first } = await compareLinkedIn(s);
    expect(job).toMatchObject({
      status: "skipped",
      reason: "not_contactable:privacy_request_open",
    });
    expect(await messageRow(s.ctx, s.message.id)).toMatchObject({
      status: "skipped",
      error: "skipped: not_contactable:privacy_request_open",
    });
    expect(first).toMatchObject({ code: "privacy_request_open", hard: true });
  });

  it("waits for a company hold on a campaign step, but answers in a conversation", async () => {
    const hold = {
      hold_until: new Date("2026-10-06T07:00:00Z"),
      hold_reason: "signed with a rival",
    };
    const step = await linkedinSetup({ company: hold, step: true });
    const held = await compareLinkedIn(step);
    expect(held.job).toMatchObject({
      status: "wait",
      waitFor: `company_hold:${step.company?.id}`,
    });
    expect(held.first).toMatchObject({
      code: "company_on_hold",
      until: "2026-10-06T07:00:00.000Z",
      hard: false,
    });

    const answer = await linkedinSetup({
      company: hold,
      connected: true,
      message: { action: "message", body_text: "Happy to help." },
    });
    expect((await compareLinkedIn(answer)).job.status).toBe("sent");
  });

  it("cancels a campaign step in a conversation a person took over", async () => {
    const s = await linkedinSetup({
      step: true,
      connected: true,
      message: { action: "message", body_text: "Following up on my note." },
    });
    await seedThread(s.ctx, {
      channel: "linkedin",
      linkedin_account_id: s.account.id,
      person_id: s.person.id,
      owner: "person",
    });
    const { job, first } = await compareLinkedIn(s);
    expect(job).toMatchObject({ status: "cancelled", reason: "superseded_by_person" });
    expect(await messageRow(s.ctx, s.message.id)).toMatchObject({
      status: "cancelled",
      error: "superseded_by_person",
    });
    expect(first).toMatchObject({ code: "thread_owned_by_person", hard: true });
  });

  it("cancels a campaign invitation whose sequence stopped", async () => {
    const s = await linkedinSetup({ step: true });
    const enrollment = await seedEnrollment(s.ctx, {
      campaign_id: s.message.campaign_id ?? "",
      person_id: s.person.id,
      status: "stopped",
      stop_reason: "person_took_over",
    });
    await s.ctx.db
      .update(messages)
      .set({ enrollment_id: enrollment.id })
      .where(eq(messages.id, s.message.id));
    const { job, first } = await compareLinkedIn(s);
    expect(job).toMatchObject({
      status: "cancelled",
      reason: "enrollment_stopped:person_took_over",
    });
    expect(await messageRow(s.ctx, s.message.id)).toMatchObject({
      status: "cancelled",
      error: "enrollment_stopped:person_took_over",
    });
    expect(first).toMatchObject({ code: "enrollment_ended", hard: true });
  });

  it("sends a message a person wrote in a conversation a person took over", async () => {
    const s = await linkedinSetup({ connected: true });
    const thread = await seedThread(s.ctx, {
      channel: "linkedin",
      linkedin_account_id: s.account.id,
      person_id: s.person.id,
      owner: "person",
    });
    await s.ctx.db
      .update(messages)
      .set({ action: "message", body_text: "Thanks, see you Tuesday.", thread_id: thread.id })
      .where(eq(messages.id, s.message.id));
    const { job } = await compareLinkedIn(s);
    expect(job.status).toBe("sent");
  });

  it("says when an invitation is pending instead of messaging", async () => {
    const s = await linkedinSetup();
    await upsertRelation(s.ctx.db, {
      workspaceId: s.ctx.workspace.id,
      accountId: s.account.id,
      personId: s.person.id,
      status: "invited",
    });
    const view = await checkEligibility(s.ctx, {
      personId: s.person.id,
      channel: "linkedin",
      action: "message",
      messageId: null,
    });
    const item = view.blockers.find((entry) => entry.code === "not_connected");
    expect(item).toMatchObject({ hard: false, fix: null });
    expect(item?.message).toBe(
      "Omar Haddad has not accepted the connection invitation yet, so a message cannot be sent.",
    );
  });
});
