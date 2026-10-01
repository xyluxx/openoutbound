/**
 * Every report type on one seeded workspace. Clock: Saturday 2026-09-19 12:00 UTC, workspace in
 * UTC, period last_7_days = [09-12, 09-19), previous = [09-05, 09-12). Expected numbers are
 * worked out by hand in the comments next to the seed.
 */
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NewMessage } from "../../db/schema/index.js";
import {
  events,
  icps,
  linkedin_relations,
  opportunities,
  signal_definitions,
  signals,
  usage_records,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import {
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedLinkedInAccount,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
  seedWorkspace,
} from "../../testing/factories.js";
import { getReport } from "./operations/get-report.js";
import type { ReportOutput } from "./schemas.js";

const NOW = "2026-09-19T12:00:00.000Z";
const t = (iso: string) => new Date(iso);

let ctx: TestContext;
const ids: Record<string, string> = {};

async function run(input: Record<string, unknown>, context: TestContext = ctx) {
  const raw = await getReport.handler(context, getReport.input.parse(input));
  return getReport.output.parse(raw) as ReportOutput;
}

function data<T extends NonNullable<ReportOutput["data"]>["type"]>(
  output: ReportOutput,
  type: T,
): Extract<NonNullable<ReportOutput["data"]>, { type: T }> {
  if (output.data?.type !== type) throw new Error(`expected ${type} data`);
  return output.data as Extract<NonNullable<ReportOutput["data"]>, { type: T }>;
}

beforeAll(async () => {
  ctx = await createTestContext({
    now: NOW,
    settings: { ai: { monthly_budget_usd: 4 }, data: { monthly_credit_budget: 100 } },
  });
  const db = ctx.db;
  const ws = ctx.workspace.id;

  const coA = await seedCompany(ctx, { name: "Lumen Home" });
  const coB = await seedCompany(ctx, { name: "Cedar Supply" });
  const coC = await seedCompany(ctx, { name: "Bluefield Goods" });

  // People: tier from fit score (A 80+, B 70-79, C 50-69, D <50, unscored).
  const p1 = await seedPerson(ctx, {
    company_id: coA.id,
    fit_score: 85,
    created_at: t("2026-09-13T08:00:00Z"),
    status: "interested",
    fit_reasons: [
      { rule: "industry", points: 20, matched: true },
      { rule: "employee_range", points: 0, matched: false },
    ],
  });
  const p2 = await seedPerson(ctx, {
    company_id: coB.id,
    fit_score: 75,
    created_at: t("2026-09-14T08:00:00Z"),
    fit_reasons: [{ rule: "title", points: 15, matched: true }],
  });
  const p3 = await seedPerson(ctx, { fit_score: 60, created_at: t("2026-09-06T08:00:00Z") });
  const p4 = await seedPerson(ctx, { fit_score: 40, created_at: t("2026-09-07T08:00:00Z") });
  const p5 = await seedPerson(ctx, { fit_score: null, created_at: t("2026-09-01T08:00:00Z") });
  const p6 = await seedPerson(ctx, {
    fit_score: 90,
    created_at: t("2026-09-15T08:00:00Z"),
    fit_reasons: [
      { rule: "industry", points: 20, matched: true },
      { rule: "title", points: 15, matched: true },
    ],
  });
  await seedPerson(ctx, {
    company_id: coC.id,
    fit_score: 82,
    status: "new",
    created_at: t("2026-09-16T08:00:00Z"),
  });

  const m1 = await seedMailbox(ctx, { email: "sam@northwind.example.org", daily_limit: 30 });
  const m2 = await seedMailbox(ctx, {
    email: "alex@northwind.example.org",
    status: "paused",
    status_reason: "bounce rate 4%",
  });
  const a1 = await seedLinkedInAccount(ctx, { name: "Sam LinkedIn", timezone: "America/Chicago" });
  await seedLinkedInAccount(ctx, { name: "Alex LinkedIn", status: "restricted" });

  const [icp1] = await db.insert(icps).values({ workspace_id: ws, name: "DTC brands" }).returning();
  const c1 = await seedCampaign(ctx, {
    name: "Signal play",
    status: "active",
    icp_id: icp1?.id,
    steps: [
      { type: "email" },
      { type: "wait", delay_days: 2 },
      { type: "email", config: { mode: "reply" } },
    ],
  });
  const c2 = await seedCampaign(ctx, {
    name: "LinkedIn warm",
    status: "active",
    steps: [{ type: "linkedin_invite" }, { type: "linkedin_message" }],
  });
  await seedCampaign(ctx, { name: "Draft idea", status: "draft" });
  const [s1, , s3] = c1.steps;
  const [l1, l2] = c2.steps;
  if (!s1 || !s3 || !l1 || !l2) throw new Error("steps missing");
  Object.assign(ids, { c1: c1.campaign.id, c2: c2.campaign.id, m1: m1.id, m2: m2.id, a1: a1.id });

  await seedEnrollment(ctx, {
    campaign_id: c1.campaign.id,
    person_id: p1.id,
    enrolled_at: t("2026-09-13T09:00:00Z"),
  });
  await seedEnrollment(ctx, {
    campaign_id: c1.campaign.id,
    person_id: p2.id,
    status: "stopped",
    enrolled_at: t("2026-09-14T09:00:00Z"),
  });
  await seedEnrollment(ctx, {
    campaign_id: c1.campaign.id,
    person_id: p3.id,
    status: "completed",
    enrolled_at: t("2026-09-06T09:00:00Z"),
  });
  await seedEnrollment(ctx, {
    campaign_id: c1.campaign.id,
    person_id: p4.id,
    status: "stopped",
    enrolled_at: t("2026-09-07T09:00:00Z"),
  });
  await seedEnrollment(ctx, {
    campaign_id: c2.campaign.id,
    person_id: p6.id,
    enrolled_at: t("2026-09-15T08:30:00Z"),
  });

  const thread = (personId: string, channel: "email" | "linkedin" = "email") =>
    seedThread(ctx, { person_id: personId, channel });
  const t1 = await thread(p1.id);
  const t2 = await thread(p2.id);
  const t3 = await thread(p3.id);
  const t4 = await thread(p4.id);
  const t6 = await thread(p6.id, "linkedin");

  const [sig1] = await db
    .insert(signals)
    .values({
      workspace_id: ws,
      definition_key: "hiring_relevant_roles",
      company_id: coB.id,
      title: "Hiring a supply planner",
      source: "job_boards",
      detected_at: t("2026-09-13T06:00:00Z"),
      dedupe_key: "sig1",
    })
    .returning();
  await db.insert(signals).values([
    {
      workspace_id: ws,
      definition_key: "funding_round",
      company_id: coA.id,
      title: "Seed round",
      source: "news_gdelt",
      detected_at: t("2026-09-10T06:00:00Z"),
      dedupe_key: "sig2",
    },
    {
      workspace_id: ws,
      definition_key: "funding_round",
      company_id: coC.id,
      title: "Series A",
      source: "news_gdelt",
      detected_at: t("2026-09-17T06:00:00Z"),
      dedupe_key: "sig3",
    },
    {
      workspace_id: ws,
      definition_key: "funding_round",
      company_id: coB.id,
      title: "Rumored round",
      source: "news_gdelt",
      status: "dismissed",
      detected_at: t("2026-09-18T06:00:00Z"),
      dedupe_key: "sig4",
    },
  ]);
  await db.insert(signal_definitions).values([
    { workspace_id: ws, key: "funding_round", name: "Funding round", weight: 45 },
    { workspace_id: ws, key: "hiring_relevant_roles", name: "Hiring relevant roles", weight: 55 },
  ]);

  const out = (values: Partial<NewMessage>) =>
    seedMessage(ctx, {
      direction: "outbound",
      status: "sent",
      channel: "email",
      action: "email",
      mailbox_id: m1.id,
      created_at: values.sent_at ?? undefined,
      ...values,
    });
  const email = (personId: string, step: string, sentAt: string, extra: Partial<NewMessage> = {}) =>
    out({
      person_id: personId,
      campaign_id: c1.campaign.id,
      step_id: step,
      sent_at: t(sentAt),
      ...extra,
    });

  // Current period outbound: 5 emails (1 bounced), 2 LinkedIn sends, 1 visit; contacted p1 p2 p4 p5 p6.
  await email(p1.id, s1.id, "2026-09-13T10:00:00Z", {
    variant: "A",
    thread_id: t1.id,
    why: { signal_keys: ["funding_round"] },
  });
  await email(p2.id, s1.id, "2026-09-14T10:00:00Z", {
    variant: "B",
    thread_id: t2.id,
    status: "bounced",
    why: { signal_ids: [sig1?.id ?? ""] },
  });
  await email(p1.id, s3.id, "2026-09-16T10:00:00Z", { thread_id: t1.id });
  await email(p4.id, s3.id, "2026-09-12T00:00:00Z", { thread_id: t4.id }); // exactly at `from`
  await out({ person_id: p5.id, sent_at: t("2026-09-18T23:59:59Z") }); // manual, no campaign
  const linkedin = { channel: "linkedin" as const, mailbox_id: null, linkedin_account_id: a1.id };
  await out({
    ...linkedin,
    person_id: p6.id,
    campaign_id: c2.campaign.id,
    step_id: l1.id,
    action: "invite",
    sent_at: t("2026-09-15T09:00:00Z"),
  });
  await out({
    ...linkedin,
    person_id: p6.id,
    campaign_id: c2.campaign.id,
    step_id: l2.id,
    action: "message",
    thread_id: t6.id,
    sent_at: t("2026-09-17T09:00:00Z"),
  });
  await out({
    ...linkedin,
    person_id: p6.id,
    campaign_id: c2.campaign.id,
    action: "visit",
    sent_at: t("2026-09-15T08:00:00Z"),
  });
  // Outside the period: today (Chicago morning for the LinkedIn like) and a draft.
  await out({ person_id: p3.id, sent_at: t("2026-09-19T00:00:00Z") });
  await out({ ...linkedin, person_id: p6.id, action: "like", sent_at: t("2026-09-19T06:00:00Z") });
  await seedMessage(ctx, { person_id: p2.id, status: "draft", campaign_id: c1.campaign.id });
  await db.insert(linkedin_relations).values({
    workspace_id: ws,
    account_id: a1.id,
    person_id: p6.id,
    status: "connected",
    connected_at: t("2026-09-16T09:00:00Z"),
  });

  // Previous period outbound: 3 emails, contacted p3 p4.
  await email(p3.id, s1.id, "2026-09-06T10:00:00Z", { variant: "A", thread_id: t3.id });
  await email(p4.id, s1.id, "2026-09-07T10:00:00Z", { variant: "B", thread_id: t4.id });
  await email(p3.id, s3.id, "2026-09-10T10:00:00Z", { thread_id: t3.id });

  const reply = (values: Partial<NewMessage> & { at: string; category?: string }) => {
    const { at, category, ...rest } = values;
    return seedMessage(ctx, {
      direction: "inbound",
      status: "received",
      action: "reply",
      received_at: t(at),
      created_at: t(at),
      classification: category ? { category: category as "interested", confidence: 0.9 } : null,
      ...rest,
    });
  };
  // Current replies: p1 (interested + meeting_request), p6 (question, LinkedIn), p4 (not_now),
  // p5 (unclassified); the bounce DSN and the out-of-office do not count. 4 replied, 1 positive.
  await reply({
    person_id: p1.id,
    thread_id: t1.id,
    campaign_id: c1.campaign.id,
    mailbox_id: m1.id,
    at: "2026-09-16T15:00:00Z",
    category: "interested",
  });
  await reply({
    person_id: p1.id,
    thread_id: t1.id,
    campaign_id: c1.campaign.id,
    mailbox_id: m1.id,
    at: "2026-09-17T09:00:00Z",
    category: "meeting_request",
  });
  await reply({
    person_id: p6.id,
    thread_id: t6.id,
    campaign_id: c2.campaign.id,
    channel: "linkedin",
    action: "message",
    linkedin_account_id: a1.id,
    at: "2026-09-17T12:00:00Z",
    category: "question",
  });
  await reply({
    person_id: p4.id,
    thread_id: t4.id,
    campaign_id: c1.campaign.id,
    mailbox_id: m1.id,
    at: "2026-09-12T08:00:00Z",
    category: "not_now",
  });
  await reply({
    person_id: p2.id,
    thread_id: t2.id,
    campaign_id: c1.campaign.id,
    at: "2026-09-14T10:05:00Z",
    category: "bounce",
  });
  await reply({
    person_id: p3.id,
    thread_id: t3.id,
    campaign_id: c1.campaign.id,
    at: "2026-09-13T09:00:00Z",
    category: "out_of_office",
  });
  await reply({ person_id: p5.id, at: "2026-09-18T10:00:00Z" });
  // Previous reply: p3 interested (to the first email, variant A).
  await reply({
    person_id: p3.id,
    thread_id: t3.id,
    campaign_id: c1.campaign.id,
    mailbox_id: m1.id,
    at: "2026-09-08T10:00:00Z",
    category: "interested",
  });

  // Opportunities: meetings current = opp1 (event) + opp4 (created with a meeting, no event);
  // previous = opp2 (event on 09-10). opp2 won and opp3 lost in the current period.
  const [opp1, opp2] = await db
    .insert(opportunities)
    .values([
      {
        workspace_id: ws,
        person_id: p1.id,
        company_id: coA.id,
        campaign_id: c1.campaign.id,
        stage: "meeting_booked",
        value: 5000,
        currency: "EUR",
        source_signal_keys: ["funding_round"],
        created_at: t("2026-09-17T10:00:00Z"),
      },
      {
        workspace_id: ws,
        person_id: p3.id,
        campaign_id: c1.campaign.id,
        stage: "won",
        value: 12000,
        currency: "EUR",
        closed_at: t("2026-09-16T10:00:00Z"),
        created_at: t("2026-09-08T11:00:00Z"),
      },
      {
        workspace_id: ws,
        person_id: p4.id,
        campaign_id: c1.campaign.id,
        stage: "lost",
        value: 3000,
        currency: "USD",
        lost_reason: "Budget frozen",
        closed_at: t("2026-09-13T10:00:00Z"),
        created_at: t("2026-09-12T09:00:00Z"),
      },
      {
        workspace_id: ws,
        person_id: p6.id,
        campaign_id: c2.campaign.id,
        stage: "meeting_booked",
        created_at: t("2026-09-18T10:00:00Z"),
      },
      {
        workspace_id: ws,
        person_id: p5.id,
        stage: "interested",
        created_at: t("2026-09-02T10:00:00Z"),
      },
    ])
    .returning();
  const oppEvent = (opportunityId: string, stage: string, previous: string | null, at: string) => ({
    workspace_id: ws,
    type: "opportunity.updated" as const,
    subject_type: "opportunity",
    subject_id: opportunityId,
    data: {
      opportunity_id: opportunityId,
      stage,
      previous_stage: previous,
      person_id: null,
      company_id: null,
    },
    occurred_at: t(at),
  });
  await db
    .insert(events)
    .values([
      oppEvent(opp1?.id ?? "", "meeting_booked", "interested", "2026-09-17T11:00:00Z"),
      oppEvent(opp2?.id ?? "", "interested", null, "2026-09-08T11:00:00Z"),
      oppEvent(opp2?.id ?? "", "meeting_booked", "interested", "2026-09-10T11:00:00Z"),
      oppEvent(opp2?.id ?? "", "won", "meeting_booked", "2026-09-16T10:00:00Z"),
    ]);

  // Usage: current AI 1.25 + 0.05 + unpriced CLI call, data 0.20 USD and 40 credits;
  // previous AI 0.50 and 10 credits; 2.00 earlier this month (month to date only).
  const usage = (values: Partial<typeof usage_records.$inferInsert> & { created_at: Date }) => ({
    workspace_id: ws,
    slot: "brain" as const,
    provider: "anthropic",
    operation: "campaign.email.write",
    ...values,
  });
  await db.insert(usage_records).values([
    usage({ cost_usd: 1.25, created_at: t("2026-09-13T10:00:00Z") }),
    usage({
      operation: "inbox.reply.classify",
      cost_usd: 0.05,
      created_at: t("2026-09-14T10:00:00Z"),
    }),
    usage({ provider: "claude_cli", cost_usd: null, created_at: t("2026-09-15T10:00:00Z") }),
    usage({
      slot: "email_verifier",
      provider: "millionverifier",
      operation: "enrichment.verify",
      credits: 40,
      cost_usd: 0.2,
      created_at: t("2026-09-16T10:00:00Z"),
    }),
    usage({
      slot: "lead_source",
      provider: "apollo",
      operation: "leads.find",
      credits: 10,
      cost_usd: null,
      created_at: t("2026-09-06T10:00:00Z"),
    }),
    usage({ operation: "research.brief", cost_usd: 0.5, created_at: t("2026-09-06T10:00:00Z") }),
    usage({ operation: "research.brief", cost_usd: 2, created_at: t("2026-09-02T10:00:00Z") }),
  ]);
});

afterAll(async () => {
  await ctx.close();
});

describe("overview", () => {
  it("counts activity, rates and deltas against the previous 7 days", async () => {
    const output = await run({ type: "overview" });
    expect(output.period).toMatchObject({
      preset: "last_7_days",
      from: "2026-09-12T00:00:00.000Z",
      to: "2026-09-19T00:00:00.000Z",
      start_date: "2026-09-12",
      end_date: "2026-09-18",
      timezone: "UTC",
      partial: false,
    });
    expect(output.previous_period?.from).toBe("2026-09-05T00:00:00.000Z");
    const m = data(output, "overview").metrics;
    expect(m.new_leads).toEqual({ value: 4, previous: 2, change: 2, change_pct: 100 });
    expect(m.enrolled).toEqual({ value: 3, previous: 2, change: 1, change_pct: 50 });
    expect(m.contacted).toEqual({ value: 5, previous: 2, change: 3, change_pct: 150 });
    expect(m.emails_sent).toEqual({ value: 5, previous: 3, change: 2, change_pct: 66.7 });
    expect(m.linkedin_sent).toEqual({ value: 2, previous: 0, change: 2, change_pct: null });
    expect(m.bounced).toEqual({ value: 1, previous: 0, change: 1, change_pct: null });
    expect(m.replies).toEqual({ value: 4, previous: 1, change: 3, change_pct: 300 });
    expect(m.positive_replies).toEqual({ value: 1, previous: 1, change: 0, change_pct: 0 });
    expect(m.meetings).toEqual({ value: 2, previous: 1, change: 1, change_pct: 100 });
    expect(m.reply_rate).toEqual({ value: 80, previous: 50, change: 30, change_pct: null });
    expect(m.positive_rate).toEqual({ value: 20, previous: 50, change: -30, change_pct: null });
    expect(m.bounce_rate).toEqual({ value: 20, previous: 0, change: 20, change_pct: null });
    expect(data(output, "overview").replies_by_category).toEqual({
      interested: 1,
      meeting_request: 1,
      question: 1,
      not_now: 1,
      unclassified: 1,
    });
    expect(output.definitions.reply_rate).toBe(
      "Reply rate = replied people / contacted people x 100.",
    );
    expect(output.definitions.bounce_rate).toContain("bounced emails / sent emails");
  });

  it("without comparison the previous values are null", async () => {
    const output = await run({ type: "overview", compare: false });
    expect(output.previous_period).toBeNull();
    expect(data(output, "overview").metrics.contacted).toEqual({
      value: 5,
      previous: null,
      change: null,
      change_pct: null,
    });
  });

  it("rates are null when nobody was contacted", async () => {
    const output = await run({ type: "overview", from: "2026-08-01", to: "2026-08-02" });
    const m = data(output, "overview").metrics;
    expect(m.reply_rate.value).toBeNull();
    expect(m.contacted.value).toBe(0);
    expect(output.notes[0]).toContain("Nobody was contacted");
  });

  it("renders markdown and csv", async () => {
    const markdown = (await run({ type: "overview", format: "markdown" })).markdown ?? "";
    expect(markdown).toContain(`## Overview: ${ctx.workspace.name}`);
    expect(markdown).toContain(
      "Last 7 days: 2026-09-12 to 2026-09-18 (UTC). Compared with 2026-09-05 to 2026-09-11.",
    );
    expect(markdown).toContain("| Reply rate | 80.0% | 50.0% | +30.0 pp |");
    expect(markdown).toContain("| Emails sent | 5 | 3 | +2 (+66.7%) |");
    expect(markdown).toContain("| Positive rate | 20.0% | 50.0% | -30.0 pp |");
    expect(markdown).toContain("Replies by category: interested 1");
    expect(markdown).toContain("- Reply rate = replied people / contacted people x 100.");
    const csv = (await run({ type: "overview", format: "csv" })).csv ?? "";
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("metric,value,previous,change,change_pct");
    expect(lines).toContain("reply_rate,80,50,30,");
    expect(lines).toContain("emails_sent,5,3,2,66.7");
  });
});

describe("campaign", () => {
  it("lists active campaigns busiest first with funnels by step and variant", async () => {
    const output = await run({ type: "campaign" });
    const report = data(output, "campaign");
    expect(report.truncated).toBe(false);
    expect(report.campaigns.map((campaign) => campaign.name)).toEqual([
      "Signal play",
      "LinkedIn warm",
    ]);
    const [c1, c2] = report.campaigns;
    expect(c1?.metrics.contacted).toEqual({ value: 3, previous: 2, change: 1, change_pct: 50 });
    expect(c1?.metrics.emails_sent.value).toBe(4);
    expect(c1?.metrics.bounced.value).toBe(1);
    expect(c1?.metrics.replies).toEqual({ value: 2, previous: 1, change: 1, change_pct: 100 });
    expect(c1?.metrics.positive_replies.value).toBe(1);
    expect(c1?.metrics.meetings).toEqual({ value: 1, previous: 1, change: 0, change_pct: 0 });
    expect(c1?.metrics.enrolled).toEqual({ value: 2, previous: 2, change: 0, change_pct: 0 });
    expect(c1?.metrics.reply_rate.value).toBe(66.7);
    expect(c1?.metrics.bounce_rate.value).toBe(25);
    expect(c1?.enrollments).toEqual({ active: 1, completed: 1, stopped: 2 });

    expect(c1?.steps.map((step) => [step.position, step.label])).toEqual([
      [1, "Email"],
      [3, "Email (same thread)"],
    ]);
    const [first, followUp] = c1?.steps ?? [];
    expect(first).toMatchObject({
      sent: 2,
      people: 2,
      bounced: 1,
      replies: 0,
      bounce_rate: 50,
      accepted: null,
    });
    expect(first?.variants).toEqual([
      {
        variant: "A",
        sent: 1,
        people: 1,
        bounced: 0,
        replies: 0,
        positive_replies: 0,
        reply_rate: 0,
        positive_rate: 0,
        bounce_rate: 0,
        // p1 got variant A on 09-13 and booked on 09-17.
        meetings: 1,
        meeting_rate: 100,
      },
      {
        variant: "B",
        sent: 1,
        people: 1,
        bounced: 1,
        replies: 0,
        positive_replies: 0,
        reply_rate: 0,
        positive_rate: 0,
        bounce_rate: 100,
        meetings: 0,
        meeting_rate: 0,
      },
    ]);
    // A handful of sends per variant is not enough data: no leader yet.
    expect(first).toMatchObject({
      ab_metric: "positive_reply_rate",
      leader: null,
      confidence: null,
      enough_data: false,
    });
    // Replies go to the latest message in the same thread: both replies answer step 3.
    expect(followUp).toMatchObject({
      sent: 2,
      people: 2,
      replies: 2,
      positive_replies: 1,
      reply_rate: 100,
      positive_rate: 50,
    });
    expect(followUp?.variants).toEqual([]);

    expect(c2?.metrics.contacted.value).toBe(1);
    expect(c2?.metrics.linkedin_sent.value).toBe(2);
    expect(c2?.metrics.replies.value).toBe(1);
    expect(c2?.metrics.meetings.value).toBe(1);
    expect(c2?.steps.map((step) => [step.label, step.sent, step.replies, step.accepted])).toEqual([
      ["LinkedIn invite", 1, 0, 1],
      ["LinkedIn message", 1, 1, null],
      ["Other messages (manual replies, removed steps)", 1, 0, null],
    ]);
  });

  it("shows one campaign with campaign_id and rejects unknown ones", async () => {
    const output = await run({ type: "campaign", campaign_id: ids.c2 });
    expect(data(output, "campaign").campaigns.map((campaign) => campaign.id)).toEqual([ids.c2]);
    await expect(
      run({ type: "campaign", campaign_id: "cmp_01k6a3v0q8x3m2n4p5r6s7t8v9" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(run({ type: "overview", campaign_id: ids.c2 })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("renders a funnel table and one csv row per step and variant", async () => {
    const markdown = (await run({ type: "campaign", format: "markdown" })).markdown ?? "";
    expect(markdown).toContain(
      "| Signal play | active | 3 (+1) | 2 (+1) | 1 (0) | 1 (0) | 66.7% (+16.7 pp) | 33.3% (-16.7 pp) | 25.0% (+25.0 pp) |",
    );
    expect(markdown).toContain(
      "| LinkedIn warm | active | 1 (+1) | 1 (+1) | 0 (0) | 1 (+1) | 100.0% | 0.0% | - |",
    );
    expect(markdown).toContain("### Signal play: funnel by step");
    expect(markdown).toContain("| 1. Email / variant B | 1 | 1 | 1 | 0 | 0 | 0.0% | 0.0% | - |");
    const csv = (await run({ type: "campaign", format: "csv" })).csv ?? "";
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("campaign_id,campaign,status,step,step_type,variant,sent");
    expect(lines).toHaveLength(1 + 3 + 3); // header, c1: s1 A + s1 B + s3, c2: invite + message + other
    expect(lines).toContain(`${ids.c1},Signal play,active,1,email,B,1,1,1,0,0,,0,0,100`);
  });

  it("counts messages that went out twice in the period, once per message", async () => {
    const duplicate = (messageId: string, at: string) => ({
      workspace_id: ctx.workspace.id,
      type: "message.duplicate" as const,
      subject_type: "message",
      subject_id: messageId,
      data: {
        message_id: messageId,
        attempts: [1, 2],
        channel: "email",
        campaign_id: ids.c1,
        person_id: null,
      },
      occurred_at: t(at),
    });
    const inserted = await ctx.db
      .insert(events)
      .values([
        duplicate("msg_dup_one", "2026-09-15T10:00:00Z"),
        duplicate("msg_dup_one", "2026-09-15T10:05:00Z"),
        // Before the period: not counted.
        duplicate("msg_dup_old", "2026-09-08T10:00:00Z"),
      ])
      .returning({ id: events.id });
    try {
      const output = await run({ type: "campaign" });
      const report = data(output, "campaign");
      const byName = Object.fromEntries(report.campaigns.map((row) => [row.name, row.duplicates]));
      expect(byName).toEqual({ "Signal play": 1, "LinkedIn warm": 0 });
      expect(output.notes.join(" ")).toContain("Signal play: 1 message went out twice");
      expect(output.definitions.duplicates).toContain("message.duplicate");
    } finally {
      await ctx.db.delete(events).where(
        inArray(
          events.id,
          inserted.map((row) => row.id),
        ),
      );
    }
  });
});

describe("senders", () => {
  it("reports each mailbox and LinkedIn account with limits used today", async () => {
    const report = data(await run({ type: "senders" }), "senders");
    expect(report.metrics.emails_sent.value).toBe(5);
    expect(report.metrics.bounce_rate.value).toBe(20);
    const sam = report.mailboxes.find((mailbox) => mailbox.id === ids.m1);
    expect(sam).toMatchObject({
      sent: 5,
      bounced: 1,
      bounce_rate: 20,
      replies: 2,
      daily_limit: 30,
      sent_today: 1,
      limit_used_pct: 3.3,
    });
    expect(report.mailboxes.find((mailbox) => mailbox.id === ids.m2)).toMatchObject({
      status: "paused",
      status_reason: "bounce rate 4%",
      sent: 0,
      bounce_rate: null,
    });
    const account = report.linkedin_accounts.find((row) => row.id === ids.a1);
    expect(account).toMatchObject({
      invites_sent: 1,
      invites_accepted: 1,
      acceptance_rate: 100,
      messages_sent: 1,
      other_actions: 1,
      replies: 1,
    });
    // Today in Chicago started at 05:00 UTC: the 06:00 UTC like counts, invites use a rolling week.
    expect(account?.limits.likes_per_day).toEqual({ used: 1, limit: 30 });
    expect(account?.limits.invites_per_week).toEqual({ used: 1, limit: 80 });
    expect(account?.limits.invites_per_day).toEqual({ used: 0, limit: 15 });
    expect(report.linkedin_accounts.find((row) => row.status === "restricted")).toBeDefined();
  });

  it("renders mailbox and account tables", async () => {
    const markdown = (await run({ type: "senders", format: "markdown" })).markdown ?? "";
    expect(markdown).toContain(
      "| sam@northwind.example.org | active | 5 | 1 | 20.0% | 2 | 1 / 30 |",
    );
    expect(markdown).toContain("| alex@northwind.example.org (bounce rate 4%) | paused |");
    expect(markdown).toContain("### LinkedIn accounts");
  });
});

describe("signals", () => {
  it("attributes messages, replies, positives and meetings to signal keys", async () => {
    const output = await run({ type: "signals" });
    const report = data(output, "signals");
    expect(report.metrics.detected).toEqual({ value: 3, previous: 1, change: 2, change_pct: 200 });
    expect(report.metrics.messages).toEqual({ value: 2, previous: 0, change: 2, change_pct: null });
    expect(report.metrics.people.value).toBe(2);
    expect(report.metrics.positive_replies.value).toBe(1);
    expect(report.keys).toEqual([
      {
        key: "funding_round",
        name: "Funding round",
        detected: 2,
        messages: 1,
        people: 1,
        replies: 1,
        positive_replies: 1,
        meetings: 1,
        meetings_held: 0,
        reply_rate: 100,
        positive_rate: 100,
        meeting_rate: 100,
        lift: null,
        current_weight: 45,
        suggested_weight: null,
      },
      {
        key: "hiring_relevant_roles",
        name: "Hiring relevant roles",
        detected: 1,
        messages: 1,
        people: 1,
        replies: 0,
        positive_replies: 0,
        meetings: 0,
        meetings_held: 0,
        reply_rate: 0,
        positive_rate: 0,
        meeting_rate: 0,
        lift: null,
        current_weight: 55,
        suggested_weight: null,
      },
    ]);
    // Contacted without signals: p4, p5, p6. p5's reply came before the first contact.
    expect(report.baseline).toEqual({
      people: 3,
      replies: 2,
      positive_replies: 0,
      reply_rate: 66.7,
      positive_rate: 0,
    });
    expect(output.notes.join(" ")).toContain("Suggested weights need at least 150 people");
    const csv = (await run({ type: "signals", format: "csv" })).csv ?? "";
    expect(csv).toContain("(no signal),Baseline,,,3,2,0,,,66.7,0");
  });
});

describe("icp", () => {
  it("reports per ICP, fit tier and criterion with a calibration check", async () => {
    const report = data(await run({ type: "icp" }), "icp");
    expect(report.icps).toEqual([
      {
        icp_id: expect.any(String),
        name: "DTC brands",
        contacted: 3,
        replies: 2,
        positive_replies: 1,
        meetings: 1,
        reply_rate: 66.7,
        positive_rate: 33.3,
      },
      {
        icp_id: null,
        name: "No ICP (campaign without ICP or no campaign)",
        contacted: 2,
        replies: 2,
        positive_replies: 0,
        meetings: 1,
        reply_rate: 100,
        positive_rate: 0,
      },
    ]);
    const tier = (name: string) => report.tiers.find((row) => row.tier === name);
    expect(tier("A")).toMatchObject({
      fit_range: "80-100",
      contacted: 2,
      replies: 2,
      positive_replies: 1,
      meetings: 2,
      positive_rate: 50,
    });
    expect(tier("B")).toMatchObject({ contacted: 1, replies: 0 });
    expect(tier("C")).toMatchObject({ contacted: 0, reply_rate: null });
    expect(tier("D")).toMatchObject({ contacted: 1, replies: 1, positive_replies: 0 });
    expect(tier("unscored")).toMatchObject({ contacted: 1, replies: 0 });
    expect(report.criteria).toEqual([
      { rule: "industry", contacted: 2, positive_replies: 1, positive_rate: 50 },
      { rule: "title", contacted: 2, positive_replies: 0, positive_rate: 0 },
    ]);
    expect(report.calibration).toEqual({
      status: "insufficient_data",
      note: "Needs 300+ contacted in tiers A and C (now A: 2, C: 0).",
    });
  });
});

describe("pipeline", () => {
  it("shows stages, period movement, wins, losses and reasons", async () => {
    const report = data(await run({ type: "pipeline" }), "pipeline");
    expect(report.metrics.new_opportunities).toEqual({
      value: 3,
      previous: 1,
      change: 2,
      change_pct: 200,
    });
    expect(report.metrics.meetings).toEqual({ value: 2, previous: 1, change: 1, change_pct: 100 });
    expect(report.metrics.won.value).toBe(1);
    expect(report.metrics.lost.value).toBe(1);
    expect(report.metrics.win_rate).toEqual({
      value: 50,
      previous: null,
      change: null,
      change_pct: null,
    });
    expect(report.stages).toEqual([
      { stage: "interested", count: 1, value: [] },
      { stage: "meeting_booked", count: 2, value: [{ currency: "EUR", amount: 5000 }] },
      { stage: "won", count: 1, value: [{ currency: "EUR", amount: 12000 }] },
      { stage: "lost", count: 1, value: [{ currency: "USD", amount: 3000 }] },
    ]);
    expect(report.won_value).toEqual([{ currency: "EUR", amount: 12000 }]);
    expect(report.lost_reasons).toEqual([{ reason: "Budget frozen", count: 1 }]);
    expect(report.won_by_campaign).toEqual([
      {
        campaign_id: ids.c1,
        campaign: "Signal play",
        count: 1,
        value: [{ currency: "EUR", amount: 12000 }],
      },
    ]);
    const csv = (await run({ type: "pipeline", format: "csv" })).csv ?? "";
    expect(csv.trim().split("\r\n")).toEqual([
      "stage,count,value,currency",
      "interested,1,,",
      "meeting_booked,2,5000,EUR",
      "won,1,12000,EUR",
      "lost,1,3000,USD",
    ]);
  });
});

describe("costs", () => {
  it("splits AI and data spend by provider and operation with budget use", async () => {
    const output = await run({ type: "costs" });
    const report = data(output, "costs");
    expect(report.metrics.ai_cost_usd).toEqual({
      value: 1.3,
      previous: 0.5,
      change: 0.8,
      change_pct: 160,
    });
    expect(report.metrics.data_cost_usd).toEqual({
      value: 0.2,
      previous: 0,
      change: 0.2,
      change_pct: null,
    });
    expect(report.metrics.data_credits).toEqual({
      value: 40,
      previous: 10,
      change: 30,
      change_pct: 300,
    });
    expect(report.metrics.total_cost_usd.value).toBe(1.5);
    expect(report.by_provider).toEqual([
      {
        kind: "ai",
        slot: "brain",
        provider: "anthropic",
        operation: null,
        calls: 2,
        cost_usd: 1.3,
        credits: 0,
      },
      {
        kind: "data",
        slot: "email_verifier",
        provider: "millionverifier",
        operation: null,
        calls: 1,
        cost_usd: 0.2,
        credits: 40,
      },
      {
        kind: "ai",
        slot: "brain",
        provider: "claude_cli",
        operation: null,
        calls: 1,
        cost_usd: 0,
        credits: 0,
      },
    ]);
    expect(report.by_operation.map((row) => [row.operation, row.cost_usd])).toEqual([
      ["campaign.email.write", 1.25],
      ["enrichment.verify", 0.2],
      ["inbox.reply.classify", 0.05],
      ["campaign.email.write", 0],
    ]);
    expect(report.budget).toEqual({
      ai: { monthly_budget_usd: 4, month_to_date_usd: 3.8, used_pct: 95 },
      data: { monthly_credit_budget: 100, month_to_date_credits: 50, used_pct: 50 },
    });
    expect(report.unpriced_calls).toBe(1);
    expect(output.notes[0]).toContain("1 AI calls have no price");
    const markdown = (await run({ type: "costs", format: "markdown" })).markdown ?? "";
    expect(markdown).toContain("AI budget: $3.80 used this month of $4.00 (95.0%).");
  });
});

describe("period boundaries across timezones", () => {
  it("counts a message in the local day it was sent", async () => {
    const chicago = await seedWorkspace(ctx.db, { timezone: "America/Chicago" });
    const target = { db: ctx.db, workspace: chicago };
    const person = await seedPerson(target, { created_at: t("2026-09-01T00:00:00Z") });
    const send = (at: string) =>
      seedMessage(target, {
        person_id: person.id,
        direction: "outbound",
        status: "sent",
        sent_at: t(at),
      });
    await send("2026-09-12T04:30:00Z"); // Chicago 09-11 23:30: previous period
    await send("2026-09-19T04:30:00Z"); // Chicago 09-18 23:30: last day of the period
    const local = ctx.with({ workspace: chicago });

    const inChicago = await run({ type: "overview" }, local);
    expect(inChicago.period.from).toBe("2026-09-12T05:00:00.000Z");
    expect(data(inChicago, "overview").metrics.emails_sent).toMatchObject({
      value: 1,
      previous: 1,
    });

    const inUtc = await run({ type: "overview", timezone: "UTC" }, local);
    expect(inUtc.period.timezone).toBe("UTC");
    expect(data(inUtc, "overview").metrics.emails_sent).toMatchObject({ value: 1, previous: 0 });

    await expect(run({ type: "overview", timezone: "Mars/Base" }, local)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});
