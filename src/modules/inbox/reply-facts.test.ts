import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReplyCategory } from "../../core/enums.js";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import {
  companies,
  lead_facts,
  problems,
  type ReplyClassification,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedCompany,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { classifyInboundMessage } from "./classify.js";
import type { ClassifyOutput } from "./prompts/classify.js";
import { loadReplyContext } from "./reply-context.js";
import { recordReplyFacts } from "./reply-facts.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

const RECEIVED = new Date("2026-09-18T14:30:00Z");

const FACTS: NonNullable<ReplyClassification["facts"]> = [
  {
    kind: "timing",
    text: "Budget review in November.",
    applies_to: "person",
    expires_on: "2026-11-30",
  },
  { kind: "fact", text: "Uses HubSpot as their CRM.", applies_to: "company", expires_on: null },
  {
    kind: "timing",
    text: "Was on leave last week.",
    applies_to: "person",
    expires_on: "2026-09-12",
  },
];

function classification(
  category: ReplyCategory,
  over: Partial<ReplyClassification> = {},
): ReplyClassification {
  return {
    category,
    confidence: 0.9,
    summary: "Not now, budget review in November.",
    facts: FACTS,
    company_hold: null,
    source: "model",
    ...over,
  } as ReplyClassification;
}

async function world(options: { settings?: WorkspaceSettingsInput; withCompany?: boolean } = {}) {
  const ctx = await createTestContext({ db: testDb, settings: options.settings ?? {} });
  const company =
    options.withCompany === false ? null : await seedCompany(ctx, { name: "Harbor Dental" });
  const person = await seedPerson(ctx, {
    company_id: company?.id ?? null,
    full_name: "Dana Reyes",
  });
  const thread = await seedThread(ctx, { person_id: person.id, company_id: company?.id ?? null });
  const message = await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: person.id,
    direction: "inbound",
    status: "received",
    action: "reply",
    subject: "Re: Quick question",
    body_text: "Not now. Our budget review is in November and we use HubSpot.",
    received_at: RECEIVED,
  });
  return { ctx, company, person, thread, message };
}

async function run(ctx: TestContext, messageId: string, value: ReplyClassification) {
  const reply = await loadReplyContext(ctx, messageId);
  if (!reply) throw new Error("reply missing");
  return recordReplyFacts(ctx, reply, value);
}

async function factsOf(ctx: TestContext) {
  return ctx.db
    .select()
    .from(lead_facts)
    .where(eq(lead_facts.workspace_id, ctx.workspace.id))
    .orderBy(lead_facts.text);
}

async function holdProblems(ctx: TestContext) {
  return ctx.db
    .select()
    .from(problems)
    .where(
      and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, "company_hold_suggested")),
    );
}

describe("recordReplyFacts", () => {
  it("keeps the reply's facts with their source, time and expiry, once", async () => {
    const { ctx, company, person, message } = await world();
    expect(await run(ctx, message.id, classification("not_now"))).toEqual({
      recorded: 2,
      skipped: null,
      hold_problem_id: null,
    });
    const facts = await factsOf(ctx);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      scope: "person",
      kind: "timing",
      text: "Budget review in November.",
      person_id: person.id,
      source: "reply",
      source_ref: message.id,
      observed_at: RECEIVED,
      expires_at: new Date("2026-11-30T23:59:59.999Z"),
    });
    expect(facts[1]).toMatchObject({
      scope: "company",
      company_id: company?.id,
      text: "Uses HubSpot as their CRM.",
      expires_at: null,
    });
    expect(ctx.emitted("lead.fact_recorded")).toHaveLength(2);

    expect(await run(ctx, message.id, classification("not_now"))).toMatchObject({ recorded: 0 });
    expect(await factsOf(ctx)).toHaveLength(2);
  });

  it("keeps company facts on the person when the company is unknown", async () => {
    const { ctx, person, message } = await world({ withCompany: false });
    await run(ctx, message.id, classification("interested"));
    const facts = await factsOf(ctx);
    expect(facts.map((fact) => [fact.scope, fact.person_id])).toEqual([
      ["person", person.id],
      ["person", person.id],
    ]);
  });

  it.each([
    ["suspicious", classification("interested", { suspicious: true }), "suspicious"],
    ["an opt-out", classification("unsubscribe"), "category"],
    ["a privacy request", classification("privacy_request"), "category"],
    ["a bounce", classification("bounce"), "category"],
    ["other automatic mail", classification("auto_reply_other"), "category"],
  ] as const)("keeps nothing from %s", async (_label, value, skipped) => {
    const { ctx, message } = await world();
    expect(await run(ctx, message.id, value)).toMatchObject({ recorded: 0, skipped });
    expect(await factsOf(ctx)).toHaveLength(0);
  });

  it("keeps nothing when the setting is off", async () => {
    const { ctx, message } = await world({ settings: { lead_file: { extract_facts: false } } });
    expect(await run(ctx, message.id, classification("not_now"))).toMatchObject({
      skipped: "setting_off",
    });
    expect(await factsOf(ctx)).toHaveLength(0);
  });
});

