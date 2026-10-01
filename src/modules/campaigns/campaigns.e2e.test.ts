/**
 * End to end through the real engine (createTestEngine): operations, the per-workspace tick
 * schedule, the generation job, approvals.decide with the message resolver, and the event
 * handlers running as jobs. Knowledge and research run for real; modules that are not merged
 * yet (leads, email, linkedin, signals) are mocked, and sends are simulated by marking the
 * message sent and emitting `message.sent` like the channel modules will.
 */
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  campaigns,
  enrollment_step_runs,
  enrollments,
  type Message,
  messages,
  type Person,
  people,
  tasks,
} from "../../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import {
  seedCompany,
  seedLinkedInAccount,
  seedMailbox,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { createFakeBrain } from "../../testing/fake-brain.js";
import { planEmailSend, queueEmailSend } from "../email/service.js";
import { checkContactable } from "../leads/service.js";
import {
  getRecentPostForPerson,
  getRelation,
  planLinkedInAction,
  queueLinkedInAction,
} from "../linkedin/service.js";
import { getActiveSignals, markSignalsUsed } from "../signals/service.js";

vi.mock("../leads/service.js", async (importOriginal) => {
  const { loadPerson } = await import("./people.js");
  return {
    ...(await importOriginal<object>()),
    checkContactable: vi.fn(),
    resolvePeople: vi.fn(),
    // The research module reads people through leads; campaigns has the same lookup.
    getPersonWithCompany: vi.fn(loadPerson),
  };
});
vi.mock("../email/service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  planEmailSend: vi.fn(),
  queueEmailSend: vi.fn(),
}));
vi.mock("../linkedin/service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  planLinkedInAction: vi.fn(),
  queueLinkedInAction: vi.fn(),
  getRelation: vi.fn(),
  getRecentPostForPerson: vi.fn(),
}));
vi.mock("../signals/service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getActiveSignals: vi.fn(),
  markSignalsUsed: vi.fn(),
}));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const FIRST =
  "Hi Dana, I saw that Harbor opened a second clinic in Round Rock this month. New locations usually mean the front desk juggles twice the calls while the team settles in. We answer overflow calls for dental groups so patients never hit voicemail during lunch. Would that be useful while Round Rock ramps up?";
const FOLLOW_UP =
  "Following up on my note about the front desk. Is covering the lunch rush on your list this quarter?";

const brain = createFakeBrain({
  handlers: {
    "campaign.email.write": (vars: { first_touch: boolean }) => ({
      subject: "round rock front desk",
      body: vars.first_touch ? FIRST : FOLLOW_UP,
      angle: "Coverage while the new clinic ramps up",
      signals_used: [],
      facts_used: [],
    }),
    "campaign.email.check": { verdict: "pass", confidence: 0.93, issues: [] },
  },
});

let engine: TestEngine;
beforeAll(async () => {
  engine = await createTestEngine({ brain });
});
afterAll(async () => {
  await engine.close();
});
beforeEach(() => {
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
  vi.mocked(getRelation).mockResolvedValue("connected");
  vi.mocked(getRecentPostForPerson).mockResolvedValue(null);
  vi.mocked(getActiveSignals).mockResolvedValue([]);
  vi.mocked(markSignalsUsed).mockResolvedValue(undefined);
});

interface Setup {
  slug: string;
  workspaceId: string;
  person: Person;
  mailboxId: string;
}

let counter = 0;
async function setup(): Promise<Setup> {
  counter += 1;
  const workspace = (await engine.call("workspaces.create", {
    name: `Harbor Outreach ${counter}`,
    settings: {
      company: { name: "Brightline Answering", postal_address: "1 Example Way, Austin, TX" },
    },
  })) as { id: string; slug: string };
  const target = { db: engine.db, workspace: { id: workspace.id } };
  const company = await seedCompany(target, { name: "Harbor Dental" });
  const person = await seedPerson(target, {
    first_name: "Dana",
    last_name: "Reyes",
    full_name: "Dana Reyes",
    company_id: company.id,
  });
  const mailbox = await seedMailbox(target);
  return { slug: workspace.slug, workspaceId: workspace.id, person, mailboxId: mailbox.id };
}

