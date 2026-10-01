/** Attention queue on a seeded workspace. Clock: 2026-09-19 12:00 UTC. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NewMessage } from "../../db/schema/index.js";
import {
  approvals,
  icps,
  knowledge_gaps,
  knowledge_items,
  meetings,
  messages,
  monitors,
  problems,
  signals,
  tasks,
  usage_records,
} from "../../db/schema/index.js";
import type { BrainProvider, EmailVerifierProvider } from "../../providers/types.js";
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
} from "../../testing/factories.js";
import { openProblem, resolveProblem, snoozeProblem } from "../problems/service.js";
import { getOperatingState } from "../relationships/operations.js";
import { nextStep } from "./attention/build.js";
import type { AttentionOutput } from "./attention/schema.js";
import { getAttention } from "./operations/get-attention.js";

const NOW = "2026-09-19T12:00:00.000Z";
const t = (iso: string) => new Date(iso);
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(t(NOW).getTime() - hours * HOUR);

const fakeBrain = { id: "fake", capabilities: {}, defaultModels: {} } as unknown as BrainProvider;
const fakeVerifier = { id: "millionverifier" } as unknown as EmailVerifierProvider;

let ctx: TestContext;
const ids: Record<string, string> = {};

async function attention(input: Record<string, unknown> = {}, context: TestContext = ctx) {
  return getAttention.output.parse(
    await getAttention.handler(context, getAttention.input.parse(input)),
  );
}

beforeAll(async () => {
  ctx = await createTestContext({
    now: NOW,
    providers: { brain: fakeBrain, email_verifier: fakeVerifier },
    settings: {
      ai: { monthly_budget_usd: 10 },
      data: {
        monthly_credit_budget: 100,
        enrichment: { finders: ["hunter"], verifier: "millionverifier" },
      },
    },
  });
  const db = ctx.db;
  const ws = ctx.workspace.id;

  // Approvals: 7 messages and 1 reply pending; one expired and one decided do not count.
  await db.insert(approvals).values([
    ...Array.from({ length: 7 }, (_, i) => ({
      workspace_id: ws,
      kind: "message" as const,
      title: `Email ${i + 1}`,
      target_type: "message",
      target_id: `msg_${i + 1}`,
      created_at: ago(30 - i),
    })),
    { workspace_id: ws, kind: "reply" as const, title: "Reply to Dana", created_at: ago(5) },
    {
      workspace_id: ws,
      kind: "message" as const,
      title: "Expired",
      created_at: ago(80),
      expires_at: ago(1),
    },
    {
      workspace_id: ws,
      kind: "message" as const,
      title: "Approved",
      status: "approved" as const,
      created_at: ago(90),
    },
  ]);

  // Hot replies.
  const company = await seedCompany(ctx, { name: "Harbor Supply" });
  const hotPerson = await seedPerson(ctx, {
    first_name: "Dana",
    last_name: "Reyes",
    full_name: "Dana Reyes",
    company_id: company.id,
  });
  const inbound = (threadId: string, at: Date, category: string | null, summary?: string) =>
    seedMessage(ctx, {
      thread_id: threadId,
      direction: "inbound",
      status: "received",
      action: "reply",
      received_at: at,
      created_at: at,
      classification: category
        ? { category: category as "interested", confidence: 0.9, ...(summary ? { summary } : {}) }
        : null,
    });
  const thread = async (overrides: Parameters<typeof seedThread>[1] = {}) =>
    (await seedThread(ctx, { person_id: hotPerson.id, ...overrides })).id;

  ids.hot = await thread();
  await inbound(ids.hot, ago(3), "interested", `Sounds good, send times. ${"x".repeat(400)}`);
  ids.fresh = await thread(); // too recent
  await inbound(ids.fresh, ago(1), "meeting_request");
  ids.answered = await thread();
  await inbound(ids.answered, ago(6), "interested");
  await seedMessage(ctx, {
    thread_id: ids.answered,
    status: "sent",
    sent_at: ago(5),
    created_at: ago(5),
  });
  ids.drafted = await thread({ channel: "linkedin" });
  await inbound(ids.drafted, ago(4), "meeting_request");
  await seedMessage(ctx, {
    thread_id: ids.drafted,
    channel: "linkedin",
    action: "message",
    status: "pending_review",
    created_at: ago(3.5),
  });
  ids.cooled = await thread(); // the latest inbound decides
  await inbound(ids.cooled, ago(8), "interested");
  await inbound(ids.cooled, ago(7), "not_interested");
  ids.old = await thread();
  await inbound(ids.old, ago(24 * 40), "interested");
  ids.closed = await thread({ status: "closed" });
  await inbound(ids.closed, ago(5), "interested");

  // Knowledge gaps: two open, one answered.
  await db.insert(knowledge_gaps).values([
    { workspace_id: ws, question: "Do you integrate with our ERP?", created_at: ago(48) },
    {
      workspace_id: ws,
      question: "Is there a free trial?",
      thread_id: ids.hot,
      created_at: ago(2),
    },
    {
      workspace_id: ws,
      question: "Where is data stored?",
      status: "answered",
      created_at: ago(50),
    },
  ]);

  // Senders: one active, one failing, one paused, a noisy one and a restricted LinkedIn account.
  const active = await seedMailbox(ctx, { email: "sam@harbor.example.org" });
  const failing = await seedMailbox(ctx, {
    email: "err@harbor.example.org",
    status: "error",
    status_reason: "SMTP auth failed",
  });
  await seedMailbox(ctx, { email: "paused@harbor.example.org", status: "paused" });
  const noisy = await seedMailbox(ctx, { email: "noisy@harbor.example.org" });
  Object.assign(ids, { active: active.id, failing: failing.id, noisy: noisy.id });
  await seedLinkedInAccount(ctx, { name: "Sam LinkedIn" });
  const restricted = await seedLinkedInAccount(ctx, {
    name: "Alex LinkedIn",
    status: "restricted",
    status_reason: "too many invites",
  });
  ids.restricted = restricted.id;

  // Bounces over the last 7 days: noisy 1 of 25 (4%, critical), active 1 of 40 (2.5%, warning).
  const sends = (mailboxId: string, count: number, bounced: number): NewMessage[] =>
    Array.from({ length: count }, (_, i) => ({
      workspace_id: ws,
      channel: "email" as const,
      action: "email" as const,
      direction: "outbound" as const,
      status: i < bounced ? ("bounced" as const) : ("sent" as const),
      mailbox_id: mailboxId,
      sent_at: ago(24 + i),
      created_at: ago(24 + i),
    }));
  await db.insert(messages).values([...sends(noisy.id, 25, 1), ...sends(active.id, 40, 1)]);

  // Budgets this month: AI 8.50 of 10 (85%), data 120 of 100 credits (120%).
  await db.insert(usage_records).values([
    {
      workspace_id: ws,
      slot: "brain",
      provider: "anthropic",
      operation: "x",
      cost_usd: 8.5,
      created_at: t("2026-09-03T10:00:00Z"),
    },
    {
      workspace_id: ws,
      slot: "brain",
      provider: "anthropic",
      operation: "x",
      cost_usd: 50,
      created_at: t("2026-08-30T10:00:00Z"),
    },
    {
      workspace_id: ws,
      slot: "email_finder",
      provider: "hunter",
      operation: "y",
      credits: 120,
      created_at: t("2026-09-10T10:00:00Z"),
    },
  ]);

  // A monitor with a provider collector (missing) and one built-in collector.
  await db.insert(monitors).values({
    workspace_id: ws,
    name: "Funding watch",
    target: { kind: "all_active" },
    collectors: ["news_gdelt", "crunchbase"],
    schedule: "0 6 * * *",
  });

  // Setup: knowledge, ICP, leads and a launched campaign; no offer, no notification channel.
  await db.insert(knowledge_items).values({ workspace_id: ws, kind: "about", title: "About us" });
  await db.insert(icps).values({ workspace_id: ws, name: "Distributors" });
  const { campaign: dry } = await seedCampaign(ctx, {
    name: "Dry campaign",
    status: "active",
    launched_at: ago(24 * 10),
  });
  ids.dry = dry.id;
  const done = await seedPerson(ctx, { status: "active" });
  await seedEnrollment(ctx, { campaign_id: dry.id, person_id: done.id, status: "completed" });

  // Suggestions: two fresh-signal leads outside campaigns, one of them tier A.
  const signalCompany = await seedCompany(ctx, { name: "Cedar Goods" });
  await seedPerson(ctx, { company_id: signalCompany.id, status: "new", fit_score: 85 });
  await seedPerson(ctx, { company_id: signalCompany.id, status: "new", fit_score: 60 });
  await seedPerson(ctx, { company_id: signalCompany.id, status: "new", email: null });
  await db.insert(signals).values([
    {
      workspace_id: ws,
      definition_key: "funding_round",
      company_id: signalCompany.id,
      title: "Series A",
      source: "news_gdelt",
      detected_at: ago(24 * 3),
      dedupe_key: "fresh",
    },
    {
      workspace_id: ws,
      definition_key: "hiring_relevant_roles",
      company_id: signalCompany.id,
      title: "Old hiring post",
      source: "job_boards",
      detected_at: ago(24 * 20),
      dedupe_key: "stale",
    },
  ]);
});

afterAll(async () => {
  await ctx.close();
});

describe("attention queue", () => {
  it("lists pending approvals by kind with the oldest items", async () => {
    const output = await attention();
    expect(output.counts.approvals).toBe(8);
    expect(output.approvals.total).toBe(8);
    const [message, reply] = output.approvals.by_kind;
    expect(message?.kind).toBe("message");
    expect(message?.count).toBe(7);
    expect(message?.oldest.map((item) => item.title)).toEqual([
      "Email 1",
      "Email 2",
      "Email 3",
      "Email 4",
      "Email 5",
    ]);
    expect(message?.oldest[0]).toMatchObject({
      age_hours: 30,
      target_type: "message",
      target_id: "msg_1",
      created_at: "2026-09-18T06:00:00.000Z",
    });
    expect(reply).toMatchObject({ kind: "reply", count: 1 });
    const longer = await attention({ max_items: 10 });
    expect(longer.approvals.by_kind[0]?.oldest).toHaveLength(7);
  });

  it("lists hot replies waiting over 2 hours without an answer, oldest first", async () => {
    const output = await attention();
    expect(output.hot_replies.total).toBe(2);
    expect(output.hot_replies.items.map((item) => item.thread_id)).toEqual([ids.drafted, ids.hot]);
    const [drafted, hot] = output.hot_replies.items;
    expect(drafted).toMatchObject({
      channel: "linkedin",
      category: "meeting_request",
      waiting_hours: 4,
      draft_status: "pending_review",
      untrusted: true,
    });
    expect(hot).toMatchObject({
      person_name: "Dana Reyes",
      company_name: "Harbor Supply",
      category: "interested",
      waiting_hours: 3,
      draft_status: null,
      received_at: "2026-09-19T09:00:00.000Z",
    });
    expect(hot?.summary?.startsWith("Sounds good, send times.")).toBe(true);
    expect(hot?.summary?.length).toBe(280);
    expect(hot?.summary?.endsWith("...")).toBe(true);
  });

  it("lists open knowledge gaps, oldest first", async () => {
    const output = await attention();
    expect(output.knowledge_gaps.total).toBe(2);
    expect(output.knowledge_gaps.items.map((item) => item.question)).toEqual([
      "Do you integrate with our ERP?",
      "Is there a free trial?",
    ]);
    expect(output.knowledge_gaps.items[1]).toMatchObject({ thread_id: ids.hot, untrusted: true });
  });

  it("warns about senders, bounces, providers and budgets, critical first", async () => {
    const output = await attention();
    const codes = output.warnings.map((item) => [item.code, item.severity, item.target_id]);
    expect(codes).toEqual([
      ["mailbox_error", "critical", ids.failing],
      ["bounce_spike", "critical", ids.noisy],
      ["linkedin_restricted", "critical", ids.restricted],
      ["data_budget", "critical", ctx.workspace.id],
      ["mailbox_paused", "warning", expect.any(String)],
      ["bounce_spike", "warning", ids.active],
      ["provider_missing", "warning", "linkedin"],
      ["provider_missing", "warning", "email_finder:hunter"],
      ["provider_missing", "warning", "signals:crunchbase"],
      ["ai_budget", "warning", ctx.workspace.id],
    ]);
    expect(output.counts.warnings).toBe(10);
    const byCode = (code: string) => output.warnings.find((item) => item.code === code);
    expect(byCode("mailbox_error")?.message).toBe(
      "Mailbox err@harbor.example.org has an error: SMTP auth failed.",
    );
    expect(byCode("mailbox_error")?.hint).toContain(
      `manage_mailboxes (action test, mailbox_id ${ids.failing})`,
    );
    expect(byCode("bounce_spike")?.message).toBe(
      "noisy@harbor.example.org bounced 1 of 25 emails (4%) in the last 7 days.",
    );
    expect(byCode("ai_budget")?.message).toBe(
      "AI spend is at 85% of the monthly budget ($8.50 of $10.00).",
    );
    expect(byCode("data_budget")?.hint).toBe(
      "Data spend is blocked until next month. If more spend is intended, ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update).",
    );
    expect(byCode("ai_budget")?.hint).toBe(
      "Watch AI spend (get_report type costs), or ask the human to raise settings.ai.monthly_budget_usd (openoutbound workspaces update).",
    );
    expect(output.warnings.some((item) => item.target_id === "signals:news_gdelt")).toBe(false);
    expect(output.warnings.some((item) => item.target_id === "brain")).toBe(false);
  });

  it("warns first when the workspace is paused", async () => {
    const paused = ctx.with({ workspace: { ...ctx.workspace, status: "paused" } });
    const output = await attention({}, paused);
    expect(output.workspace.status).toBe("paused");
    expect(output.warnings[0]?.code).toBe("workspace_paused");
    expect(output.next_step).toContain("manage_workspaces (action resume)");
  });

  it("shows the setup checklist", async () => {
    const output = await attention();
    expect(output.setup.items.map((item) => [item.key, item.done])).toEqual([
      ["company", false],
      ["brain", true],
      ["knowledge", true],
      ["offer", false],
      ["icp", true],
      ["senders", true],
      ["leads", true],
      ["campaign", true],
      ["postal_address", false],
    ]);
    expect(output.setup).toMatchObject({ complete: false, done: 6, total: 9 });
    expect(output.counts.setup_remaining).toBe(3);
  });

  it("suggests up to three next steps from the data", async () => {
    const output = await attention();
    expect(output.suggestions.map((item) => item.code)).toEqual([
      "fresh_signal_leads_not_enrolled",
      "campaign_out_of_leads",
      "tier_a_not_contacted",
    ]);
    expect(output.suggestions[0]?.message).toBe(
      "2 leads with fresh funding_round signals are not in any campaign.",
    );
    expect(output.suggestions[1]?.hint).toContain(`enroll_leads (campaign_id ${ids.dry})`);
    expect(output.suggestions[2]?.message).toContain("tier A");
  });

  it("starts with the most urgent next step", async () => {
    const output = await attention();
    expect(output.next_step).toContain("Mailbox err@harbor.example.org has an error");
  });

  it("rejects max_items out of range", () => {
    expect(getAttention.input.safeParse({ max_items: 0 }).success).toBe(false);
    expect(getAttention.input.safeParse({ max_items: 21 }).success).toBe(false);
  });
});

describe("next step priority", () => {
  const empty: Omit<AttentionOutput, "next_step"> = {
    workspace: { id: "ws_1", name: "Demo", status: "active" },
    generated_at: new Date(NOW),
    counts: {
      approvals: 0,
      hot_replies: 0,
      knowledge_gaps: 0,
      warnings: 0,
      setup_remaining: 0,
      problems: 0,
      tasks_due: 0,
    },
    problems: { total: 0, by_severity: { urgent: 0, high: 0, normal: 0, low: 0 }, items: [] },
    approvals: { total: 0, by_kind: [] },
    hot_replies: { total: 0, items: [] },
    tasks_due: { total: 0, items: [] },
    knowledge_gaps: { total: 0, items: [] },
    warnings: [],
    setup: { complete: true, done: 8, total: 8, items: [] },
    suggestions: [],
  };
  const hot = {
    thread_id: "thr_1",
    person_id: null,
    person_name: "Dana Reyes",
    company_name: null,
    channel: "email" as const,
    category: "interested",
    received_at: new Date(NOW),
    waiting_hours: 3,
    draft_status: null,
    summary: null,
    untrusted: true as const,
  };
  const approvalsQueue = {
    total: 2,
    by_kind: [
      {
        kind: "message" as const,
        count: 2,
        oldest: [
          {
            id: "apr_1",
            title: "Email to Dana",
            created_at: new Date(NOW),
            age_hours: 1,
            target_type: null,
            target_id: null,
          },
        ],
      },
    ],
  };
  const gaps = {
    total: 1,
    items: [
      {
        id: "gap_1",
        question: "Trial?",
        thread_id: null,
        created_at: new Date(NOW),
        untrusted: true as const,
      },
    ],
  };
  const soft = {
    code: "mailbox_paused",
    severity: "warning" as const,
    message: "Mailbox a@example.org is paused.",
    hint: "Resume it.",
    target_type: null,
    target_id: null,
  };

  it("names the oldest pending approval of every kind, not of the biggest kind", () => {
    const item = (id: string, title: string, hours: number) => ({
      id,
      title,
      created_at: new Date(new Date(NOW).getTime() - hours * 3_600_000),
      age_hours: hours,
      target_type: null,
      target_id: null,
    });
    const queue = {
      total: 3,
      by_kind: [
        {
          kind: "message" as const,
          count: 2,
          oldest: [item("apr_2", "Email to Dana", 2), item("apr_3", "Email to Omar", 1)],
        },
        {
          kind: "campaign_launch" as const,
          count: 1,
          oldest: [item("apr_1", "Launch Q4 outreach", 30)],
        },
      ],
    };
    expect(nextStep({ ...empty, approvals: queue })).toBe(
      "Review 3 pending approvals with review_items (oldest: Launch Q4 outreach).",
    );
  });

  it("goes hot replies, approvals, gaps, warnings, setup, suggestions", () => {
    expect(
      nextStep({ ...empty, hot_replies: { total: 1, items: [hot] }, approvals: approvalsQueue }),
    ).toBe(
      "Answer Dana Reyes's interested reply (waiting 3h) with reply_to_thread (thread_id thr_1).",
    );
    expect(nextStep({ ...empty, approvals: approvalsQueue, knowledge_gaps: gaps })).toBe(
      "Review 2 pending approvals with review_items (oldest: Email to Dana).",
    );
    expect(nextStep({ ...empty, knowledge_gaps: gaps, warnings: [soft] })).toContain(
      "Answer 1 open prospect question with manage_knowledge",
    );
    expect(nextStep({ ...empty, warnings: [soft] })).toBe(
      "Mailbox a@example.org is paused. Resume it.",
    );
    expect(
      nextStep({
        ...empty,
        setup: {
          complete: false,
          done: 0,
          total: 1,
          items: [{ key: "offer", label: "An offer", done: false, count: 0, hint: "Add one." }],
        },
      }),
    ).toBe("Next setup step, an offer: Add one.");
    expect(
      nextStep({
        ...empty,
        suggestions: [{ code: "all_clear", message: "All good.", hint: "Rest." }],
      }),
    ).toBe("All good. Rest.");
    expect(nextStep(empty)).toBe("Nothing needs attention.");
  });

  const problem = (severity: "urgent" | "high" | "normal" | "low", title: string) => ({
    total: 1,
    by_severity: { urgent: 0, high: 0, normal: 0, low: 0, [severity]: 1 },
    items: [
      {
        id: "pb_1",
        kind: "stuck" as const,
        severity,
        display_severity:
          severity === "urgent" || severity === "high"
            ? ("critical" as const)
            : severity === "normal"
              ? ("warning" as const)
              : ("info" as const),
        owner: "anyone" as const,
        title,
        reason: "Why.",
        remedy: "Do the remedy with reply_to_thread action draft.",
        due_at: null,
        person_id: null,
      },
    ],
  });
  const critical = { ...soft, code: "mailbox_error", severity: "critical" as const };
  const task = {
    total: 2,
    items: [
      {
        id: "tk_1",
        type: "promise" as const,
        title: "Send the case study",
        person_id: null,
        person_name: "Dana Reyes",
        campaign_id: null,
        due_at: new Date(NOW),
        overdue_hours: 5.4,
      },
    ],
  };

  it("puts urgent and high problems first, then critical warnings and hot replies", () => {
    const urgent = nextStep({
      ...empty,
      problems: problem("urgent", "Privacy request from Dana Reyes."),
      warnings: [critical],
      hot_replies: { total: 1, items: [hot] },
    });
    expect(urgent).toBe(
      "Privacy request from Dana Reyes. Do the remedy with reply_to_thread action draft. Then close it with resolve_exception action resolve (problem_id pb_1).",
    );
    expect(
      nextStep({ ...empty, problems: problem("high", "Hot reply waits"), warnings: [critical] }),
    ).toContain("Hot reply waits. Do the remedy");
    expect(nextStep({ ...empty, problems: problem("normal", "Stuck"), warnings: [critical] })).toBe(
      "Mailbox a@example.org is paused. Resume it.",
    );
  });

  it("settles a send_unknown problem with resolve_unknown, never resolve_exception", () => {
    const queue = problem("high", "Check whether an email went out");
    const [item] = queue.items;
    if (!item) throw new Error("missing problem");
    const step = nextStep({
      ...empty,
      problems: {
        ...queue,
        items: [
          {
            ...item,
            kind: "send_unknown" as const,
            remedy:
              "Look in the Sent folder, then use manage_messages action resolve_unknown with outcome sent or resend (message_id msg_1).",
          },
        ],
      },
    });
    expect(step).toBe(
      "Check whether an email went out. Look in the Sent folder, then use manage_messages action resolve_unknown with outcome sent or resend (message_id msg_1). Settling the message closes the problem.",
    );
    expect(step).not.toContain("resolve_exception");
  });

  it("closes a deletion request with forget, and puts the closing words before a suggested reply", () => {
    const queue = problem("urgent", "Privacy request from Dana Reyes: delete their data");
    const [item] = queue.items;
    if (!item) throw new Error("missing problem");
    const privacy = (remedy: string) =>
      nextStep({
        ...empty,
        problems: { ...queue, items: [{ ...item, kind: "privacy_request" as const, remedy }] },
      });
    const deletion = privacy(
      "Reply to them yourself (suggested text below), then run manage_leads action forget with person_id pe_1, first with dry_run true; the forget resolves this problem.\n\nSuggested reply: Hi Dana, understood.",
    );
    expect(deletion).toBe(
      "Privacy request from Dana Reyes: delete their data. Reply to them yourself (suggested text below), then run manage_leads action forget with person_id pe_1, first with dry_run true; the forget resolves this problem.\n\nSuggested reply: Hi Dana, understood.",
    );
    expect(deletion).not.toContain("resolve_exception");
    expect(
      privacy(
        "Reply with where their details came from (suggested text below).\n\nSuggested reply: Hi Dana, we found it on your website.",
      ),
    ).toBe(
      "Privacy request from Dana Reyes: delete their data. Reply with where their details came from (suggested text below). Then close it with resolve_exception action resolve (problem_id pb_1).\n\nSuggested reply: Hi Dana, we found it on your website.",
    );
  });

  it("puts normal problems after approvals, then tasks due, then gaps", () => {
    expect(
      nextStep({ ...empty, problems: problem("normal", "Stuck"), approvals: approvalsQueue }),
    ).toContain("Review 2 pending approvals");
    expect(
      nextStep({
        ...empty,
        problems: problem("normal", "No next step for Dana Reyes"),
        tasks_due: task,
      }),
    ).toContain("No next step for Dana Reyes. Do the remedy");
    expect(nextStep({ ...empty, tasks_due: task, knowledge_gaps: gaps })).toBe(
      '2 tasks are due. Start with "Send the case study" for Dana Reyes (due 5h ago), then mark it done with manage_tasks action complete (task_id tk_1).',
    );
  });

  it("puts low problems after warnings and before setup", () => {
    expect(nextStep({ ...empty, problems: problem("low", "Minor"), warnings: [soft] })).toBe(
      "Mailbox a@example.org is paused. Resume it.",
    );
    expect(
      nextStep({
        ...empty,
        problems: problem("low", "Minor"),
        setup: {
          complete: false,
          done: 0,
          total: 1,
          items: [{ key: "offer", label: "An offer", done: false, count: 0, hint: "Add one." }],
        },
      }),
    ).toContain("Minor. Do the remedy");
  });
});

describe("problems and tasks due sections", () => {
  it("lists open problems in the service order and tasks due, with counts", async () => {
    const own = await createTestContext({ db: ctx.testDb, now: NOW });
    const ws = own.workspace.id;
    const open = (severity: "urgent" | "high" | "normal" | "low", title: string, due?: Date) =>
      openProblem(own, {
        kind: severity === "urgent" ? "privacy_request" : "stuck",
        severity,
        title,
        reason: `${title} (reason).`,
        remedy: "Do the remedy.",
        ...(due ? { dueAt: due } : {}),
      });
    const low = await open("low", "Low one");
    for (let i = 0; i < 20; i += 1) await open("normal", `Normal ${i + 1}`);
    const high = await open("high", "High one");
    const urgent = await open("urgent", "Privacy request from Dana Reyes", ago(-24 * 29));
    const snoozed = await open("high", "Snoozed until tomorrow");
    await snoozeProblem(own, snoozed.id, ago(-24));
    const resolved = await open("urgent", "Already handled");
    await resolveProblem(own, resolved.id, { resolution: "Done." });
    await own.db.insert(problems).values({
      workspace_id: ws,
      kind: "stuck",
      severity: "high",
      status: "snoozed",
      snoozed_until: ago(1),
      owner: "anyone",
      title: "Snooze ended",
      reason: "Back.",
      remedy: "Look again.",
    });

    const due = (title: string, at: Date, status: "open" | "done" = "open") => ({
      workspace_id: ws,
      type: "follow_up" as const,
      title,
      due_at: at,
      status,
    });
    await own.db
      .insert(tasks)
      .values([
        ...Array.from({ length: 11 }, (_, i) => due(`Overdue ${i + 1}`, ago(20 - i))),
        due("Due now", ago(0)),
        due("Later today", ago(-2)),
        due("Done already", ago(30), "done"),
      ]);

    const output = await attention({}, own);
    expect(output.counts).toMatchObject({ problems: 24, tasks_due: 12 });
    expect(output.problems.total).toBe(24);
    expect(output.problems.by_severity).toEqual({ urgent: 1, high: 2, normal: 20, low: 1 });
    expect(output.problems.items).toHaveLength(20);
    expect(output.problems.items.slice(0, 3).map((item) => item.title)).toEqual([
      "Privacy request from Dana Reyes",
      "High one",
      "Snooze ended",
    ]);
    expect(output.problems.items[0]).toMatchObject({
      id: urgent.id,
      kind: "privacy_request",
      severity: "urgent",
      display_severity: "critical",
      due_at: ago(-24 * 29).toISOString(),
    });
    expect(output.problems.items[1]).toMatchObject({ id: high.id, display_severity: "critical" });
    expect(output.problems.items[3]?.display_severity).toBe("warning");
    const listed = output.problems.items.map((item) => item.id);
    expect(listed).not.toContain(low.id);
    expect(listed).not.toContain(snoozed.id);
    expect(listed).not.toContain(resolved.id);

    expect(output.tasks_due.total).toBe(12);
    expect(output.tasks_due.items).toHaveLength(10);
    expect(output.tasks_due.items[0]).toMatchObject({
      title: "Overdue 1",
      type: "follow_up",
      overdue_hours: 20,
    });
    expect(output.next_step).toBe(
      `Privacy request from Dana Reyes. Do the remedy. Then close it with resolve_exception action resolve (problem_id ${urgent.id}).`,
    );

    // The existing sections are untouched by problems and tasks of another workspace.
    const main = await attention();
    expect(main.counts).toMatchObject({ problems: 0, tasks_due: 0 });
    expect(main.problems.items).toEqual([]);
  });
});

describe("hot replies a person owns or a meeting answered", () => {
  it("leaves them out of the queue, its next step and the operating state", async () => {
    const other = await createTestContext({ now: NOW });
    const reply = async (options: { owner?: "engine" | "person"; name: string }) => {
      const person = await seedPerson(other, { full_name: options.name });
      const thread = await seedThread(other, {
        person_id: person.id,
        owner: options.owner ?? "engine",
        last_inbound_at: ago(3),
      });
      await seedMessage(other, {
        thread_id: thread.id,
        person_id: person.id,
        direction: "inbound",
        status: "received",
        action: "reply",
        received_at: ago(3),
        created_at: ago(3),
        classification: { category: "interested", confidence: 0.9 } as NewMessage["classification"],
      });
      return { person, thread };
    };
    const open = await reply({ name: "Dana Reyes" });
    await reply({ name: "Omar Haddad", owner: "person" });
    const booked = await reply({ name: "Mei Chen" });
    const cancelled = await reply({ name: "Ines Moreau" });
    // Meetings recorded after the replies: Mei's answers her reply, Ines's was cancelled.
    await other.db.insert(meetings).values([
      {
        workspace_id: other.workspace.id,
        person_id: booked.person.id,
        source: "manual",
        matched_by: "manual",
        start_at: ago(-48),
      },
      {
        workspace_id: other.workspace.id,
        person_id: cancelled.person.id,
        source: "manual",
        matched_by: "manual",
        status: "cancelled",
        start_at: ago(-48),
      },
    ]);

    const output = await attention({}, other);
    expect(output.hot_replies.total).toBe(2);
    expect(output.hot_replies.items.map((item) => item.person_name).sort()).toEqual([
      "Dana Reyes",
      "Ines Moreau",
    ]);
    expect(output.next_step).not.toContain("Omar Haddad");
    expect(output.next_step).not.toContain("Mei Chen");
    const state = getOperatingState.output.parse(
      await getOperatingState.handler(other, getOperatingState.input.parse({})),
    );
    expect(state.replies.hot_waiting).toBe(2);
    expect(open.thread.owner).toBe("engine");
    await other.close();
  });
});
