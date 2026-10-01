/**
 * Sequencer state machine through the tick, the generation job, the approval resolver and the
 * `message.sent` handler. Channel modules are mocked (planning returns a slot, queueing marks
 * the message scheduled); sends are simulated by marking messages sent and firing the event.
 */
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actorRef } from "../../../core/context.js";
import { JobWaitError } from "../../../core/errors.js";
import type { EventData, EventHandlerDefinition, EventType } from "../../../core/events.js";
import type { CampaignSettingsInput, WorkspaceSettingsInput } from "../../../core/settings.js";
import {
  type Approval,
  approvals,
  type CampaignStep,
  campaign_steps,
  campaigns,
  companies,
  type Enrollment,
  enrollment_step_runs,
  enrollments,
  list_members,
  lists,
  type Message,
  messages,
  type NewEnrollment,
  type NewPerson,
  type Person,
  people,
  tasks,
  workspaces,
} from "../../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { createTestDb, type TestDb } from "../../../testing/db.js";
import {
  type SeedStep,
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedLinkedInAccount,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../../testing/factories.js";
import { planEmailSend, queueEmailSend } from "../../email/service.js";
import { buildGroundingPack } from "../../knowledge/service.js";
import { checkContactable } from "../../leads/service.js";
import {
  getRecentPostForPerson,
  getRelation,
  planLinkedInAction,
  queueLinkedInAction,
} from "../../linkedin/service.js";
import { getLatestBrief } from "../../research/service.js";
import { getActiveSignals, markSignalsUsed } from "../../signals/service.js";
import { messageResolver } from "../approvals.js";
import { pauseEnrollments, resumeEnrollments } from "../control.js";
import { advanceOnSent, wakeOnConnected, wakeOnFailed } from "../events.js";
import { updateMessage } from "../operations/messages.js";
import { loadPeople } from "../people.js";
import { loadCampaign } from "../repo.js";
import { approveAndSchedule, CONNECTION_WAIT_MS, isGlobalBlock } from "./channel-step.js";
import { signWebhook } from "./flow-steps.js";
import { GENERATE_JOB, generateMessageJob } from "./generate.js";
import { loadStepStateForMessage } from "./load.js";
import { processEnrollment, runTick, tickJob } from "./tick.js";

vi.mock("../../leads/service.js", () => ({
  checkContactable: vi.fn(),
  resolvePeople: vi.fn(),
  wrappedLeadContext: vi.fn(async () => null),
}));
vi.mock("../../email/service.js", () => ({ planEmailSend: vi.fn(), queueEmailSend: vi.fn() }));
vi.mock("../../linkedin/service.js", () => ({
  planLinkedInAction: vi.fn(),
  queueLinkedInAction: vi.fn(),
  getRelation: vi.fn(),
  getRecentPostForPerson: vi.fn(),
}));
vi.mock("../../signals/service.js", () => ({
  getActiveSignals: vi.fn(),
  markSignalsUsed: vi.fn(),
}));
vi.mock("../../research/service.js", () => ({ getLatestBrief: vi.fn() }));
vi.mock("../../knowledge/service.js", () => ({ buildGroundingPack: vi.fn() }));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const GOOD_BODY =
  "Hi Dana, I saw that Harbor opened a second clinic in Round Rock this month. New locations usually mean the front desk juggles twice the calls while the team settles in. We answer overflow calls for dental groups so patients never hit voicemail during lunch. Would that be useful while Round Rock ramps up?";
const FOLLOW_UP =
  "Following up on my note about the front desk. Is covering the lunch rush on your list this quarter?";
const COMMENT =
  "Opening a second clinic is the moment phone coverage gets tested. The groups I see do best route lunch overflow somewhere friendly so patients never hear voicemail in the first busy weeks.";

const goodEmail = {
  subject: "round rock front desk",
  body: GOOD_BODY,
  angle: "Coverage while the new clinic ramps up",
  signals_used: [],
  facts_used: [],
};
const passCheck = { verdict: "pass", confidence: 0.92, issues: [] };

function defaults() {
  vi.clearAllMocks();
  vi.mocked(checkContactable).mockResolvedValue({ ok: true, reasons: [] });
  vi.mocked(planEmailSend).mockImplementation(async (_ctx, input) => ({
    ok: true,
    mailboxId: input.preferredMailboxId ?? input.mailboxIds[0] ?? "mbx_missing",
    sendAt: input.notBefore ?? new Date(0),
  }));
  vi.mocked(queueEmailSend).mockImplementation(async (ctx, messageId) => {
    await ctx.db.update(messages).set({ status: "scheduled" }).where(eq(messages.id, messageId));
  });
  vi.mocked(planLinkedInAction).mockImplementation(async (_ctx, input) => ({
    ok: true,
    accountId: input.preferredAccountId ?? input.accountIds[0] ?? "lia_missing",
    runAt: input.notBefore ?? new Date(0),
  }));
  vi.mocked(queueLinkedInAction).mockImplementation(async (ctx, messageId) => {
    await ctx.db.update(messages).set({ status: "scheduled" }).where(eq(messages.id, messageId));
  });
  vi.mocked(getRelation).mockResolvedValue("none");
  vi.mocked(getRecentPostForPerson).mockResolvedValue(null);
  vi.mocked(getActiveSignals).mockResolvedValue([]);
  vi.mocked(markSignalsUsed).mockResolvedValue(undefined);
  vi.mocked(getLatestBrief).mockResolvedValue(null);
  vi.mocked(buildGroundingPack).mockResolvedValue({
    company: { name: "Brightline Answering", website: "https://brightline.example.org" },
    offer: null,
    rules: [],
    facts: [],
    voiceSamples: [],
    text: "## OUR KNOWLEDGE\nBrightline answers overflow calls for dental groups.",
  });
}

let db: TestDb;
const contexts: TestContext[] = [];
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await Promise.all(contexts.map((ctx) => ctx.close()));
  await db.close();
});
beforeEach(defaults);

interface World {
  ctx: TestContext;
  person: Person;
  mailboxId: string;
  accountId: string;
  campaignId: string;
  steps: CampaignStep[];
  enrollment: Enrollment;
}

async function world(
  options: {
    steps: SeedStep[];
    settings?: CampaignSettingsInput;
    workspaceSettings?: WorkspaceSettingsInput;
    person?: Partial<NewPerson>;
    enrollment?: Partial<NewEnrollment>;
    campaignStatus?: "active" | "paused" | "draft";
  } = { steps: [{ type: "email" }] },
): Promise<World> {
  const ctx = await createTestContext({
    db,
    ...(options.workspaceSettings ? { settings: options.workspaceSettings } : {}),
    brain: {
      "campaign.email.write": (vars: { first_touch: boolean }) =>
        vars.first_touch ? goodEmail : { ...goodEmail, body: FOLLOW_UP },
      "campaign.email.check": passCheck,
      "campaign.linkedin.write": {
        text: COMMENT,
        angle: "Useful thought",
        signals_used: [],
        facts_used: [],
      },
    },
  });
  contexts.push(ctx);
  const company = await seedCompany(ctx, { name: "Harbor Dental" });
  const person = await seedPerson(ctx, {
    first_name: "Dana",
    last_name: "Reyes",
    full_name: "Dana Reyes",
    company_id: company.id,
    linkedin_url: "https://www.linkedin.com/in/dana-reyes-example",
    ...options.person,
  });
  const mailbox = await seedMailbox(ctx);
  const account = await seedLinkedInAccount(ctx);
  const { campaign, steps } = await seedCampaign(ctx, {
    status: options.campaignStatus ?? "active",
    settings: {
      review_level: "unsure",
      senders: { mailbox_ids: [mailbox.id], linkedin_account_ids: [account.id] },
      ...options.settings,
    },
    steps: options.steps,
  });
  const enrollment = await seedEnrollment(ctx, {
    campaign_id: campaign.id,
    person_id: person.id,
    status: "active",
    current_step: 0,
    next_run_at: ctx.clock.now(),
    variant_seed: 0,
    enrolled_at: new Date(ctx.clock.now().getTime() - HOUR),
    ...options.enrollment,
  });
  return {
    ctx,
    person,
    mailboxId: mailbox.id,
    accountId: account.id,
    campaignId: campaign.id,
    steps,
    enrollment,
  };
}