async function createCampaign(s: Setup, reviewLevel: "every" | "first" | "unsure") {
  return (await engine.call(
    "campaigns.create",
    {
      name: "Dental groups",
      steps: [
        { type: "email", config: { style: "free", instruction: "Lead with their news." } },
        { type: "email", delay_days: 3, config: { mode: "reply", style: "free", max_words: 70 } },
      ],
      settings: {
        review_level: reviewLevel,
        senders: { mailbox_ids: [s.mailboxId] },
        writing: { instructions: "Offer overflow call answering for dental groups." },
      },
    },
    { workspace: s.slug },
  )) as { id: string; status: string; steps: Array<{ id: string }> };
}

/** One sequencer minute: move the clock, fire due schedules and run every due job. */
async function minute(): Promise<void> {
  engine.advance(MINUTE);
  await engine.runJobs({ max: 500 });
}

async function enrollment(campaignId: string) {
  const [row] = await engine.db
    .select()
    .from(enrollments)
    .where(eq(enrollments.campaign_id, campaignId));
  return row;
}

async function campaignMessages(campaignId: string): Promise<Message[]> {
  return engine.db
    .select()
    .from(messages)
    .where(and(eq(messages.campaign_id, campaignId), eq(messages.direction, "outbound")))
    .orderBy(asc(messages.created_at));
}

/** What the channel modules do after sending: mark it sent and emit message.sent. */
async function send(s: Setup, message: Message, threadId: string | null): Promise<void> {
  const ctx = await engine.systemContext(s.workspaceId);
  const sentAt = engine.clock.now();
  await engine.db
    .update(messages)
    .set({
      status: "sent",
      sent_at: sentAt,
      thread_id: threadId,
      message_id_header: `<${message.id}@example.org>`,
    })
    .where(eq(messages.id, message.id));
  await ctx.events.emit("message.sent", {
    subject: { type: "message", id: message.id },
    data: {
      message_id: message.id,
      thread_id: threadId,
      person_id: message.person_id,
      campaign_id: message.campaign_id,
      channel: message.channel,
      action: message.action,
      sent_at: sentAt.toISOString(),
    },
  });
  await engine.runJobs({ max: 500, schedules: false });
}