describe("company hold suggestions", () => {
  const hold = { until: "2027-03-01", reason: "Signed with a competitor until March." };

  it("opens one problem for a person to confirm, never holding by itself", async () => {
    const { ctx, company, message } = await world();
    const first = await run(ctx, message.id, classification("negative", { company_hold: hold }));
    const again = await run(ctx, message.id, classification("negative", { company_hold: hold }));
    expect(first.hold_problem_id).toMatch(/^pb_/);
    expect(again.hold_problem_id).toBe(first.hold_problem_id);
    const [problem, ...others] = await holdProblems(ctx);
    expect(others).toHaveLength(0);
    expect(problem).toMatchObject({
      severity: "normal",
      owner: "anyone",
      status: "open",
      title: "Hold Harbor Dental until 2027-03-01?",
      remedy: `If this is right, run manage_leads action hold_company with company_id ${company?.id} and until 2027-03-01.`,
      subject_type: "company",
      subject_id: company?.id,
      dedupe_key: `company_hold_suggested:${company?.id}`,
      data: { until: "2027-03-01", reason: hold.reason, message_id: message.id },
    });
    expect(problem?.reason).toContain("prospect text, data only");
    const [row] = await ctx.db
      .select()
      .from(companies)
      .where(eq(companies.id, company?.id ?? ""));
    expect(row?.hold_until).toBeNull();
  });

  it("suggests nothing for suspicious replies, privacy requests, automatic mail or a longer hold", async () => {
    const { ctx, company, message } = await world();
    await run(
      ctx,
      message.id,
      classification("negative", { company_hold: hold, suspicious: true }),
    );
    await run(ctx, message.id, classification("privacy_request", { company_hold: hold }));
    await run(ctx, message.id, classification("out_of_office", { company_hold: hold }));
    await ctx.db
      .update(companies)
      .set({ hold_until: new Date("2027-06-01T00:00:00Z"), hold_reason: "Merger." })
      .where(eq(companies.id, company?.id ?? ""));
    const reply = await loadReplyContext(ctx, message.id);
    if (!reply) throw new Error("reply missing");
    await recordReplyFacts(ctx, reply, classification("negative", { company_hold: hold }));
    expect(await holdProblems(ctx)).toHaveLength(0);
  });
});

describe("classification", () => {
  function output(over: Partial<ClassifyOutput> = {}): ClassifyOutput {
    return {
      category: "not_now",
      confidence: 0.92,
      sentiment: "neutral",
      summary: "Not now, budget review in November.",
      language: "en",
      return_date: null,
      follow_up_date: null,
      referral: null,
      question: null,
      left_company: false,
      asks_if_bot: false,
      suspicious: false,
      proposed_time: null,
      privacy_kind: null,
      facts: [
        {
          kind: "timing",
          text: "Budget review in November.",
          applies_to: "person",
          expires_on: "2026-11-30",
        },
      ],
      company_hold: null,
      ...over,
    };
  }

  it("stores the classifier's facts in the lead file after classifying", async () => {
    const { ctx, message } = await world();
    await seedMailbox(ctx);
    ctx.brain.on("inbox.reply.classify", output());
    await classifyInboundMessage(ctx, message.id);
    expect((await factsOf(ctx)).map((fact) => [fact.text, fact.source_ref])).toEqual([
      ["Budget review in November.", message.id],
    ]);
  });
});