const tick = (w: World) => runTick(w.ctx.jobContext({ name: "campaigns.tick" }));

async function reload(w: World): Promise<Enrollment> {
  const [row] = await w.ctx.db
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, w.enrollment.id));
  if (!row) throw new Error("enrollment is gone");
  return row;
}

async function stepMessages(w: World): Promise<Message[]> {
  return w.ctx.db
    .select()
    .from(messages)
    .where(eq(messages.enrollment_id, w.enrollment.id))
    .orderBy(asc(messages.created_at), asc(messages.id));
}

async function onlyMessage(w: World): Promise<Message> {
  const rows = await stepMessages(w);
  expect(rows).toHaveLength(1);
  return rows[0] as Message;
}

async function runs(w: World) {
  return w.ctx.db
    .select()
    .from(enrollment_step_runs)
    .where(eq(enrollment_step_runs.enrollment_id, w.enrollment.id))
    .orderBy(asc(enrollment_step_runs.position), asc(enrollment_step_runs.attempt));
}

/** Runs the generation job for every message still generating. */
async function generate(w: World): Promise<void> {
  for (const message of await stepMessages(w)) {
    if (message.status !== "generating") continue;
    await generateMessageJob.handler(w.ctx.jobContext({ name: GENERATE_JOB }), {
      message_id: message.id,
    });
  }
}

async function fire<T extends EventType>(
  w: World,
  handler: EventHandlerDefinition<T>,
  data: EventData[T],
): Promise<void> {
  await handler.handler(w.ctx.jobContext(), {
    id: "evt_test",
    type: handler.event,
    workspaceId: w.ctx.workspace.id,
    subject: null,
    data,
    occurredAt: w.ctx.clock.now(),
  });
}

/** Simulates the channel module sending the message, then the `message.sent` handler. */
async function markSent(w: World, message: Message, threadId: string | null = null) {
  const sentAt = w.ctx.clock.now();
  await w.ctx.db
    .update(messages)
    .set({
      status: "sent",
      sent_at: sentAt,
      thread_id: threadId ?? message.thread_id,
      message_id_header: `<${message.id}@example.org>`,
    })
    .where(eq(messages.id, message.id));
  await fire(w, advanceOnSent, {
    message_id: message.id,
    thread_id: threadId,
    person_id: message.person_id,
    campaign_id: message.campaign_id,
    channel: message.channel,
    action: message.action,
    sent_at: sentAt.toISOString(),
  });
}

async function approvalFor(w: World, messageId: string): Promise<Approval> {
  const [row] = await w.ctx.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.target_type, "message"), eq(approvals.target_id, messageId)));
  if (!row) throw new Error(`no approval for ${messageId}`);
  return row;
}

const at = (w: World, ms: number) => new Date(w.ctx.clock.now().getTime() + ms);

