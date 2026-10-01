/**
 * Replies to people nobody may contact: opted out, suppressed (email, domain, person or
 * company), marked do not contact, or erased. Uses the real leads contactability check.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuppressionType } from "../../core/enums.js";
import type { OpenOutboundError } from "../../core/errors.js";
import type { AnyOperation } from "../../core/operation.js";
import { approvals, companies, messages, people, suppressions } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedCompany,
  seedLinkedInAccount,
  seedMailbox,
  seedMessage,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { queueEmailSend } from "../email/service.js";
import { forgetLead } from "../leads/forget.js";
import { planLinkedInAction, queueLinkedInAction } from "../linkedin/service.js";
import { replyResolver } from "./reply-approval.js";
import { scheduleReplySend } from "./send.js";
import { draftThreadReply, sendThreadReply } from "./thread-operations.js";

vi.mock("../knowledge/service.js", () => ({
  searchKnowledge: vi.fn(async () => []),
  openKnowledgeGap: vi.fn(async () => ({ id: "gap_test" })),
  buildGroundingPack: vi.fn(async () => ({
    company: { name: "Helix Outbound", website: "https://helix.example.org" },
    offer: null,
    rules: [],
    facts: [],
    voiceSamples: [],
    text: "Forecasting pilot for dental groups.",
  })),
}));
vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("../email/service.js", () => ({
  planEmailSend: vi.fn(async (_ctx: unknown, input: { mailboxIds: string[]; notBefore: Date }) => ({
    ok: true,
    mailboxId: input.mailboxIds[0],
    sendAt: input.notBefore,
  })),
  queueEmailSend: vi.fn(async () => {}),
}));
vi.mock("../linkedin/service.js", () => ({
  planLinkedInAction: vi.fn(async () => ({ ok: false, reason: "no_active_account" })),
  queueLinkedInAction: vi.fn(async () => {}),
}));

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(() => {
  vi.clearAllMocks();
});

// biome-ignore lint/suspicious/noExplicitAny: outputs differ per operation
type AnyOutput = any;

async function run(
  op: AnyOperation,
  ctx: TestContext,
  input: Record<string, unknown>,
): Promise<AnyOutput> {
  return op.handler(ctx, op.input.parse(input));
}

async function refusal(promise: Promise<unknown>): Promise<OpenOutboundError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as OpenOutboundError,
  );
  if (!error) throw new Error("expected the reply to be refused");
  return error;
}

const agentOf = (ctx: TestContext) =>
  ctx.with({ principal: { type: "agent", id: "key_agent", name: "Agent" } });

async function setup() {
  const ctx = await createTestContext({ db: testDb, now: "2026-09-22T15:00:00.000Z" });
  const n = Math.round(Math.random() * 1e9);
  const company = await seedCompany(ctx, {
    name: "Harbor Dental",
    domain: `harbor-${n}.example.com`,
  });
  const person = await seedPerson(ctx, {
    company_id: company.id,
    full_name: "Dana Reyes",
    email: `dana@harbor-${n}.example.com`,
  });
  const mailbox = await seedMailbox(ctx);
  const at = new Date("2026-09-22T14:00:00.000Z");
  const thread = await seedThread(ctx, {
    person_id: person.id,
    company_id: company.id,
    mailbox_id: mailbox.id,
    subject: "Quick question",
    needs_attention: true,
    last_message_at: at,
    last_inbound_at: at,
  });
  await seedMessage(ctx, {
    thread_id: thread.id,
    person_id: person.id,
    direction: "inbound",
    status: "received",
    action: "reply",
    subject: "Re: Quick question",
    body_text: "Sounds interesting, tell me more.",
    from_address: person.email,
    received_at: at,
    created_at: at,
    classification: { category: "interested", confidence: 0.9, source: "model" },
  });
  return { ctx, company, person, mailbox, thread };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function suppress(s: Setup, type: SuppressionType, value: string) {
  await s.ctx.db
    .insert(suppressions)
    .values({ workspace_id: s.ctx.workspace.id, type, value, reason: "unsubscribed" });
}

async function outboundCount(s: Setup): Promise<number> {
  const rows = await s.ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.thread_id, s.thread.id), eq(messages.direction, "outbound")));
  return rows.length;
}

const BLOCKS: Array<{ name: string; reason: string; block: (s: Setup) => Promise<unknown> }> = [
  {
    name: "unsubscribed",
    reason: "person_unsubscribed",
    block: (s) =>
      s.ctx.db.update(people).set({ status: "unsubscribed" }).where(eq(people.id, s.person.id)),
  },
  {
    name: "email suppressed",
    reason: "suppressed_email",
    block: (s) => suppress(s, "email", s.person.email ?? ""),
  },
  {
    name: "domain suppressed",
    reason: "suppressed_domain",
    block: (s) => suppress(s, "domain", s.company.domain ?? ""),
  },
  {
    name: "person suppressed",
    reason: "suppressed_person",
    block: (s) => suppress(s, "person", s.person.id),
  },
  {
    name: "company suppressed",
    reason: "suppressed_company",
    block: (s) => suppress(s, "company", s.company.id),
  },
  {
    name: "person marked do not contact",
    reason: "person_do_not_contact",
    block: (s) =>
      s.ctx.db.update(people).set({ status: "do_not_contact" }).where(eq(people.id, s.person.id)),
  },
  {
    name: "company marked do not contact",
    reason: "company_do_not_contact",
    block: (s) =>
      s.ctx.db
        .update(companies)
        .set({ status: "do_not_contact" })
        .where(eq(companies.id, s.company.id)),
  },
  {
    name: "erased",
    reason: "person_erased",
    block: (s) => forgetLead(s.ctx, { person: s.person }, true),
  },
];

describe("replies to people nobody may contact", () => {
  it.each(BLOCKS)("refuses a reply when the person is $name", async ({ reason, block }) => {
    const s = await setup();
    await block(s);
    const agent = agentOf(s.ctx);
    const before = await outboundCount(s);

    const refused = await refusal(
      run(sendThreadReply, agent, { thread_id: s.thread.id, text: "Happy to share more." }),
    );
    expect(refused.code).toBe("suppressed");
    expect(refused.details?.reasons).toContain(reason);
    expect(refused.hint).toMatch(
      reason === "person_erased" ? /reply_to_thread/ : /manage_suppressions/,
    );
    // Humans are refused the same way, and drafting is refused too.
    const human = await refusal(
      run(sendThreadReply, s.ctx, { thread_id: s.thread.id, text: "Happy to share more." }),
    );
    expect(human.code).toBe("suppressed");
    expect((await refusal(run(draftThreadReply, agent, { thread_id: s.thread.id }))).code).toBe(
      "suppressed",
    );

    // Nothing was drafted, queued or put up for approval.
    expect(await outboundCount(s)).toBe(before);
    expect(s.ctx.recorded.approvals).toHaveLength(0);
    expect(queueEmailSend).not.toHaveBeenCalled();

    // The dry run shows the same block.
    const preview = await run(sendThreadReply, agent.with({ request: { dryRun: true } }), {
      thread_id: s.thread.id,
      text: "Happy to share more.",
    });
    expect(preview.dry_run).toBe(true);
    expect(preview.preview.blocked_reasons).toContain(reason);
    expect(preview.warnings[0]).toBe(`${refused.message} ${refused.hint}`);
  });

  it("names bad contact data and how to fix it, instead of calling it an opt-out", async () => {
    const s = await setup();
    const agent = agentOf(s.ctx);
    await s.ctx.db
      .update(people)
      .set({ email_status: "invalid" })
      .where(eq(people.id, s.person.id));
    const invalid = await refusal(run(draftThreadReply, agent, { thread_id: s.thread.id }));
    expect(invalid.code).toBe("suppressed");
    expect(invalid.message).toBe(
      "No reply can go out: their email address is marked invalid (invalid_email).",
    );
    expect(invalid.hint).toBe(
      `Check the address and correct it with manage_leads action update (person_id ${s.person.id}), or verify it again with enrich_leads action verify (person_ids ["${s.person.id}"]).`,
    );

    await s.ctx.db.update(people).set({ email: null }).where(eq(people.id, s.person.id));
    const missing = await refusal(
      run(sendThreadReply, agent, { thread_id: s.thread.id, text: "Happy to share more." }),
    );
    expect(missing.message).toBe("No reply can go out: they have no email address (no_email).");
    expect(missing.hint).toContain(
      `Add one with manage_leads action update (person_id ${s.person.id})`,
    );

    // An opt-out is final: fixing their data would not change it, so the hint says so alone.
    await s.ctx.db.update(people).set({ status: "unsubscribed" }).where(eq(people.id, s.person.id));
    const both = await refusal(run(draftThreadReply, agent, { thread_id: s.thread.id }));
    expect(both.message).toContain("this person opted out or may not be contacted");
    expect(both.message).toContain("they have no email address");
    expect(both.hint).toMatch(/^Do not contact them/);
    expect(both.hint).not.toContain("manage_leads");
  });

  it("lets a reply through when nothing blocks it, and the dry run says so", async () => {
    const s = await setup();
    const agent = agentOf(s.ctx);
    const preview = await run(sendThreadReply, agent.with({ request: { dryRun: true } }), {
      thread_id: s.thread.id,
      text: "Happy to share more.",
    });
    expect(preview).toMatchObject({
      preview: { to: s.person.email, blocked_reasons: [], requires_approval: true },
      warnings: [],
    });
    const result = await run(sendThreadReply, agent, {
      thread_id: s.thread.id,
      text: "Happy to share more.",
    });
    expect(result).toMatchObject({ status: "awaiting_approval" });
  });

  it("checks an approved reply again before it goes out", async () => {
    const s = await setup();
    const agent = agentOf(s.ctx);
    const pending = await run(sendThreadReply, agent, {
      thread_id: s.thread.id,
      text: "Happy to share more.",
    });
    expect(pending).toMatchObject({ status: "awaiting_approval" });
    const [approval] = await s.ctx.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, pending.approval_id));
    if (!approval) throw new Error("no approval");

    // The person unsubscribes while the reply waits for a human.
    await suppress(s, "email", s.person.email ?? "");
    await s.ctx.db.update(people).set({ status: "unsubscribed" }).where(eq(people.id, s.person.id));
    const applied = await replyResolver.apply(s.ctx, approval, {
      decision: "approve",
      decidedBy: { type: "human", id: "usr_test", name: "Test User" },
    });
    expect(applied.message).toContain("not sent");
    expect(applied.message).toContain("person_unsubscribed");
    const [message] = await s.ctx.db
      .select()
      .from(messages)
      .where(eq(messages.id, String(approval.target_id)));
    expect(message?.status).toBe("cancelled");
    expect(queueEmailSend).not.toHaveBeenCalled();
  });

  it("never schedules a reply for a person who no longer exists", async () => {
    const s = await setup();
    const account = await seedLinkedInAccount(s.ctx);
    const thread = await seedThread(s.ctx, {
      channel: "linkedin",
      person_id: null,
      linkedin_account_id: account.id,
    });
    const reply = await seedMessage(s.ctx, {
      thread_id: thread.id,
      person_id: null,
      channel: "linkedin",
      action: "message",
      status: "approved",
      subject: null,
      body_text: "Happy to share more.",
      linkedin_account_id: account.id,
    });
    vi.mocked(planLinkedInAction).mockResolvedValueOnce({
      ok: true,
      accountId: account.id,
      runAt: s.ctx.clock.now(),
    });
    const result = await scheduleReplySend(s.ctx, reply.id, { delay: false, respectWindow: false });
    expect(result).toMatchObject({ status: "blocked", reason: "not_contactable:person_erased" });
    expect(queueLinkedInAction).not.toHaveBeenCalled();
  });
});