describe("campaigns end to end", () => {
  it("registers operations, tools, jobs and the tick schedule", () => {
    const tools = engine.registry.tools().map((tool) => tool.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        "get_campaigns",
        "create_campaign",
        "preview_campaign",
        "launch_campaign",
        "enroll_leads",
        "manage_messages",
      ]),
    );
    expect(engine.registry.operation("campaigns.launch")).toBeDefined();
    expect(engine.runtime.kernel.registry.schedule("campaigns.tick")).toMatchObject({
      cron: "* * * * *",
      perWorkspace: true,
    });
  });

  it("runs a two-step email sequence from launch to completion", async () => {
    const s = await setup();
    const campaign = await createCampaign(s, "first");
    expect(campaign.status).toBe("draft");

    const preview = await engine.call(
      "campaigns.enroll",
      { campaign_id: campaign.id, person_ids: [s.person.id], dry_run: true },
      { workspace: s.slug },
    );
    expect(preview).toMatchObject({ dry_run: true, preview: { enrolled: 1, skipped: 0 } });
    expect(
      await engine.call(
        "campaigns.enroll",
        { campaign_id: campaign.id, person_ids: [s.person.id] },
        { workspace: s.slug },
      ),
    ).toMatchObject({ enrolled: 1 });

    const checklist = (await engine.call(
      "campaigns.launch",
      { campaign_id: campaign.id, dry_run: true },
      { workspace: s.slug },
    )) as { preview: { ready: boolean } };
    expect(checklist.preview.ready).toBe(true);
    expect(
      await engine.call("campaigns.launch", { campaign_id: campaign.id }, { workspace: s.slug }),
    ).toMatchObject({ status: "active" });

    // Tick: activate, create the message, queue generation; the generation job writes it.
    await minute();
    let [first] = await campaignMessages(campaign.id);
    expect(first).toMatchObject({ status: "draft", body_text: FIRST });
    expect((await enrollment(campaign.id))?.status).toBe("active");

    // Next tick: review level "first" asks a human.
    await minute();
    const pending = (await engine.call(
      "approvals.list",
      { kind: "message" },
      { workspace: s.slug },
    )) as { items: Array<{ id: string; target_id: string }> };
    expect(pending.items.map((item) => item.target_id)).toEqual([first?.id]);

    const decided = await engine.call(
      "approvals.decide",
      {
        approval_id: pending.items[0]?.id,
        decision: "edit",
        edits: { subject: "front desk coverage" },
      },
      { workspace: s.slug },
    );
    expect(decided).toMatchObject({ approved: 1 });
    [first] = await campaignMessages(campaign.id);
    expect(first).toMatchObject({
      status: "scheduled",
      subject: "front desk coverage",
      mailbox_id: s.mailboxId,
    });
    expect(first?.why).toMatchObject({
      signal_ids: [],
      signal_keys: [],
      facts: [],
      angle: "Coverage while the new clinic ramps up",
      original: { subject: "round rock front desk" },
    });

    const thread = await seedThread(
      { db: engine.db, workspace: { id: s.workspaceId } },
      { person_id: s.person.id },
    );
    if (!first) throw new Error("first message missing");
    await send(s, first, thread.id);
    const moved = await enrollment(campaign.id);
    expect(moved).toMatchObject({ status: "active", current_step: 1 });
    expect(moved?.next_run_at).toEqual(new Date(engine.clock.now().getTime() + 3 * DAY));

    // Three days later the follow-up is written and, at level "first", scheduled directly.
    engine.advance(3 * DAY);
    await minute();
    await minute();
    const [, second] = await campaignMessages(campaign.id);
    expect(second).toMatchObject({
      status: "scheduled",
      subject: "Re: front desk coverage",
      body_text: FOLLOW_UP,
      thread_id: thread.id,
      in_reply_to: `<${first.id}@example.org>`,
    });
    if (!second) throw new Error("second message missing");
    await send(s, second, thread.id);
    expect(await enrollment(campaign.id)).toMatchObject({ status: "completed" });

    await minute();
    const detail = (await engine.call(
      "campaigns.get",
      { campaign_id: campaign.id },
      { workspace: s.slug },
    )) as {
      stats: { sent: number; enrolled: number; completed: number };
      step_stats: Array<{ position: number; sent: number }>;
    };
    expect(detail.stats).toMatchObject({ sent: 2, enrolled: 1, completed: 1 });
    expect(detail.step_stats.map((row) => [row.position, row.sent])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    const [stored] = await engine.db
      .select({ stats: campaigns.stats })
      .from(campaigns)
      .where(eq(campaigns.id, campaign.id));
    expect(stored?.stats).toMatchObject({ sent: 2 });
  });

  it("pauses on a reply at once and stops after 24 hours without classification", async () => {
    const s = await setup();
    const campaign = await createCampaign(s, "unsure");
    await engine.call(
      "campaigns.enroll",
      { campaign_id: campaign.id, person_ids: [s.person.id] },
      { workspace: s.slug },
    );
    await engine.call("campaigns.launch", { campaign_id: campaign.id }, { workspace: s.slug });
    await minute();
    await minute();
    const [first] = await campaignMessages(campaign.id);
    expect(first?.status).toBe("scheduled");

    const ctx = await engine.systemContext(s.workspaceId);
    const thread = await seedThread(
      { db: engine.db, workspace: { id: s.workspaceId } },
      { person_id: s.person.id },
    );
    await ctx.events.emit("reply.received", {
      data: {
        message_id: "msg_01k6a3v0q8x3m2n4p5r6s7t8v9",
        thread_id: thread.id,
        person_id: s.person.id,
        campaign_id: campaign.id,
        channel: "email",
      },
    });
    await engine.runJobs({ schedules: false });
    expect(await enrollment(campaign.id)).toMatchObject({
      status: "paused",
      stop_reason: "reply_pending_classification",
    });
    expect((await campaignMessages(campaign.id))[0]).toMatchObject({
      status: "approved",
      scheduled_for: null,
    });

    engine.advance(DAY);
    await minute();
    expect(await enrollment(campaign.id)).toMatchObject({
      status: "stopped",
      stop_reason: "replied",
    });
    expect((await campaignMessages(campaign.id))[0]?.status).toBe("cancelled");
  });

  it("runs LinkedIn, task, wait, condition and webhook steps through the tick", async () => {
    const s = await setup();
    const target = { db: engine.db, workspace: { id: s.workspaceId } };
    const account = await seedLinkedInAccount(target);
    await engine.db
      .update(people)
      .set({ linkedin_url: "https://www.linkedin.com/in/dana-reyes-example" })
      .where(eq(people.id, s.person.id));
    engine.fetch.route("https://hooks.example.com/step", { status: 204 }, "POST");
    const campaign = (await engine.call(
      "campaigns.create",
      {
        name: "Multichannel",
        steps: [
          { type: "linkedin_visit" },
          { type: "linkedin_invite", config: { note: "none" } },
          { type: "task", config: { title: "Call {{first_name}}", task_type: "call" } },
          { type: "wait", delay_days: 1 },
          { type: "condition", config: { if: "has_email", then_step: 5, else_step: 6 } },
          { type: "webhook", config: { url: "https://hooks.example.com/step" } },
        ],
        settings: { senders: { linkedin_account_ids: [account.id] } },
      },
      { workspace: s.slug },
    )) as { id: string };
    await engine.call(
      "campaigns.enroll",
      { campaign_id: campaign.id, person_ids: [s.person.id] },
      { workspace: s.slug },
    );
    await engine.call("campaigns.launch", { campaign_id: campaign.id }, { workspace: s.slug });

    await minute();
    const [visit] = await campaignMessages(campaign.id);
    expect(visit).toMatchObject({ action: "visit", status: "scheduled" });
    if (!visit) throw new Error("visit missing");
    await send(s, visit, null);
    await minute(); // invite: already connected, skipped
    await minute(); // task
    const [task] = await engine.db.select().from(tasks).where(eq(tasks.person_id, s.person.id));
    expect(task).toMatchObject({ title: "Call Dana", type: "call" });
    expect(await enrollment(campaign.id)).toMatchObject({ current_step: 3 });

    engine.advance(DAY);
    await minute(); // wait
    await minute(); // condition
    await minute(); // webhook
    expect(await enrollment(campaign.id)).toMatchObject({ status: "completed" });
    const hook = engine.fetch.calls.find((call) => call.url === "https://hooks.example.com/step");
    expect(JSON.parse(String(hook?.init?.body))).toMatchObject({
      type: "campaign.step",
      person: { id: s.person.id },
    });
    const runs = await engine.db
      .select({ position: enrollment_step_runs.position, status: enrollment_step_runs.status })
      .from(enrollment_step_runs)
      .where(eq(enrollment_step_runs.campaign_id, campaign.id))
      .orderBy(asc(enrollment_step_runs.position));
    expect(runs.map((run) => run.status)).toEqual([
      "done",
      "skipped",
      "done",
      "done",
      "done",
      "done",
    ]);
  });

  it("asks a human before an agent launches, then launches on approval", async () => {
    const s = await setup();
    const campaign = await createCampaign(s, "every");
    await engine.call(
      "campaigns.enroll",
      { campaign_id: campaign.id, person_ids: [s.person.id] },
      { workspace: s.slug },
    );
    const agent = engine.principal({ type: "agent", id: "agent-1", name: "Helper agent" });
    const result = (await engine.call(
      "campaigns.launch",
      { campaign_id: campaign.id },
      { workspace: s.slug, principal: agent },
    )) as { status: string; approval_id: string };
    expect(result.status).toBe("awaiting_approval");
    const [row] = await engine.db
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(eq(campaigns.id, campaign.id));
    expect(row?.status).toBe("draft");

    expect(
      await engine.call(
        "approvals.decide",
        { approval_id: result.approval_id, decision: "approve" },
        { workspace: s.slug },
      ),
    ).toMatchObject({ approved: 1 });
    const [launched] = await engine.db
      .select({ status: campaigns.status, launched_at: campaigns.launched_at })
      .from(campaigns)
      .where(eq(campaigns.id, campaign.id));
    expect(launched).toMatchObject({ status: "active", launched_at: engine.clock.now() });
  });
});