describe("email steps", () => {
  it("generates, waits for review, applies edits, schedules, advances on sent and ends", async () => {
    const w = await world({
      steps: [{ type: "email" }],
      settings: { review_level: "every", end_action: { type: "tag", value: "sequence_done" } },
    });

    expect(await tick(w)).toMatchObject({ processed: 1, errors: 0 });
    let message = await onlyMessage(w);
    expect(message).toMatchObject({ status: "generating", step_id: w.steps[0]?.id, attempt: 1 });
    expect(w.ctx.enqueued(GENERATE_JOB)).toHaveLength(1);
    expect((await reload(w)).next_run_at).toEqual(at(w, 5 * MINUTE));

    await generate(w);
    message = await onlyMessage(w);
    expect(message).toMatchObject({ status: "draft", subject: "round rock front desk" });
    expect(message.check).toMatchObject({ passed: true, verdict: "pass" });
    expect(w.ctx.emitted("message.drafted")).toHaveLength(1);
    expect((await reload(w)).next_run_at).toEqual(w.ctx.clock.now());

    await tick(w);
    message = await onlyMessage(w);
    expect(message.status).toBe("pending_review");
    expect(await reload(w)).toMatchObject({ status: "waiting_review" });
    const approval = await approvalFor(w, message.id);
    expect(approval).toMatchObject({ kind: "message", status: "pending" });
    expect(approval.payload).toMatchObject({
      message_id: message.id,
      subject: "round rock front desk",
      body: GOOD_BODY,
      person_name: "Dana Reyes",
      check: { verdict: "pass" },
    });

    const edited = `${GOOD_BODY} Happy to share how others staff it.`;
    const result = await messageResolver.apply(w.ctx, approval, {
      decision: "edit",
      edits: { body: edited },
      decidedBy: actorRef(w.ctx.principal),
    });
    expect(result.data).toMatchObject({ status: "scheduled", edited: true });
    message = await onlyMessage(w);
    expect(message).toMatchObject({
      status: "scheduled",
      body_text: edited,
      mailbox_id: w.mailboxId,
      scheduled_for: w.ctx.clock.now(),
    });
    expect(message.why).toMatchObject({ original: { body: GOOD_BODY } });
    expect(vi.mocked(planEmailSend).mock.calls[0]?.[1]).toMatchObject({
      mailboxIds: [w.mailboxId],
      recipientEmail: w.person.email,
      recipientTimezone: "America/Chicago",
    });
    expect(queueEmailSend).toHaveBeenCalledTimes(1);
    expect(w.ctx.emitted("message.approved")).toHaveLength(1);
    expect(await reload(w)).toMatchObject({ status: "active", mailbox_id: w.mailboxId });

    expect(await tick(w)).toMatchObject({ processed: 0 });

    w.ctx.clock.advanceBy({ minutes: 3 });
    await markSent(w, message);
    const done = await reload(w);
    expect(done).toMatchObject({ status: "completed", next_run_at: null });
    const [person] = await w.ctx.db.select().from(people).where(eq(people.id, w.person.id));
    expect(person?.tags).toContain("sequence_done");
    expect((await runs(w)).map((run) => run.status)).toEqual(["done"]);
  });

  it("reviews only the first message at level first and threads the follow-up", async () => {
    const w = await world({
      steps: [
        { type: "email" },
        { type: "email", delay_days: 3, config: { mode: "reply", style: "free", max_words: 70 } },
      ],
      settings: { review_level: "first" },
    });
    await tick(w);
    await generate(w);
    await tick(w);
    const first = await onlyMessage(w);
    expect(first.status).toBe("pending_review");
    await messageResolver.apply(w.ctx, await approvalFor(w, first.id), {
      decision: "approve",
      decidedBy: actorRef(w.ctx.principal),
    });
    const thread = await seedThread(w.ctx, { person_id: w.person.id });
    await markSent(w, await onlyMessage(w), thread.id);
    const moved = await reload(w);
    expect(moved).toMatchObject({ status: "active", current_step: 1 });
    expect(moved.next_run_at).toEqual(at(w, 3 * DAY));

    w.ctx.clock.advanceBy({ days: 3 });
    await tick(w);
    await generate(w);
    await tick(w);
    const second = (await stepMessages(w))[1];
    expect(second).toMatchObject({
      status: "scheduled",
      subject: "Re: round rock front desk",
      thread_id: thread.id,
      in_reply_to: `<${first.id}@example.org>`,
      body_text: FOLLOW_UP,
    });
    expect(w.ctx.recorded.approvals).toHaveLength(1);
    expect(vi.mocked(planEmailSend).mock.calls[1]?.[1]).toMatchObject({
      mailboxIds: [w.mailboxId],
      preferredMailboxId: w.mailboxId,
    });
  });

  it.each([
    { name: "a confident pass sends", check: passCheck, review: false },
    {
      name: "low confidence goes to review",
      check: { verdict: "pass", confidence: 0.5, issues: [] },
      review: true,
    },
    {
      name: "a revise verdict goes to review",
      check: {
        verdict: "revise",
        confidence: 0.9,
        issues: [{ code: "generic", message: "Generic.", severity: "warning" }],
      },
      review: true,
    },
  ])("level unsure: $name", async ({ check, review }) => {
    const w = await world({ steps: [{ type: "email" }], settings: { review_level: "unsure" } });
    w.ctx.brain.on("campaign.email.check", check);
    await tick(w);
    await generate(w);
    await tick(w);
    const message = await onlyMessage(w);
    expect(message.status).toBe(review ? "pending_review" : "scheduled");
    expect(w.ctx.recorded.approvals).toHaveLength(review ? 1 : 0);
  });

  it("holds approved messages of a paused campaign until it runs again", async () => {
    const w = await world({ steps: [{ type: "email" }], settings: { review_level: "every" } });
    await tick(w);
    await generate(w);
    await tick(w);
    const message = await onlyMessage(w);
    await w.ctx.db
      .update(campaigns)
      .set({ status: "paused" })
      .where(eq(campaigns.id, w.campaignId));
    const result = await messageResolver.apply(w.ctx, await approvalFor(w, message.id), {
      decision: "approve",
      decidedBy: actorRef(w.ctx.principal),
    });
    expect(result.data).toMatchObject({ status: "waiting:campaign_paused" });
    expect(await onlyMessage(w)).toMatchObject({ status: "approved", scheduled_for: null });
    expect(planEmailSend).not.toHaveBeenCalled();
    expect(await tick(w)).toMatchObject({ processed: 0 });

    await w.ctx.db
      .update(campaigns)
      .set({ status: "active" })
      .where(eq(campaigns.id, w.campaignId));
    await tick(w);
    expect(await onlyMessage(w)).toMatchObject({ status: "scheduled" });
  });

  it("rejecting a review cancels the message and skips the step", async () => {
    const w = await world({
      steps: [{ type: "email" }, { type: "task", config: { title: "Call {{first_name}}" } }],
      settings: { review_level: "every" },
    });
    await tick(w);
    await generate(w);
    await tick(w);
    const message = await onlyMessage(w);
    const result = await messageResolver.apply(w.ctx, await approvalFor(w, message.id), {
      decision: "reject",
      decidedBy: actorRef(w.ctx.principal),
    });
    expect(result.message).toContain("skipped");
    expect(await onlyMessage(w)).toMatchObject({ status: "cancelled", error: "rejected" });
    expect(await reload(w)).toMatchObject({ status: "active", current_step: 1 });
    expect((await runs(w))[0]).toMatchObject({ status: "skipped", detail: { reason: "rejected" } });
  });

  it("skips the step when the review expires", async () => {
    const w = await world({ steps: [{ type: "email" }], settings: { review_level: "every" } });
    await tick(w);
    await generate(w);
    await tick(w);
    const message = await onlyMessage(w);
    await w.ctx.db
      .update(approvals)
      .set({ status: "expired" })
      .where(eq(approvals.target_id, message.id));
    w.ctx.clock.advanceBy({ hours: 7 });
    await tick(w);
    expect(await onlyMessage(w)).toMatchObject({ status: "cancelled", error: "approval_expired" });
    expect(await reload(w)).toMatchObject({ status: "completed" });
  });

  it("renders exact templates and schedules in one tick, retrying when capacity is full", async () => {
    const w = await world({
      steps: [
        {
          type: "email",
          config: {
            style: "exact",
            subject: "front desk at {{company}}",
            body: "Hi {{first_name}}, we answer overflow calls for {{company}}. Worth a look?",
          },
        },
      ],
    });
    vi.mocked(planEmailSend).mockResolvedValueOnce({
      ok: false,
      reason: "no_capacity",
      retryAt: at(w, 2 * HOUR),
    });
    await tick(w);
    let message = await onlyMessage(w);
    expect(message).toMatchObject({
      status: "approved",
      scheduled_for: null,
      subject: "front desk at Harbor Dental",
    });
    expect(w.ctx.recorded.brain).toHaveLength(0);
    expect((await reload(w)).next_run_at).toEqual(at(w, 2 * HOUR));
    expect((await runs(w))[0]?.detail).toMatchObject({ plan_failure: "no_capacity" });

    w.ctx.clock.advanceBy({ hours: 2 });
    await tick(w);
    message = await onlyMessage(w);
    expect(message.status).toBe("scheduled");
    expect(queueEmailSend).toHaveBeenCalledTimes(1);
  });

  it("gives higher-priority campaigns sender capacity first", async () => {
    const ctx = await createTestContext({ db });
    contexts.push(ctx);
    const mailbox = await seedMailbox(ctx);
    const exact = {
      type: "email" as const,
      config: { style: "exact", subject: "hello", body: "Hi {{first_name}}, worth a look?" },
    };
    const low = await seedCampaign(ctx, {
      status: "active",
      settings: { priority: 10, review_level: "unsure", senders: { mailbox_ids: [mailbox.id] } },
      steps: [exact],
    });
    const high = await seedCampaign(ctx, {
      status: "active",
      settings: { priority: 90, review_level: "unsure", senders: { mailbox_ids: [mailbox.id] } },
      steps: [exact],
    });
    const lowPerson = await seedPerson(ctx, { company_id: (await seedCompany(ctx)).id });
    const highPerson = await seedPerson(ctx, { company_id: (await seedCompany(ctx)).id });
    const now = ctx.clock.now();
    await seedEnrollment(ctx, {
      campaign_id: low.campaign.id,
      person_id: lowPerson.id,
      next_run_at: new Date(now.getTime() - HOUR),
    });
    await seedEnrollment(ctx, {
      campaign_id: high.campaign.id,
      person_id: highPerson.id,
      next_run_at: now,
    });
    let slots = 1;
    vi.mocked(planEmailSend).mockImplementation(async (_ctx, input) => {
      if (slots <= 0)
        return { ok: false, reason: "no_capacity", retryAt: new Date(now.getTime() + DAY) };
      slots -= 1;
      return { ok: true, mailboxId: input.mailboxIds[0] ?? "", sendAt: now };
    });
    await runTick(ctx.jobContext());
    expect(vi.mocked(planEmailSend).mock.calls[0]?.[1].recipientEmail).toBe(highPerson.email);
    const statusOf = async (personId: string) =>
      (await ctx.db.select().from(messages).where(eq(messages.person_id, personId)))[0]?.status;
    expect(await statusOf(highPerson.id)).toBe("scheduled");
    expect(await statusOf(lowPerson.id)).toBe("approved");
  });

  it("starts a new thread from another mailbox when the thread's mailbox is gone", async () => {
    const w = await world({
      steps: [{ type: "email", config: { mode: "reply", style: "exact", body: "Any thoughts?" } }],
    });
    const thread = await seedThread(w.ctx, { person_id: w.person.id });
    await seedMessage(w.ctx, {
      enrollment_id: w.enrollment.id,
      campaign_id: w.campaignId,
      person_id: w.person.id,
      status: "sent",
      thread_id: thread.id,
      subject: "front desk",
      message_id_header: "<first@example.org>",
      sent_at: new Date(w.ctx.clock.now().getTime() - DAY),
    });
    const other = await seedMailbox(w.ctx);
    vi.mocked(planEmailSend).mockImplementation(async (_ctx, input) =>
      input.mailboxIds.includes("mbx_gone")
        ? { ok: false, reason: "no_active_mailbox" }
        : { ok: true, mailboxId: other.id, sendAt: w.ctx.clock.now() },
    );
    await w.ctx.db
      .update(enrollments)
      .set({ mailbox_id: "mbx_gone" })
      .where(eq(enrollments.id, w.enrollment.id));
    await tick(w);
    const reply = (await stepMessages(w)).find((m) => m.status !== "sent");
    expect(reply).toMatchObject({
      status: "scheduled",
      mailbox_id: other.id,
      thread_id: null,
      in_reply_to: null,
      subject: "front desk",
    });
  });
});

describe("text edits (manage_messages action update)", () => {
  const EDITED =
    "Hi Dana, a different note that no person has read yet. Would a short call about the front desk help this week?";
  const FAILING = "Hi Dana, act now! Click here https://example.com/limited-offer";

  /** An agent key with its default scopes: it must ask before anything goes out. */
  const agent = (w: World) =>
    w.ctx.with({
      principal: {
        type: "agent",
        id: "key_editor_agent",
        name: "Editor agent",
        scopes: ["read", "write", "send", "spend"],
      },
    });

  /** A person's decision as approvals.decide makes it: the approval is claimed, then applied. */
  async function decide(w: World, approval: Approval, decision: "approve" | "reject") {
    const [claimed] = await w.ctx.db
      .update(approvals)
      .set({
        status: decision === "approve" ? "approved" : "rejected",
        decided_by: actorRef(w.ctx.principal),
        decided_at: w.ctx.clock.now(),
      })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")))
      .returning();
    if (!claimed) throw new Error(`approval ${approval.id} is not pending`);
    return messageResolver.apply(w.ctx, claimed, {
      decision,
      decidedBy: actorRef(w.ctx.principal),
    });
  }

  async function pendingFor(w: World, messageId: string): Promise<Approval[]> {
    return w.ctx.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.target_type, "message"),
          eq(approvals.target_id, messageId),
          eq(approvals.status, "pending"),
        ),
      );
  }

  /** A message a person approved while its campaign was paused: it waits as `approved`. */
  async function approvedWhilePaused(w: World): Promise<Message> {
    await tick(w);
    await generate(w);
    await tick(w);
    const message = await onlyMessage(w);
    await w.ctx.db
      .update(campaigns)
      .set({ status: "paused" })
      .where(eq(campaigns.id, w.campaignId));
    await decide(w, await approvalFor(w, message.id), "approve");
    const approved = await onlyMessage(w);
    expect(approved).toMatchObject({ status: "approved", scheduled_for: null });
    return approved;
  }

  it("sends an approved message an agent changed back to review, and only the reviewed text goes out", async () => {
    const w = await world({ steps: [{ type: "email" }], settings: { review_level: "every" } });
    const message = await approvedWhilePaused(w);

    const result = await updateMessage.handler(agent(w), { message_id: message.id, body: EDITED });
    expect(result).toMatchObject({ status: "awaiting_approval" });
    const pending = await pendingFor(w, message.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: (result as { approval_id: string }).approval_id,
      kind: "message",
      payload: { message_id: message.id, body: EDITED },
      requested_by: { type: "agent", id: "key_editor_agent" },
    });
    expect(await onlyMessage(w)).toMatchObject({
      status: "pending_review",
      body_text: EDITED,
      scheduled_for: null,
    });

    // The campaign runs again: the sequencer holds the message for the review.
    await w.ctx.db
      .update(campaigns)
      .set({ status: "active" })
      .where(eq(campaigns.id, w.campaignId));
    w.ctx.clock.advanceBy({ hours: 7 });
    await tick(w);
    expect(await onlyMessage(w)).toMatchObject({ status: "pending_review" });
    expect(planEmailSend).not.toHaveBeenCalled();
    expect(queueEmailSend).not.toHaveBeenCalled();

    await decide(w, pending[0] as Approval, "approve");
    expect(await onlyMessage(w)).toMatchObject({ status: "scheduled", body_text: EDITED });
  });

  it("keeps a person's edit of an approved message approved", async () => {
    const w = await world({ steps: [{ type: "email" }], settings: { review_level: "every" } });
    const message = await approvedWhilePaused(w);
    const result = await updateMessage.handler(w.ctx, { message_id: message.id, body: EDITED });
    expect(result).toMatchObject({ status: "approved", body_text: EDITED, approval_id: null });
    expect(await pendingFor(w, message.id)).toHaveLength(0);
  });

  it("sends an edit whose checks fail to review, also from a person holding approve", async () => {
    const w = await world({ steps: [{ type: "email" }], settings: { review_level: "every" } });
    const message = await approvedWhilePaused(w);
    const result = await updateMessage.handler(w.ctx, { message_id: message.id, body: FAILING });
    expect(result).toMatchObject({
      status: "pending_review",
      body_text: FAILING,
      check: { passed: false },
    });
    const pending = await pendingFor(w, message.id);
    expect(pending).toHaveLength(1);
    expect((result as { approval_id: string }).approval_id).toBe(pending[0]?.id);
    expect(await onlyMessage(w)).toMatchObject({ status: "pending_review", scheduled_for: null });
  });

  it("replaces a pending review an agent's edit changed, so a person decides on the text they see", async () => {
    const w = await world({ steps: [{ type: "email" }], settings: { review_level: "every" } });
    await tick(w);
    await generate(w);
    await tick(w);
    const message = await onlyMessage(w);
    const first = await approvalFor(w, message.id);
    expect(first.status).toBe("pending");

    const result = await updateMessage.handler(agent(w), { message_id: message.id, body: EDITED });
    expect(result).toMatchObject({ status: "awaiting_approval" });
    const [old] = await w.ctx.db.select().from(approvals).where(eq(approvals.id, first.id));
    expect(old).toMatchObject({ status: "cancelled", payload: { body: GOOD_BODY } });
    const pending = await pendingFor(w, message.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).toMatchObject({ body: EDITED });

    await decide(w, pending[0] as Approval, "approve");
    expect(await onlyMessage(w)).toMatchObject({ status: "scheduled", body_text: EDITED });
  });

  it("applies the text an approval showed, not a later change to the message", async () => {
    const w = await world({ steps: [{ type: "email" }], settings: { review_level: "every" } });
    await tick(w);
    await generate(w);
    await tick(w);
    const message = await onlyMessage(w);
    const approval = await approvalFor(w, message.id);
    // A change that did not reach the approval (a write racing the decision, for example).
    await w.ctx.db.update(messages).set({ body_text: EDITED }).where(eq(messages.id, message.id));
    await decide(w, approval, "approve");
    expect(await onlyMessage(w)).toMatchObject({ status: "scheduled", body_text: GOOD_BODY });
  });

  it("sends an agent's edit of a draft to review at any review level", async () => {
    const w = await world({ steps: [{ type: "email" }], settings: { review_level: "unsure" } });
    await tick(w);
    await generate(w);
    const draft = await onlyMessage(w);
    expect(draft.status).toBe("draft");

    const result = await updateMessage.handler(agent(w), { message_id: draft.id, body: EDITED });
    expect(result).toMatchObject({ status: "awaiting_approval" });
    expect(await onlyMessage(w)).toMatchObject({ status: "pending_review", body_text: EDITED });
    expect(await reload(w)).toMatchObject({ status: "waiting_review" });
    w.ctx.clock.advanceBy({ hours: 7 });
    await tick(w);
    expect(await onlyMessage(w)).toMatchObject({ status: "pending_review" });
    expect(planEmailSend).not.toHaveBeenCalled();

    // The sequencer's own no-review path, holding the draft it read before the edit, leaves the
    // message to the review.
    const state = await loadStepStateForMessage(w.ctx, draft);
    if (!state) throw new Error("state missing");
    expect(await approveAndSchedule(w.ctx, state, draft, { from: ["draft"] })).toBe(
      "pending_review",
    );
    expect(await onlyMessage(w)).toMatchObject({ status: "pending_review", body_text: EDITED });
  });

  it("holds an approved message of a paused enrollment for the review an agent's edit asked for", async () => {
    const w = await world({ steps: [{ type: "email" }], settings: { review_level: "every" } });
    await tick(w);
    await generate(w);
    await tick(w);
    const message = await onlyMessage(w);
    await decide(w, await approvalFor(w, message.id), "approve");
    expect(await onlyMessage(w)).toMatchObject({ status: "scheduled" });
    // An out-of-office pause unschedules it: it waits as approved until the pause ends.
    await pauseEnrollments(w.ctx, [w.enrollment], at(w, 3 * DAY), "out_of_office");
    expect(await onlyMessage(w)).toMatchObject({ status: "approved", scheduled_for: null });
    vi.mocked(planEmailSend).mockClear();

    const result = await updateMessage.handler(agent(w), { message_id: message.id, body: EDITED });
    expect(result).toMatchObject({ status: "awaiting_approval" });
    expect(await reload(w)).toMatchObject({ status: "paused" });
    const [run] = await runs(w);
    expect(run?.approval_id).toBe((result as { approval_id: string }).approval_id);

    await resumeEnrollments(w.ctx, [w.enrollment]);
    await tick(w);
    expect(await onlyMessage(w)).toMatchObject({ status: "pending_review", body_text: EDITED });
    expect(planEmailSend).not.toHaveBeenCalled();

    // Approved during a second pause: it goes out once the pause ends, with the reviewed text.
    await pauseEnrollments(w.ctx, [w.enrollment], at(w, 3 * DAY), "out_of_office");
    const [pending] = await pendingFor(w, message.id);
    const decided = await decide(w, pending as Approval, "approve");
    expect(decided.message).toContain("paused");
    expect(await onlyMessage(w)).toMatchObject({ status: "pending_review" });
    await resumeEnrollments(w.ctx, [w.enrollment]);
    await tick(w);
    expect(await onlyMessage(w)).toMatchObject({ status: "scheduled", body_text: EDITED });
  });

  it("acts on the message the approval targets, whatever its payload names", async () => {
    const w = await world({ steps: [{ type: "email" }], settings: { review_level: "every" } });
    await tick(w);
    await generate(w);
    await tick(w);
    const message = await onlyMessage(w);
    const other = await seedMessage(w.ctx, {
      campaign_id: w.campaignId,
      person_id: w.person.id,
      status: "pending_review",
      subject: "another one",
      body_text: "Hi, a message nobody approved.",
    });
    const approval = await approvalFor(w, message.id);
    const [changed] = await w.ctx.db
      .update(approvals)
      .set({ payload: { ...approval.payload, message_id: other.id } })
      .where(eq(approvals.id, approval.id))
      .returning();
    await decide(w, changed as Approval, "approve");
    expect(await onlyMessage(w)).toMatchObject({ status: "scheduled" });
    const [untouched] = await w.ctx.db.select().from(messages).where(eq(messages.id, other.id));
    expect(untouched?.status).toBe("pending_review");
  });

  it("refuses an agent's change to an approved reply in a thread, which reply_to_thread asks for", async () => {
    const w = await world({ steps: [{ type: "email" }] });
    const thread = await seedThread(w.ctx, { person_id: w.person.id });
    const reply = await seedMessage(w.ctx, {
      campaign_id: w.campaignId,
      person_id: w.person.id,
      thread_id: thread.id,
      action: "reply",
      status: "approved",
      subject: "Re: front desk",
      body_text: "Thursday works, I will send an invite.",
    });
    await expect(
      updateMessage.handler(agent(w), { message_id: reply.id, body: EDITED }),
    ).rejects.toMatchObject({ code: "conflict", hint: expect.stringContaining("reply_to_thread") });
    const [row] = await w.ctx.db.select().from(messages).where(eq(messages.id, reply.id));
    expect(row).toMatchObject({
      status: "approved",
      body_text: "Thursday works, I will send an invite.",
    });
  });
});

describe("crash safety", () => {
  it("creates one message per step even when two workers run the same enrollment", async () => {
    const w = await world({ steps: [{ type: "email" }] });
    const loaded = await loadCampaign(w.ctx, w.campaignId);
    const people = await loadPeople(w.ctx, [w.person.id]);
    const job = w.ctx.jobContext();
    await Promise.all([
      processEnrollment(job, loaded, w.enrollment, people),
      processEnrollment(job, loaded, w.enrollment, people),
    ]);
    const message = await onlyMessage(w);
    expect(await runs(w)).toEqual([
      expect.objectContaining({ attempt: 1, message_id: message.id }),
    ]);
    expect(w.ctx.enqueued(GENERATE_JOB)).toHaveLength(1);
  });

  /** Two workers process the enrollment's first step at once: one message, one run. */
  async function twoWorkers(w: World): Promise<Message> {
    const loaded = await loadCampaign(w.ctx, w.campaignId);
    const people = await loadPeople(w.ctx, [w.person.id]);
    const job = w.ctx.jobContext();
    await Promise.all([
      processEnrollment(job, loaded, w.enrollment, people),
      processEnrollment(job, loaded, w.enrollment, people),
    ]);
    const message = await onlyMessage(w);
    expect(await runs(w)).toEqual([
      expect.objectContaining({ attempt: 1, message_id: message.id }),
    ]);
    return message;
  }

  it("creates one LinkedIn invitation per step even when two workers run the same enrollment", async () => {
    const w = await world({ steps: [{ type: "linkedin_invite" }] });
    expect(await twoWorkers(w)).toMatchObject({ channel: "linkedin", action: "invite" });
  });

  it("creates one LinkedIn message per step even when two workers run the same enrollment", async () => {
    const w = await world({
      steps: [{ type: "linkedin_message", config: { style: "exact", text: "Thanks, Dana." } }],
    });
    vi.mocked(getRelation).mockResolvedValue("connected");
    expect(await twoWorkers(w)).toMatchObject({ channel: "linkedin", action: "message" });
    expect(queueLinkedInAction).toHaveBeenCalledTimes(1);
  });

  it("creates one LinkedIn comment per step even when two workers run the same enrollment", async () => {
    const w = await world({ steps: [{ type: "linkedin_comment" }] });
    vi.mocked(getRecentPostForPerson).mockResolvedValue({
      id: "urn:li:activity:3",
      text: "We opened Round Rock",
    });
    expect(await twoWorkers(w)).toMatchObject({ channel: "linkedin", action: "comment" });
    expect(w.ctx.enqueued(GENERATE_JOB)).toHaveLength(1);
  });

  it("re-running a tick after a crash continues from the stored message", async () => {
    const w = await world({ steps: [{ type: "email" }] });
    await tick(w);
    const message = await onlyMessage(w);
    // The worker died before moving next_run_at: the enrollment is due again right away.
    await w.ctx.db
      .update(enrollments)
      .set({ next_run_at: w.ctx.clock.now() })
      .where(eq(enrollments.id, w.enrollment.id));
    await tick(w);
    await tick(w);
    expect((await onlyMessage(w)).id).toBe(message.id);
    expect(w.ctx.enqueued(GENERATE_JOB)).toHaveLength(1);

    await generate(w);
    await tick(w);
    expect((await onlyMessage(w)).status).toBe("scheduled");
    const state = await loadStepStateForMessage(w.ctx, message);
    if (!state) throw new Error("state missing");
    expect(await approveAndSchedule(w.ctx, state, await onlyMessage(w))).toBe("scheduled");
    expect(queueEmailSend).toHaveBeenCalledTimes(1);
  });

  it("re-queues a claimed send whose queue call never finished", async () => {
    const w = await world({
      steps: [{ type: "email", config: { style: "exact", subject: "hello", body: "Hi, a look?" } }],
    });
    vi.mocked(queueEmailSend).mockRejectedValueOnce(new Error("worker crashed"));
    expect(await tick(w)).toMatchObject({ errors: 1 });
    const claimed = await onlyMessage(w);
    expect(claimed).toMatchObject({ status: "approved", mailbox_id: w.mailboxId });
    expect(claimed.scheduled_for).not.toBeNull();
    await w.ctx.db
      .update(messages)
      .set({ updated_at: new Date(0) })
      .where(eq(messages.id, claimed.id));
    w.ctx.clock.advanceBy({ minutes: 20 });
    await tick(w);
    expect(await onlyMessage(w)).toMatchObject({ status: "scheduled" });
    expect(planEmailSend).toHaveBeenCalledTimes(1);
    expect(queueEmailSend).toHaveBeenCalledTimes(2);
  });

  it("retries a failed send once with the same content, then fails the enrollment", async () => {
    const w = await world({ steps: [{ type: "email" }] });
    await tick(w);
    await generate(w);
    await tick(w);
    const first = await onlyMessage(w);
    const failSend = async (messageId: string) => {
      await w.ctx.db
        .update(messages)
        .set({ status: "failed", error: "smtp_rejected" })
        .where(eq(messages.id, messageId));
      await fire(w, wakeOnFailed, {
        message_id: messageId,
        error: "smtp_rejected",
        retryable: false,
      });
    };
    await failSend(first.id);
    expect((await reload(w)).next_run_at).toEqual(w.ctx.clock.now());
    await tick(w);
    expect(await reload(w)).toMatchObject({ status: "active", current_step: 0 });
    expect((await runs(w))[0]).toMatchObject({ status: "failed", attempt: 1 });

    w.ctx.clock.advanceBy({ hours: 1 });
    await tick(w);
    const retry = (await stepMessages(w))[1];
    expect(retry).toMatchObject({ attempt: 2, status: "scheduled", body_text: first.body_text });
    expect(w.ctx.enqueued(GENERATE_JOB)).toHaveLength(1);

    await failSend(retry?.id ?? "");
    await tick(w);
    expect(await reload(w)).toMatchObject({ status: "failed", stop_reason: "smtp_rejected" });
  });

  it("replaces a failed step message only when it did not go out, or repeats harmlessly", async () => {
    /** The channel module failed the step's message; `beforeHandover` as it recorded it. */
    const failStep = async (w: World, message: Message, beforeHandover: boolean) => {
      await w.ctx.db
        .update(messages)
        .set({
          status: "failed",
          error: "provider_error: no answer",
          why: { ...(message.why ?? {}), failed_before_handover: beforeHandover },
        })
        .where(eq(messages.id, message.id));
      await fire(w, wakeOnFailed, {
        message_id: message.id,
        error: "provider_error: no answer",
        retryable: false,
      });
      await tick(w);
    };

    // A LinkedIn message that may have gone out is never written and sent a second time.
    const sent = await world({
      steps: [{ type: "linkedin_message", config: { style: "exact", text: "Thanks, Dana." } }],
    });
    vi.mocked(getRelation).mockResolvedValue("connected");
    await tick(sent);
    await failStep(sent, await onlyMessage(sent), false);
    expect(await reload(sent)).toMatchObject({
      status: "failed",
      stop_reason: "provider_error: no answer",
    });
    sent.ctx.clock.advanceBy({ hours: 1 });
    await tick(sent);
    expect(await stepMessages(sent)).toHaveLength(1);

    // A visit that may have happened is harmless to repeat: a new message for the step.
    const visit = await world({ steps: [{ type: "linkedin_visit" }] });
    await tick(visit);
    await failStep(visit, await onlyMessage(visit), false);
    expect(await reload(visit)).toMatchObject({ status: "active", current_step: 0 });
    visit.ctx.clock.advanceBy({ hours: 1 });
    await tick(visit);
    expect((await stepMessages(visit)).map((row) => [row.attempt, row.status])).toEqual([
      [1, "failed"],
      [2, "scheduled"],
    ]);
  });

  it("waits for AI budget instead of failing the generation job", async () => {
    const w = await world({ steps: [{ type: "email" }] });
    await tick(w);
    const message = await onlyMessage(w);
    w.ctx.usage.setOverBudget("ai");
    await expect(
      generateMessageJob.handler(w.ctx.jobContext({ name: GENERATE_JOB }), {
        message_id: message.id,
      }),
    ).rejects.toBeInstanceOf(JobWaitError);
    expect((await onlyMessage(w)).status).toBe("generating");
  });
});

describe("flow steps", () => {
  it("creates tasks, honours waits and completes", async () => {
    const w = await world({
      steps: [
        { type: "task", config: { title: "Call {{first_name}}", task_type: "call" } },
        { type: "wait", delay_days: 2 },
        { type: "task", config: { title: "Send a note to {{company}}" } },
      ],
    });
    await tick(w);
    expect(await reload(w)).toMatchObject({ current_step: 1, next_run_at: at(w, 2 * DAY) });
    expect(await tick(w)).toMatchObject({ processed: 0 });
    w.ctx.clock.advanceBy({ days: 2 });
    await tick(w);
    expect(await reload(w)).toMatchObject({ current_step: 2 });
    await tick(w);
    expect(await reload(w)).toMatchObject({ status: "completed" });
    const rows = await w.ctx.db
      .select({ title: tasks.title, type: tasks.type })
      .from(tasks)
      .where(eq(tasks.enrollment_id, w.enrollment.id))
      .orderBy(asc(tasks.created_at));
    expect(rows).toEqual([
      { title: "Call Dana", type: "call" },
      { title: "Send a note to Harbor Dental", type: "other" },
    ]);
  });

  it.each([
    { name: "has_email true jumps to then_step", person: {}, branch: "then", step: 2 },
    { name: "has_email false ends the sequence", person: { email: null }, branch: "else", step: 3 },
  ])("condition: $name", async ({ person, branch, step }) => {
    const w = await world({
      person,
      steps: [
        { type: "condition", config: { if: "has_email", then_step: 2, else_step: 3 } },
        { type: "task", config: { title: "No email path" } },
        { type: "task", config: { title: "Email path" } },
      ],
    });
    await tick(w);
    const enrollment = await reload(w);
    expect(enrollment.current_step).toBe(step);
    expect(enrollment.status).toBe(step === 3 ? "completed" : "active");
    expect((await runs(w))[0]).toMatchObject({ status: "done", detail: { branch } });
  });

  it("evaluates signal, connection, custom field and reply conditions", async () => {
    const cases: Array<{ config: Record<string, unknown>; expect: "then" | "else" }> = [
      { config: { if: "signal_present", signal_key: "new_location" }, expect: "then" },
      { config: { if: "signal_present", signal_key: "hiring" }, expect: "else" },
      { config: { if: "linkedin_connected" }, expect: "then" },
      { config: { if: "custom", custom_field: "segment", custom_value: "dental" }, expect: "then" },
      { config: { if: "custom", custom_field: "segment", custom_value: "legal" }, expect: "else" },
      { config: { if: "has_linkedin" }, expect: "then" },
      { config: { if: "replied" }, expect: "else" },
    ];
    for (const entry of cases) {
      const w = await world({
        person: { custom: { segment: "dental" } },
        steps: [
          { type: "condition", config: entry.config },
          { type: "task", config: { title: "Next" } },
        ],
      });
      vi.mocked(getRelation).mockResolvedValue("connected");
      vi.mocked(getActiveSignals).mockImplementation(async (ctx, input) =>
        input.personId
          ? [
              {
                id: "sig_01k6a3v0q8x3m2n4p5r6s7t8v1",
                workspace_id: ctx.workspace?.id ?? "",
                definition_key: "new_location",
                company_id: null,
                person_id: w.person.id,
                title: "New clinic",
                summary: null,
                evidence_url: null,
                evidence_excerpt: null,
                source: "test",
                occurred_at: null,
                detected_at: new Date(0),
                strength: 1,
                score: 50,
                status: "new",
                dedupe_key: "x",
                raw: null,
                used_message_ids: [],
                used_at: null,
                created_at: new Date(0),
                updated_at: new Date(0),
                current_score: 50,
                age_days: 1,
              },
            ]
          : [],
      );
      await tick(w);
      expect({ config: entry.config, branch: (await runs(w))[0]?.detail.branch }).toEqual({
        config: entry.config,
        branch: entry.expect,
      });
    }
  });

  it("sees replies received after enrollment", async () => {
    const w = await world({
      steps: [
        { type: "condition", config: { if: "replied", then_step: 2 } },
        { type: "task", config: { title: "No reply" } },
      ],
    });
    await seedMessage(w.ctx, {
      person_id: w.person.id,
      direction: "inbound",
      status: "received",
      action: "reply",
    });
    await tick(w);
    expect((await runs(w))[0]?.detail.branch).toBe("then");
    expect(await reload(w)).toMatchObject({ status: "completed" });
  });

  it("posts signed webhooks and retries failures before skipping", async () => {
    const w = await world({ steps: [{ type: "webhook" }] });
    const secretId = await w.ctx.vault.putSecret(w.ctx.workspace.id, "hook", "s3cret-value");
    await w.ctx.db
      .update(campaign_steps)
      .set({
        config: { type: "webhook", url: "https://hooks.example.com/step", secret_id: secretId },
      })
      .where(eq(campaign_steps.id, w.steps[0]?.id ?? ""));
    w.ctx.fetch.route("https://hooks.example.com/step", { status: 200, body: "ok" }, "POST");
    await tick(w);
    expect(await reload(w)).toMatchObject({ status: "completed" });
    const call = w.ctx.recorded.fetch[0];
    const headers = (call?.init?.headers ?? {}) as Record<string, string>;
    const body = String(call?.init?.body ?? "");
    expect(JSON.parse(body)).toMatchObject({
      type: "campaign.step",
      enrollment_id: w.enrollment.id,
      person: { id: w.person.id, email: w.person.email },
    });
    expect(headers["openoutbound-signature"]).toBe(
      signWebhook("s3cret-value", body, w.ctx.clock.now()),
    );

    const failing = await world({ steps: [{ type: "webhook" }] });
    failing.ctx.fetch.route("https://hooks.example.com/step", { status: 500 }, "POST");
    await tick(failing);
    expect(await reload(failing)).toMatchObject({ status: "active", current_step: 0 });
    expect((await runs(failing))[0]?.detail).toMatchObject({
      webhook_attempts: 1,
      webhook_status: 500,
    });
    failing.ctx.clock.advanceBy({ minutes: 5 });
    await tick(failing);
    failing.ctx.clock.advanceBy({ minutes: 10 });
    await tick(failing);
    expect(await reload(failing)).toMatchObject({ status: "completed" });
    expect((await runs(failing))[0]).toMatchObject({
      status: "skipped",
      detail: { reason: "webhook_failed", webhook_attempts: 3 },
    });
  });
});

describe("LinkedIn steps", () => {
  it("queues a profile visit with the campaign's account", async () => {
    const w = await world({ steps: [{ type: "linkedin_visit" }] });
    await tick(w);
    const message = await onlyMessage(w);
    expect(message).toMatchObject({
      channel: "linkedin",
      action: "visit",
      status: "scheduled",
      linkedin_account_id: w.accountId,
    });
    expect(vi.mocked(planLinkedInAction).mock.calls[0]?.[1]).toMatchObject({ action: "visit" });
    expect(await reload(w)).toMatchObject({ linkedin_account_id: w.accountId });
    await markSent(w, message);
    expect(await reload(w)).toMatchObject({ status: "completed" });
  });

  it("skips invites to people already connected", async () => {
    const w = await world({
      steps: [{ type: "linkedin_invite" }, { type: "task", config: { title: "Next" } }],
    });
    vi.mocked(getRelation).mockResolvedValue("connected");
    await tick(w);
    expect(await stepMessages(w)).toHaveLength(0);
    expect((await runs(w))[0]).toMatchObject({
      status: "skipped",
      detail: { reason: "already_connected" },
    });
    expect(await reload(w)).toMatchObject({ current_step: 1 });
  });

  it("waits for the connection before messaging and wakes on linkedin.connected", async () => {
    const w = await world({
      steps: [
        {
          type: "linkedin_message",
          config: { style: "exact", text: "Thanks for connecting, {{first_name}}." },
        },
      ],
    });
    await tick(w);
    expect((await runs(w))[0]).toMatchObject({
      status: "waiting",
      detail: { reason: "waiting_for_connection", waiting_since: w.ctx.clock.now().toISOString() },
    });
    expect((await reload(w)).next_run_at).toEqual(at(w, 12 * HOUR));

    vi.mocked(getRelation).mockResolvedValue("connected");
    await fire(w, wakeOnConnected, {
      account_id: w.accountId,
      person_id: w.person.id,
      connected_at: w.ctx.clock.now().toISOString(),
    });
    expect((await reload(w)).next_run_at).toEqual(w.ctx.clock.now());
    await tick(w);
    expect(await onlyMessage(w)).toMatchObject({
      action: "message",
      status: "scheduled",
      body_text: "Thanks for connecting, Dana.",
    });
  });

  it("gives up waiting for the connection after 14 days (missing data)", async () => {
    const w = await world({
      steps: [
        { type: "linkedin_message", config: { style: "exact", text: "Thanks for connecting." } },
        { type: "task", config: { title: "Email instead" } },
      ],
    });
    await tick(w);
    w.ctx.clock.advance(CONNECTION_WAIT_MS);
    await tick(w);
    expect((await runs(w))[0]).toMatchObject({
      status: "skipped",
      detail: { reason: "not_connected" },
    });
    expect(await reload(w)).toMatchObject({ status: "active", current_step: 1 });
  });

  it("likes a recent post and skips when there is none", async () => {
    const skip = await world({ steps: [{ type: "linkedin_like" }] });
    await tick(skip);
    expect((await runs(skip))[0]).toMatchObject({
      status: "skipped",
      detail: { reason: "no_recent_post" },
    });

    const w = await world({ steps: [{ type: "linkedin_like" }] });
    vi.mocked(getRecentPostForPerson).mockResolvedValue({
      id: "urn:li:activity:1",
      url: "https://www.linkedin.com/feed/update/1",
      text: "We opened Round Rock",
    });
    await tick(w);
    expect(await onlyMessage(w)).toMatchObject({
      action: "like",
      status: "scheduled",
      in_reply_to: "urn:li:activity:1",
      headers: { "x-linkedin-post-id": "urn:li:activity:1" },
    });
  });

  it("always reviews comments by default, even at level unsure", async () => {
    const w = await world({ steps: [{ type: "linkedin_comment" }] });
    vi.mocked(getRecentPostForPerson).mockResolvedValue({
      id: "urn:li:activity:2",
      text: "We opened Round Rock",
    });
    await tick(w);
    await generate(w);
    const draft = await onlyMessage(w);
    expect(draft).toMatchObject({ status: "draft", body_text: COMMENT });
    await tick(w);
    expect(await onlyMessage(w)).toMatchObject({ status: "pending_review" });
    expect(w.ctx.recorded.approvals[0]?.request.title).toContain("LinkedIn comment");
  });

  it("waits when the campaign has no LinkedIn account", async () => {
    const w = await world({
      steps: [{ type: "linkedin_visit" }],
      settings: { senders: { mailbox_ids: [], linkedin_account_ids: [] } },
    });
    await tick(w);
    expect((await runs(w))[0]).toMatchObject({
      status: "waiting",
      detail: { reason: "no_linkedin_account" },
    });
    expect((await reload(w)).next_run_at).toEqual(at(w, 6 * HOUR));
  });
});

describe("missing data and contactability", () => {
  const exactEmail: SeedStep = {
    type: "email",
    config: { style: "exact", subject: "hello", body: "Hi {{first_name}}, worth a look?" },
  };

  it("skip_step skips the step and continues", async () => {
    const w = await world({
      person: { email: null },
      steps: [exactEmail, { type: "task", config: { title: "Call instead" } }],
      settings: { missing_data: "skip_step" },
    });
    await tick(w);
    expect((await runs(w))[0]).toMatchObject({
      status: "skipped",
      detail: { reason: "missing_data:email" },
    });
    expect(await reload(w)).toMatchObject({ status: "active", current_step: 1 });
  });

  it("skip_lead stops the enrollment", async () => {
    const w = await world({
      person: { email: null },
      steps: [exactEmail, { type: "task", config: { title: "Call instead" } }],
      settings: { missing_data: "skip_lead" },
    });
    await tick(w);
    expect(await reload(w)).toMatchObject({ status: "stopped", stop_reason: "missing_data" });
    expect(w.ctx.emitted("enrollment.stopped")[0]?.data.reason).toBe("missing_data");
  });

  it("stops people who became uncontactable and skips channel-only blocks", async () => {
    const blocked = await world({ steps: [exactEmail] });
    vi.mocked(checkContactable).mockResolvedValue({ ok: false, reasons: ["excluded_country"] });
    await tick(blocked);
    expect(await reload(blocked)).toMatchObject({
      status: "stopped",
      stop_reason: "not_contactable",
    });

    const unverified = await world({
      steps: [exactEmail, { type: "task", config: { title: "Call instead" } }],
    });
    vi.mocked(checkContactable).mockResolvedValue({ ok: false, reasons: ["email_unverified"] });
    await tick(unverified);
    expect(await reload(unverified)).toMatchObject({ status: "active", current_step: 1 });
    expect((await runs(unverified))[0]?.detail).toMatchObject({
      reason: "not_contactable",
      codes: ["email_unverified"],
    });
  });

  it("waits for a company hold to end instead of stopping, then sends", async () => {
    const w = await world({ steps: [exactEmail] });
    const until = at(w, 2 * DAY + 6 * HOUR);
    await w.ctx.db
      .update(companies)
      .set({ hold_until: until, hold_reason: "Board freeze on new vendors" })
      .where(eq(companies.id, w.person.company_id as string));
    vi.mocked(checkContactable).mockResolvedValue({ ok: false, reasons: ["company_on_hold"] });

    await tick(w);
    expect(await reload(w)).toMatchObject({ status: "active", current_step: 0 });
    // Checked again daily, so an early release is picked up.
    expect((await reload(w)).next_run_at).toEqual(at(w, DAY));
    expect((await runs(w))[0]).toMatchObject({
      status: "waiting",
      detail: { reason: "company_on_hold" },
    });
    expect(await stepMessages(w)).toHaveLength(0);
    expect(w.ctx.emitted("enrollment.stopped")).toHaveLength(0);

    // Less than a day before the end, the next check lands on the end of the hold.
    w.ctx.clock.advanceBy({ days: 2 });
    await tick(w);
    expect(await reload(w)).toMatchObject({ status: "active", current_step: 0 });
    expect((await reload(w)).next_run_at).toEqual(until);

    // Once the hold is over the step runs as usual.
    w.ctx.clock.set(until);
    vi.mocked(checkContactable).mockResolvedValue({ ok: true, reasons: [] });
    await tick(w);
    expect((await onlyMessage(w)).status).toBe("scheduled");
  });

  it("still stops for other company blocks next to a hold", async () => {
    expect(isGlobalBlock(["company_on_hold"])).toBe(false);
    expect(isGlobalBlock(["company_on_hold", "company_customer"])).toBe(true);
    const w = await world({ steps: [exactEmail] });
    vi.mocked(checkContactable).mockResolvedValue({
      ok: false,
      reasons: ["company_on_hold", "company_customer"],
    });
    await tick(w);
    expect(await reload(w)).toMatchObject({ status: "stopped", stop_reason: "not_contactable" });
  });

  it("applies the policy when a template variable is missing at generation", async () => {
    const w = await world({
      steps: [
        {
          type: "email",
          config: {
            style: "guided",
            subject: "hello",
            body: "Hi {{first_name}}, about {{custom.segment}}: [[ai: one line]] Worth a look?",
          },
        },
        { type: "task", config: { title: "Next" } },
      ],
    });
    await tick(w);
    await generate(w);
    expect(await onlyMessage(w)).toMatchObject({
      status: "skipped",
      error: "missing_data:missing_variable:custom.segment",
    });
    await tick(w);
    expect(await reload(w)).toMatchObject({ status: "active", current_step: 1 });
  });
});

describe("activation, timezones and skips", () => {
  it("activates queued leads up to daily_new_leads per day in the campaign timezone", async () => {
    const ctx = await createTestContext({ db, now: "2026-09-19T12:00:00Z" });
    contexts.push(ctx);
    const { campaign } = await seedCampaign(ctx, {
      status: "active",
      settings: {
        daily_new_leads: 2,
        schedule: { timezone: "America/Chicago", timezone_mode: "fixed" },
      },
      steps: [{ type: "task", delay_days: 1, config: { title: "Call" } }],
    });
    for (let i = 0; i < 5; i += 1) {
      const person = await seedPerson(ctx);
      await seedEnrollment(ctx, {
        campaign_id: campaign.id,
        person_id: person.id,
        status: "queued",
        enrolled_at: new Date(Date.parse("2026-09-18T00:00:00Z") + i * MINUTE),
      });
    }
    const activeCount = async () =>
      (
        await ctx.db
          .select()
          .from(enrollments)
          .where(and(eq(enrollments.campaign_id, campaign.id), eq(enrollments.status, "active")))
      ).length;

    expect(await runTick(ctx.jobContext())).toMatchObject({ activated: 2 });
    expect(await runTick(ctx.jobContext())).toMatchObject({ activated: 0 });
    ctx.clock.set("2026-09-20T04:30:00Z"); // 23:30 in Chicago, still the 19th
    expect(await runTick(ctx.jobContext())).toMatchObject({ activated: 0 });
    ctx.clock.set("2026-09-20T05:30:00Z"); // 00:30 in Chicago on the 20th
    expect(await runTick(ctx.jobContext())).toMatchObject({ activated: 2 });
    expect(await activeCount()).toBe(4);
    const [first] = await ctx.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.campaign_id, campaign.id))
      .orderBy(asc(enrollments.enrolled_at))
      .limit(1);
    expect(first?.next_run_at).toEqual(new Date(Date.parse("2026-09-20T12:00:00Z")));
  });

  it("plans sends in the lead's timezone, falling back to country and campaign zones", async () => {
    const exact: SeedStep = {
      type: "email",
      config: { style: "exact", subject: "hello", body: "Hi, worth a look?" },
    };
    const byCountry = await world({ steps: [exact], person: { timezone: null, country: "DE" } });
    await tick(byCountry);
    const fixed = await world({
      steps: [exact],
      settings: { schedule: { timezone_mode: "fixed", timezone: "Europe/London" } },
    });
    await tick(fixed);
    expect(vi.mocked(planEmailSend).mock.calls.map((call) => call[1].recipientTimezone)).toEqual([
      "Europe/Berlin",
      "Europe/London",
    ]);
  });

  it("skips paused workspaces and paused campaigns, and waits for start_at", async () => {
    const pausedWorkspace = await world({ steps: [{ type: "task", config: { title: "x" } }] });
    await pausedWorkspace.ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, pausedWorkspace.ctx.workspace.id));
    expect(await tick(pausedWorkspace)).toMatchObject({ skipped: "workspace_paused" });

    const pausedCampaign = await world({
      steps: [{ type: "task", config: { title: "x" } }],
      campaignStatus: "paused",
    });
    expect(await tick(pausedCampaign)).toMatchObject({ processed: 0 });
    expect(await reload(pausedCampaign)).toMatchObject({ current_step: 0 });

    const later = await world({
      steps: [{ type: "task", config: { title: "x" } }],
      settings: { schedule: { start_at: "2026-10-01T09:00:00Z" } },
    });
    await tick(later);
    expect((await reload(later)).next_run_at).toEqual(new Date("2026-10-01T09:00:00Z"));
  });

  it("adds finished people to the end-action list", async () => {
    const ctx = await createTestContext({ db });
    contexts.push(ctx);
    const [list] = await ctx.db
      .insert(lists)
      .values({ workspace_id: ctx.workspace.id, name: "Finished sequence" })
      .returning();
    const w = await world({
      steps: [{ type: "task", config: { title: "x" } }],
      settings: { end_action: { type: "list", value: list?.id ?? "" } },
    });
    await w.ctx.db
      .update(lists)
      .set({ workspace_id: w.ctx.workspace.id })
      .where(eq(lists.id, list?.id ?? ""));
    await tick(w);
    const members = await w.ctx.db
      .select()
      .from(list_members)
      .where(eq(list_members.list_id, list?.id ?? ""));
    expect(members.map((row) => row.person_id)).toEqual([w.person.id]);
  });

  it("runs the end action exactly once for enrollments left past the last step", async () => {
    // A step edit removed the steps the enrollment had left: it now points past the end.
    const w = await world({
      steps: [{ type: "task", config: { title: "x" } }],
      settings: { end_action: { type: "tag", value: "sequence_done" } },
      enrollment: { current_step: 1 },
    });
    expect(await tick(w)).toMatchObject({ processed: 1, errors: 0 });
    expect(await reload(w)).toMatchObject({ status: "completed", next_run_at: null });
    const tags = async () =>
      (await w.ctx.db.select().from(people).where(eq(people.id, w.person.id)))[0]?.tags ?? [];
    expect(await tags()).toContain("sequence_done");
    expect(w.ctx.emitted("lead.updated")).toHaveLength(1);

    // A late or racing pass over the same (stale) row must not run the end action again.
    await w.ctx.db
      .update(people)
      .set({ tags: (await tags()).filter((tag) => tag !== "sequence_done") })
      .where(eq(people.id, w.person.id));
    const loaded = await loadCampaign(w.ctx, w.campaignId);
    await processEnrollment(w.ctx, loaded, w.enrollment, await loadPeople(w.ctx, [w.person.id]));
    expect(await tags()).not.toContain("sequence_done");
    expect(w.ctx.emitted("lead.updated")).toHaveLength(1);
  });

  it("adds people left past the last step to the end-action list", async () => {
    const w = await world({ steps: [{ type: "wait" }], enrollment: { current_step: 3 } });
    const [list] = await w.ctx.db
      .insert(lists)
      .values({ workspace_id: w.ctx.workspace.id, name: "Retry later" })
      .returning();
    await w.ctx.db
      .update(campaigns)
      .set({ settings: { end_action: { type: "list", value: list?.id ?? "" } } })
      .where(eq(campaigns.id, w.campaignId));
    await tick(w);
    expect(await reload(w)).toMatchObject({ status: "completed" });
    const members = await w.ctx.db
      .select()
      .from(list_members)
      .where(eq(list_members.list_id, list?.id ?? ""));
    expect(members.map((row) => row.person_id)).toEqual([w.person.id]);
  });

  it("runs from the tick job with only a workspace id in the payload", async () => {
    const w = await world({ steps: [{ type: "task", config: { title: "x" } }] });
    const job = { ...w.ctx.jobContext({ name: "campaigns.tick" }), workspace: null };
    expect(await tickJob.handler(job, { workspace_id: w.ctx.workspace.id })).toMatchObject({
      processed: 1,
    });
  });
});
