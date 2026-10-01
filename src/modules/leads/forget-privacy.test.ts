/**
 * What `forget` does for privacy requests on top of the v0.1 erasure: lead-file facts deleted,
 * the address and profile URL redacted in stored copies (in this workspace only), meetings
 * unlinked, the person's problems resolved with their name erased, and `lead.forgotten` with
 * CRM ids and a hash only.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import { queryRows } from "../../db/client.js";
import {
  agent_tasks,
  approvals,
  audit_events,
  crm_links,
  events,
  jobs,
  lead_facts,
  meetings,
  opportunities,
  people,
  problems,
  suppressions,
  webhook_deliveries,
  webhook_endpoints,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedCompany, seedMessage, seedPerson, seedThread } from "../../testing/factories.js";
import { handleForgottenLead } from "../inbox/crm-forget.js";
import { buildPrivacyProblem } from "../inbox/privacy-requests.js";
import { openProblem } from "../problems/service.js";
import { forgetLeadOp } from "./operations/forget.js";
import {
  emailPattern,
  linkedinPattern,
  redactionPattern,
  redactionTerms,
  redactJson,
} from "./redaction.js";
import { hashSuppressionValue } from "./suppressions.js";

// biome-ignore lint/suspicious/noExplicitAny: results are checked with expect
type Any = any;

const EMAIL = "dana@harbor-dental.example.com";
const LINKEDIN = "https://www.linkedin.com/in/dana-reyes-example";
const SOURCE = { line: "Apollo, a business contact database, on 3 Sep 2026", quotable: true };

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<Any> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

async function dana(ctx: TestContext) {
  const company = await seedCompany(ctx, { name: "Harbor Dental" });
  return seedPerson(ctx, {
    company_id: company.id,
    first_name: "Dana",
    last_name: "Reyes",
    full_name: "Dana Reyes",
    email: EMAIL,
    linkedin_url: LINKEDIN,
  });
}

async function event(ctx: TestContext, data: Record<string, unknown>) {
  const [row] = await ctx.db
    .insert(events)
    .values({ workspace_id: ctx.workspace.id, type: "reply.received", data })
    .returning();
  if (!row) throw new Error("event insert failed");
  return row;
}

async function audit(ctx: TestContext, input: Record<string, unknown>, reason: string | null) {
  const [row] = await ctx.db
    .insert(audit_events)
    .values({
      workspace_id: ctx.workspace.id,
      actor_type: "agent",
      actor_id: "key_test",
      actor_name: "Test agent",
      via: "mcp",
      operation: "leads.update",
      effect: "write",
      status: "ok",
      reason,
      summary: "Update a lead",
      input,
    })
    .returning();
  if (!row) throw new Error("audit insert failed");
  return row;
}

describe("redaction patterns", () => {
  async function replace(text: string, pattern: string | null): Promise<string> {
    const [row] = await queryRows<{ out: string }>(
      testDb.db,
      sql`select regexp_replace(${text}, ${pattern}, '[erased]', 'gi') as out`,
    );
    return row?.out ?? "";
  }

  it("matches the whole address in any case, never part of a longer one", async () => {
    const pattern = emailPattern(EMAIL);
    expect(await replace("From Dana@Harbor-Dental.example.com today", pattern)).toBe(
      "From [erased] today",
    );
    expect(await replace(`Write to <${EMAIL}>. Or mailto:${EMAIL}?x=1`, pattern)).toBe(
      "Write to <[erased]>. Or mailto:[erased]?x=1",
    );
    expect(await replace(`mandana@harbor-dental.example.com, ${EMAIL}.au`, pattern)).toBe(
      `mandana@harbor-dental.example.com, ${EMAIL}.au`,
    );
    const plus = emailPattern("dana+news@harbor-dental.example.com");
    expect(await replace("dana+news@harbor-dental.example.com", plus)).toBe("[erased]");
    expect(await replace("danaanews@harbor-dental.example.com", plus)).toBe(
      "danaanews@harbor-dental.example.com",
    );
  });

  it("matches the profile URL in its common forms, never a longer slug", async () => {
    const pattern = linkedinPattern(LINKEDIN);
    expect(await replace(LINKEDIN, pattern)).toBe("[erased]");
    expect(await replace("see linkedin.com/in/dana-reyes-example/ and", pattern)).toBe(
      "see [erased]/ and",
    );
    expect(await replace("http://de.linkedin.com/in/Dana-Reyes-Example?trk=a", pattern)).toBe(
      "[erased]?trk=a",
    );
    expect(await replace(`${LINKEDIN}-2`, pattern)).toBe(`${LINKEDIN}-2`);
    expect(linkedinPattern("https://www.linkedin.com/company/harbor")).toBeNull();
    expect(redactionPattern({ emails: [], linkedinUrls: [] })).toBeNull();
  });

  it("starts a match only after a character that cannot be part of an address or host", async () => {
    const both = redactionPattern({ emails: [EMAIL], linkedinUrls: [LINKEDIN] });
    expect(await replace("notlinkedin.com/in/dana-reyes-example", both)).toBe(
      "notlinkedin.com/in/dana-reyes-example",
    );
    expect(await replace(`Profile:\nlinkedin.com/in/dana-reyes-example\n${EMAIL}`, both)).toBe(
      "Profile:\n[erased]\n[erased]",
    );
    expect(await replace(`(${EMAIL}) "${LINKEDIN}"`, both)).toBe('([erased]) "[erased]"');
  });

  it("redacts every string of a JSON value, keys too, and leaves other values alone", () => {
    const regex = new RegExp(
      redactionPattern({ emails: [EMAIL], linkedinUrls: [LINKEDIN] }) ?? "",
      "gi",
    );
    const value = {
      note: `Reply below:\n${EMAIL} wrote`,
      [EMAIL]: { cc: ["sam@harbor-dental.example.com", "Dana@Harbor-Dental.example.com"] },
      profile: "Profile:\nwww.linkedin.com/in/dana-reyes-example",
      count: 2,
      empty: null,
    };
    expect(redactJson(value, regex)).toEqual({
      note: "Reply below:\n[erased] wrote",
      "[erased]": { cc: ["sam@harbor-dental.example.com", "[erased]"] },
      profile: "Profile:\n[erased]",
      count: 2,
      empty: null,
    });
    const untouched = { note: "mandana@harbor-dental.example.com", list: [1, "two"] };
    expect(redactJson(untouched, regex)).toBe(untouched);
    expect(
      redactionTerms({
        emails: [EMAIL],
        linkedinUrls: ["https://www.linkedin.com/in/jos%C3%A9-diaz"],
      }),
    ).toEqual([EMAIL, "jos%c3%a9-diaz", "josé-diaz"]);
  });
});

describe("leads.forget for privacy requests", () => {
  it("deletes the person's lead-file facts and the facts taken from their replies", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await dana(ctx);
    const other = await seedPerson(ctx, { email: "sam@harbor-dental.example.com" });
    const reply = await seedMessage(ctx, {
      person_id: person.id,
      direction: "inbound",
      status: "received",
    });
    const base = {
      workspace_id: ctx.workspace.id,
      kind: "fact" as const,
      observed_at: ctx.clock.now(),
    };
    await ctx.db.insert(lead_facts).values([
      {
        ...base,
        person_id: person.id,
        scope: "person",
        kind: "note",
        text: "Prefers mornings",
        source: "manual",
      },
      {
        ...base,
        person_id: person.id,
        company_id: person.company_id,
        scope: "company",
        text: "Switching software in March",
        source: "reply",
        source_ref: reply.id,
      },
      {
        ...base,
        person_id: person.id,
        company_id: person.company_id,
        scope: "company",
        text: "Two locations",
        source: "manual",
      },
      {
        ...base,
        person_id: other.id,
        scope: "person",
        text: "Runs the front desk",
        source: "manual",
      },
    ]);

    const result = await call(forgetLeadOp, ctx, { person_id: person.id });
    expect(result.facts_deleted).toBe(2);
    const left = await ctx.db
      .select({ text: lead_facts.text, person_id: lead_facts.person_id })
      .from(lead_facts)
      .where(eq(lead_facts.workspace_id, ctx.workspace.id))
      .orderBy(lead_facts.text);
    expect(left).toEqual([
      { text: "Runs the front desk", person_id: other.id },
      { text: "Two locations", person_id: null },
    ]);
  });

  it("redacts the address and profile URL in stored copies of this workspace only", async () => {
    const ctx = await createTestContext({ db: testDb });
    const neighbour = await createTestContext({ db: testDb });
    const person = await dana(ctx);

    const mentioned = await event(ctx, {
      from: "Dana@Harbor-Dental.example.com",
      note: `Reply from ${EMAIL}.`,
    });
    const profile = await event(ctx, { linkedin: "linkedin.com/in/dana-reyes-example/" });
    const lookalike = await event(ctx, { from: "mandana@harbor-dental.example.com" });
    const elsewhere = await event(neighbour, { from: EMAIL });
    const auditRow = await audit(
      ctx,
      { email: EMAIL, full_name: "Dana Reyes" },
      `Asked by ${EMAIL}`,
    );
    const auditElsewhere = await audit(neighbour, { email: EMAIL }, null);
    const [endpoint] = await ctx.db
      .insert(webhook_endpoints)
      .values({ workspace_id: ctx.workspace.id, url: "https://hooks.example.com/oo" })
      .returning();
    const [delivery] = await ctx.db
      .insert(webhook_deliveries)
      .values({
        endpoint_id: endpoint?.id ?? "",
        event_id: mentioned.id,
        status: "failed",
        last_error: `422: contact ${EMAIL} already exists`,
      })
      .returning();
    const opened = await openProblem(ctx, {
      kind: "custom",
      severity: "normal",
      title: "Check a booking",
      reason: `A booking came in from ${EMAIL} and ${LINKEDIN}.`,
      remedy: "Look at it.",
      data: { attendee: EMAIL },
    });
    const theirs = await openProblem(neighbour, {
      kind: "custom",
      severity: "normal",
      title: "Check a booking",
      reason: `A booking came in from ${EMAIL}.`,
      remedy: "Look at it.",
    });
    const [done, queued] = await ctx.db
      .insert(jobs)
      .values([
        {
          workspace_id: ctx.workspace.id,
          name: "inbox.crm_sync",
          payload: { email: EMAIL },
          status: "succeeded",
        },
        {
          workspace_id: ctx.workspace.id,
          name: "inbox.crm_sync",
          payload: { email: EMAIL },
          status: "queued",
        },
      ])
      .returning();
    const [decided, pending] = await ctx.db
      .insert(approvals)
      .values([
        {
          workspace_id: ctx.workspace.id,
          kind: "custom",
          status: "approved",
          title: `Reply to ${EMAIL}`,
          payload: { to: EMAIL },
        },
        {
          workspace_id: ctx.workspace.id,
          kind: "custom",
          status: "pending",
          title: "Contact Sam",
          payload: { referred_by: EMAIL },
        },
      ])
      .returning();
    const [finishedTask, openTask] = await ctx.db
      .insert(agent_tasks)
      .values([
        {
          workspace_id: ctx.workspace.id,
          kind: "brain",
          task_key: `task-done-${ctx.workspace.id}`,
          status: "done",
          instructions: `Write to ${EMAIL} about the demo.`,
          input: { to: EMAIL },
          output: { draft: `Hi Dana (${EMAIL})` },
        },
        {
          workspace_id: ctx.workspace.id,
          kind: "brain",
          task_key: `task-open-${ctx.workspace.id}`,
          status: "open",
          instructions: `Write to ${EMAIL}.`,
        },
      ])
      .returning();

    const result = await call(forgetLeadOp, ctx, { person_id: person.id });
    expect(result.redacted).toEqual({
      events: 2,
      audit_entries: 1,
      webhook_deliveries: 1,
      problems: 1,
      jobs: 1,
      approvals: 1,
      agent_tasks: 1,
    });

    const eventData = async (id: string) =>
      (await ctx.db.select().from(events).where(eq(events.id, id)))[0]?.data;
    expect(await eventData(mentioned.id)).toEqual({
      from: "[erased]",
      note: "Reply from [erased].",
    });
    expect(await eventData(profile.id)).toEqual({ linkedin: "[erased]/" });
    expect(await eventData(lookalike.id)).toEqual({ from: "mandana@harbor-dental.example.com" });
    expect(await eventData(elsewhere.id)).toEqual({ from: EMAIL });

    const [auditAfter] = await ctx.db
      .select()
      .from(audit_events)
      .where(eq(audit_events.id, auditRow.id));
    expect(auditAfter).toMatchObject({
      input: { email: "[erased]", full_name: "Dana Reyes" },
      reason: "Asked by [erased]",
    });
    const [auditOther] = await ctx.db
      .select()
      .from(audit_events)
      .where(eq(audit_events.id, auditElsewhere.id));
    expect(auditOther?.input).toEqual({ email: EMAIL });

    const [deliveryAfter] = await ctx.db
      .select()
      .from(webhook_deliveries)
      .where(eq(webhook_deliveries.id, delivery?.id ?? ""));
    expect(deliveryAfter?.last_error).toBe("422: contact [erased] already exists");

    const [problemAfter] = await ctx.db.select().from(problems).where(eq(problems.id, opened.id));
    expect(problemAfter).toMatchObject({
      reason: "A booking came in from [erased] and [erased].",
      data: { attendee: "[erased]" },
      status: "open",
    });
    const [problemOther] = await ctx.db.select().from(problems).where(eq(problems.id, theirs.id));
    expect(problemOther?.reason).toContain(EMAIL);

    const jobPayload = async (id: string | undefined) =>
      (
        await ctx.db
          .select()
          .from(jobs)
          .where(eq(jobs.id, id ?? ""))
      )[0]?.payload;
    expect(await jobPayload(done?.id)).toEqual({ email: "[erased]" });
    expect(await jobPayload(queued?.id)).toEqual({ email: EMAIL });

    const approval = async (id: string | undefined) =>
      (
        await ctx.db
          .select()
          .from(approvals)
          .where(eq(approvals.id, id ?? ""))
      )[0];
    expect(await approval(decided?.id)).toMatchObject({
      title: "Reply to [erased]",
      payload: { to: "[erased]" },
    });
    expect((await approval(pending?.id))?.payload).toEqual({ referred_by: EMAIL });

    const task = async (id: string | undefined) =>
      (
        await ctx.db
          .select()
          .from(agent_tasks)
          .where(eq(agent_tasks.id, id ?? ""))
      )[0];
    expect(await task(finishedTask?.id)).toMatchObject({
      instructions: "Write to [erased] about the demo.",
      input: { to: "[erased]" },
      output: { draft: "Hi Dana ([erased])" },
    });
    expect((await task(openTask?.id))?.instructions).toBe(`Write to ${EMAIL}.`);
  });

  it("redacts an address at the start of a line in JSON and never breaks the JSON", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await dana(ctx);
    const lineStart = await event(ctx, { note: `Reply below:\n${EMAIL} wrote:` });
    const profileLine = await event(ctx, {
      note: "Profile:\nwww.linkedin.com/in/dana-reyes-example",
    });
    const keyed = await event(ctx, { [EMAIL]: { cc: [EMAIL, "sam@harbor-dental.example.com"] } });
    const quoted = await event(ctx, { quote: `She wrote "${EMAIL}"\tand left` });
    const lookalike = await event(ctx, { note: "Write to\nmandana@harbor-dental.example.com" });
    const auditRow = await audit(ctx, { body: `Hi,\n${EMAIL}` }, `Asked by\n${EMAIL}`);

    const result = await call(forgetLeadOp, ctx, { person_id: person.id });
    expect(result.redacted).toMatchObject({ events: 4, audit_entries: 1 });
    const data = async (id: string) =>
      (await ctx.db.select().from(events).where(eq(events.id, id)))[0]?.data;
    expect(await data(lineStart.id)).toEqual({ note: "Reply below:\n[erased] wrote:" });
    expect(await data(profileLine.id)).toEqual({ note: "Profile:\n[erased]" });
    expect(await data(keyed.id)).toEqual({
      "[erased]": { cc: ["[erased]", "sam@harbor-dental.example.com"] },
    });
    expect(await data(quoted.id)).toEqual({ quote: 'She wrote "[erased]"\tand left' });
    expect(await data(lookalike.id)).toEqual({
      note: "Write to\nmandana@harbor-dental.example.com",
    });
    const [auditAfter] = await ctx.db
      .select()
      .from(audit_events)
      .where(eq(audit_events.id, auditRow.id));
    expect(auditAfter).toMatchObject({
      input: { body: "Hi,\n[erased]" },
      reason: "Asked by\n[erased]",
    });
  });

  it("counts in a dry run what the real run redacts, approvals it cancels included", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await dana(ctx);
    const [theirs, unrelated] = await ctx.db
      .insert(approvals)
      .values([
        {
          workspace_id: ctx.workspace.id,
          kind: "custom",
          status: "pending",
          title: `Contact ${EMAIL}`,
          target_type: "person",
          target_id: person.id,
        },
        {
          workspace_id: ctx.workspace.id,
          kind: "custom",
          status: "pending",
          title: `Referred by ${EMAIL}`,
          target_type: "person",
          target_id: "pe_someone_else",
        },
      ])
      .returning();
    await event(ctx, { note: `Line one\n${EMAIL}` });

    const preview = await call(forgetLeadOp, ctx.with({ request: { dryRun: true } }), {
      person_id: person.id,
    });
    const result = await call(forgetLeadOp, ctx, { person_id: person.id });
    expect(preview.preview.redacted).toEqual(result.redacted);
    expect(result.redacted).toMatchObject({ approvals: 1, events: 1 });
    const approval = async (id: string | undefined) =>
      (
        await ctx.db
          .select()
          .from(approvals)
          .where(eq(approvals.id, id ?? ""))
      )[0];
    expect(await approval(theirs?.id)).toMatchObject({
      status: "cancelled",
      title: "Contact [erased]",
    });
    expect(await approval(unrelated?.id)).toMatchObject({
      status: "pending",
      title: `Referred by ${EMAIL}`,
    });
  });

  it("changes nothing when a step fails, so it can simply run again", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await dana(ctx);
    await ctx.db.insert(suppressions).values({
      workspace_id: ctx.workspace.id,
      type: "email",
      value: EMAIL,
      reason: "unsubscribed",
    });
    await ctx.db.insert(lead_facts).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      scope: "person",
      kind: "note",
      text: "Prefers mornings",
      source: "manual",
      observed_at: ctx.clock.now(),
    });
    const problem = await openProblem(ctx, {
      kind: "custom",
      severity: "normal",
      title: "Call Dana Reyes back",
      reason: `Reach her at ${EMAIL}.`,
      remedy: "Call her.",
      personId: person.id,
    });
    const mentioned = await event(ctx, { from: EMAIL });
    // The last step (deleting the person) fails.
    await ctx.db.execute(
      sql.raw(
        `create function oo_test_refuse_delete() returns trigger language plpgsql as $$ begin if old.id = '${person.id}' then raise exception 'refused'; end if; return old; end $$`,
      ),
    );
    await ctx.db.execute(
      sql`create trigger oo_test_refuse_delete before delete on people for each row execute function oo_test_refuse_delete()`,
    );
    try {
      await expect(call(forgetLeadOp, ctx, { person_id: person.id })).rejects.toThrow();
    } finally {
      await ctx.db.execute(sql`drop trigger oo_test_refuse_delete on people`);
      await ctx.db.execute(sql`drop function oo_test_refuse_delete()`);
    }

    const blocks = await ctx.db
      .select({ type: suppressions.type, value: suppressions.value })
      .from(suppressions)
      .where(eq(suppressions.workspace_id, ctx.workspace.id));
    expect(blocks).toEqual([{ type: "email", value: EMAIL }]);
    expect(await ctx.db.select().from(people).where(eq(people.id, person.id))).toHaveLength(1);
    expect(
      await ctx.db.select().from(lead_facts).where(eq(lead_facts.person_id, person.id)),
    ).toHaveLength(1);
    const [problemAfter] = await ctx.db.select().from(problems).where(eq(problems.id, problem.id));
    expect(problemAfter).toMatchObject({ status: "open", reason: `Reach her at ${EMAIL}.` });
    const [eventAfter] = await ctx.db.select().from(events).where(eq(events.id, mentioned.id));
    expect(eventAfter?.data).toEqual({ from: EMAIL });

    const again = await call(forgetLeadOp, ctx, { person_id: person.id });
    expect(again).toMatchObject({ person_deleted: true, facts_deleted: 1, problems_resolved: 1 });
    expect(await ctx.db.select().from(people).where(eq(people.id, person.id))).toHaveLength(0);
  });

  it("unlinks meetings, resolves the person's problems and erases their name in them", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await dana(ctx);
    const other = await seedPerson(ctx, { email: "sam@harbor-dental.example.com" });
    const thread = await seedThread(ctx, { person_id: person.id });
    const [meeting, otherMeeting] = await ctx.db
      .insert(meetings)
      .values([
        {
          workspace_id: ctx.workspace.id,
          person_id: person.id,
          thread_id: thread.id,
          source: "manual",
          matched_by: "manual",
          notes: "Dana wants to talk pricing",
        },
        {
          workspace_id: ctx.workspace.id,
          person_id: other.id,
          source: "manual",
          matched_by: "manual",
          notes: "Sam joins",
        },
      ])
      .returning();
    const privacy = await openProblem(
      ctx,
      buildPrivacyProblem({
        kind: "delete",
        personId: person.id,
        companyId: person.company_id,
        name: "Dana Reyes",
        label: "Dana Reyes (Harbor Dental)",
        firstName: "Dana",
        address: null,
        messageId: "msg_privacy_1",
        threadId: thread.id,
        receivedAt: ctx.clock.now(),
        responseDays: 30,
        timeZone: "UTC",
        source: SOURCE,
      }),
    );
    const followUp = await openProblem(ctx, {
      kind: "custom",
      severity: "normal",
      title: "Call Dana Reyes back",
      reason: "She asked for a call.",
      remedy: "Call her.",
      personId: person.id,
    });
    const unrelated = await openProblem(ctx, {
      kind: "custom",
      severity: "normal",
      title: "Call Sam back",
      reason: "He asked for a call.",
      remedy: "Call him.",
      personId: other.id,
    });

    const result = await call(forgetLeadOp, ctx, { person_id: person.id });
    expect(result).toMatchObject({
      meetings_unlinked: 1,
      problems_resolved: 2,
      person_deleted: true,
    });
    expect(result.redacted.problems).toBe(2);

    const [unlinked] = await ctx.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, meeting?.id ?? ""));
    expect(unlinked).toMatchObject({ person_id: null, notes: null, thread_id: thread.id });
    const [kept] = await ctx.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, otherMeeting?.id ?? ""));
    expect(kept).toMatchObject({ person_id: other.id, notes: "Sam joins" });

    const [privacyAfter] = await ctx.db.select().from(problems).where(eq(problems.id, privacy.id));
    expect(privacyAfter).toMatchObject({
      status: "resolved",
      resolution: "forgotten",
      title: "Privacy request from [erased] (Harbor Dental): delete their data",
    });
    expect(privacyAfter?.reason).toMatch(/^\[erased\] asked to delete their data on /);
    expect(privacyAfter?.remedy).toContain("Suggested reply: Hi [erased], understood.");
    expect(privacyAfter?.data.suggested_reply).toBe(
      "Hi [erased], understood. I am deleting your details now and you will not hear from us again.",
    );
    expect(JSON.stringify(privacyAfter)).not.toContain("Dana");
    const [followUpAfter] = await ctx.db
      .select()
      .from(problems)
      .where(eq(problems.id, followUp.id));
    expect(followUpAfter).toMatchObject({
      status: "resolved",
      resolution: "forgotten",
      title: "Call [erased] back",
    });
    const [unrelatedAfter] = await ctx.db
      .select()
      .from(problems)
      .where(eq(problems.id, unrelated.id));
    expect(unrelatedAfter).toMatchObject({ status: "open", title: "Call Sam back" });
    expect(ctx.emitted("problem.resolved").map((e) => e.data)).toEqual(
      expect.arrayContaining([
        { problem_id: privacy.id, kind: "privacy_request", resolution: "forgotten" },
        { problem_id: followUp.id, kind: "custom", resolution: "forgotten" },
      ]),
    );
  });

  it("emits lead.forgotten with the CRM ids and a hash of the email, nothing readable", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await dana(ctx);
    await ctx.db.insert(crm_links).values([
      {
        workspace_id: ctx.workspace.id,
        provider: "pipedrive",
        entity_type: "person",
        entity_id: person.id,
        external_id: "812",
      },
      {
        workspace_id: ctx.workspace.id,
        provider: "hubspot",
        entity_type: "person",
        entity_id: person.id,
        external_id: "51201",
      },
      {
        workspace_id: ctx.workspace.id,
        provider: "hubspot",
        entity_type: "company",
        entity_id: person.company_id ?? "",
        external_id: "9001",
      },
    ]);

    const result = await call(forgetLeadOp, ctx, { person_id: person.id });
    const crm = [
      { provider: "hubspot", entity_type: "person", external_id: "51201" },
      { provider: "pipedrive", entity_type: "person", external_id: "812" },
    ];
    expect(result.crm_links).toEqual(crm);
    const emitted = ctx.emitted("lead.forgotten");
    expect(emitted).toEqual([
      {
        id: expect.any(String),
        subject: { type: "person", id: person.id },
        data: {
          person_id: person.id,
          email_sha256: createHash("sha256").update(EMAIL).digest("hex"),
          crm_links: crm,
        },
      },
    ]);
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain("dana");
    expect(serialized).not.toContain("linkedin");
    // The company link stays; the person's links are gone.
    const links = await ctx.db
      .select({ entity_type: crm_links.entity_type })
      .from(crm_links)
      .where(eq(crm_links.workspace_id, ctx.workspace.id));
    expect(links).toEqual([{ entity_type: "company" }]);
  });

  it("carries the deals of the person's opportunities, so the CRM step asks to check them", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await dana(ctx);
    const other = await seedPerson(ctx, {
      full_name: "Sam Ortiz",
      email: "sam@lakeside.example.org",
    });
    const [theirs, notTheirs] = await ctx.db
      .insert(opportunities)
      .values([
        { workspace_id: ctx.workspace.id, person_id: person.id, stage: "meeting_booked" },
        { workspace_id: ctx.workspace.id, person_id: other.id, stage: "interested" },
      ])
      .returning();
    await ctx.db.insert(crm_links).values([
      {
        workspace_id: ctx.workspace.id,
        provider: "hubspot",
        entity_type: "person",
        entity_id: person.id,
        external_id: "51201",
      },
      {
        workspace_id: ctx.workspace.id,
        provider: "hubspot",
        entity_type: "opportunity",
        entity_id: theirs?.id ?? "",
        external_id: "7301",
      },
      {
        workspace_id: ctx.workspace.id,
        provider: "hubspot",
        entity_type: "opportunity",
        entity_id: notTheirs?.id ?? "",
        external_id: "7302",
      },
    ]);

    const result = await call(forgetLeadOp, ctx, { person_id: person.id });
    const crm = [
      { provider: "hubspot", entity_type: "person", external_id: "51201" },
      { provider: "hubspot", entity_type: "opportunity", external_id: "7301" },
    ];
    expect(result.crm_links).toEqual(crm);
    const [emitted] = ctx.emitted("lead.forgotten");
    expect(emitted?.data.crm_links).toEqual(crm);

    // The CRM step (crm.on_forget task, the default) turns the event into one task per record.
    expect(await handleForgottenLead(ctx, (emitted as Any).data)).toEqual({ tasks: 2, deletes: 0 });
    const tasks = await ctx.db
      .select()
      .from(problems)
      .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, "crm_forget")));
    expect(tasks.map((row) => row.title).sort()).toEqual([
      "Check a deal in HubSpot for a forgotten person",
      "Delete a forgotten contact in HubSpot",
    ]);
    expect(
      tasks.find((row) => row.dedupe_key === "crm_forget:hubspot:opportunity:7301"),
    ).toBeTruthy();
    // The deal itself stays linked: only the person left it.
    const dealLinks = await ctx.db
      .select({ external_id: crm_links.external_id })
      .from(crm_links)
      .where(
        and(eq(crm_links.workspace_id, ctx.workspace.id), eq(crm_links.entity_type, "opportunity")),
      );
    expect(dealLinks.map((row) => row.external_id).sort()).toEqual(["7301", "7302"]);
  });

  it("dry run counts facts, meetings, problems and redactions and changes nothing", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await dana(ctx);
    await ctx.db.insert(lead_facts).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      scope: "person",
      kind: "note",
      text: "Prefers mornings",
      source: "manual",
      observed_at: ctx.clock.now(),
    });
    await ctx.db.insert(meetings).values({
      workspace_id: ctx.workspace.id,
      person_id: person.id,
      source: "manual",
      matched_by: "manual",
    });
    const mentioned = await event(ctx, { from: EMAIL });
    await audit(ctx, { email: EMAIL }, null);
    await openProblem(ctx, {
      kind: "custom",
      severity: "normal",
      title: "Call Dana Reyes back",
      reason: `Reach her at ${EMAIL}.`,
      remedy: "Call her.",
      personId: person.id,
    });

    const result = await call(forgetLeadOp, ctx.with({ request: { dryRun: true } }), {
      person_id: person.id,
    });
    expect(result.dry_run).toBe(true);
    expect(result.preview).toMatchObject({
      person_deleted: false,
      facts_deleted: 1,
      meetings_unlinked: 1,
      problems_resolved: 1,
      redacted: { events: 1, audit_entries: 1, problems: 1, jobs: 0, approvals: 0 },
      crm_links: [],
    });
    expect(ctx.emitted("lead.forgotten")).toEqual([]);
    const [still] = await ctx.db.select().from(events).where(eq(events.id, mentioned.id));
    expect(still?.data).toEqual({ from: EMAIL });
    const facts = await ctx.db
      .select()
      .from(lead_facts)
      .where(eq(lead_facts.workspace_id, ctx.workspace.id));
    expect(facts).toHaveLength(1);
    const open = await ctx.db
      .select()
      .from(problems)
      .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.status, "open")));
    expect(open).toHaveLength(1);
  });

  it("forgets an address with no record: hashed block, redaction, request resolved, event", async () => {
    const ctx = await createTestContext({ db: testDb });
    const address = "lee@northwind-clinic.example.org";
    const request = await openProblem(
      ctx,
      buildPrivacyProblem({
        kind: "delete",
        personId: null,
        companyId: null,
        name: address,
        label: address,
        firstName: null,
        address,
        messageId: "msg_privacy_2",
        threadId: null,
        receivedAt: ctx.clock.now(),
        responseDays: 30,
        timeZone: "UTC",
        source: { line: "we could not find the source; check your records", quotable: false },
      }),
    );
    const mentioned = await event(ctx, { from: address });

    const result = await call(forgetLeadOp, ctx, { email: "Lee@Northwind-Clinic.example.org" });
    expect(result).toMatchObject({
      person_id: null,
      person_deleted: false,
      hashed_suppressions: 1,
      facts_deleted: 0,
      problems_resolved: 1,
      crm_links: [],
    });
    expect(result.redacted).toMatchObject({ events: 1, problems: 1 });
    const blocks = await ctx.db
      .select({ value: suppressions.value, reason: suppressions.reason })
      .from(suppressions)
      .where(eq(suppressions.workspace_id, ctx.workspace.id));
    expect(blocks).toEqual([{ value: hashSuppressionValue(address), reason: "gdpr_erasure" }]);
    const [requestAfter] = await ctx.db.select().from(problems).where(eq(problems.id, request.id));
    expect(requestAfter).toMatchObject({
      status: "resolved",
      resolution: "forgotten",
      title: "Privacy request from [erased]: delete their data",
    });
    expect(JSON.stringify(requestAfter)).not.toContain("lee@");
    const [eventAfter] = await ctx.db.select().from(events).where(eq(events.id, mentioned.id));
    expect(eventAfter?.data).toEqual({ from: "[erased]" });
    expect(
      ctx.emitted("lead.forgotten").map((e) => ({ subject: e.subject, data: e.data })),
    ).toEqual([
      {
        subject: null,
        data: {
          person_id: null,
          email_sha256: createHash("sha256").update(address).digest("hex"),
          crm_links: [],
        },
      },
    ]);
  });

  it("keeps only hashed blocks: the person block a privacy request added goes too", async () => {
    const ctx = await createTestContext({ db: testDb });
    const person = await dana(ctx);
    const other = await seedPerson(ctx, { email: "sam@harbor-dental.example.com" });
    const block = {
      workspace_id: ctx.workspace.id,
      reason: "do_not_contact" as const,
      source: "reply",
      note: "Privacy request (reply msg_01k6a3v0q8x3m2n4p5r6s7t8v9)",
    };
    await ctx.db.insert(suppressions).values([
      { ...block, type: "email", value: EMAIL },
      { ...block, type: "linkedin", value: LINKEDIN },
      { ...block, type: "person", value: person.id },
      { ...block, type: "person", value: other.id },
    ]);

    await call(forgetLeadOp, ctx, { person_id: person.id });
    const left = await ctx.db
      .select({ type: suppressions.type, value: suppressions.value })
      .from(suppressions)
      .where(eq(suppressions.workspace_id, ctx.workspace.id))
      .orderBy(suppressions.type, suppressions.value);
    expect(left).toEqual([
      { type: "email", value: hashSuppressionValue(EMAIL) },
      { type: "linkedin", value: hashSuppressionValue(LINKEDIN) },
      { type: "person", value: other.id },
    ]);
  });

  it("never lets the audit log keep the address or profile it was asked to forget", () => {
    expect(
      forgetLeadOp.auditInput?.({ email: EMAIL, linkedin_url: LINKEDIN, person_id: "pe_1" }),
    ).toEqual({ email: "[erased]", linkedin_url: "[erased]", person_id: "pe_1" });
    expect(forgetLeadOp.auditInput?.({ person_id: "pe_1" })).toEqual({ person_id: "pe_1" });
  });

  it("scrubs the address and profile from the reason and error message of its audit entry", () => {
    const text = (value: string, input: Record<string, unknown>) =>
      forgetLeadOp.auditText?.(value, input);
    expect(
      text("Asked by Dana@Harbor-Dental.example.com (linkedin.com/in/dana-reyes-example/)", {
        email: EMAIL,
      }),
    ).toBe("Asked by [erased] ([erased])");
    expect(
      text('validation_failed: "Dana at harbor-dental" is not a valid email.', {
        email: "Dana at harbor-dental",
      }),
    ).toBe('validation_failed: "[erased]" is not a valid email.');
    // A forget by person_id names nobody in its input: any address in the reason is theirs.
    expect(
      text("Privacy request from lee@northwind-clinic.example.org, see ticket 12", {
        person_id: "pe_1",
      }),
    ).toBe("Privacy request from [erased], see ticket 12");
    expect(text("Erase a person for a privacy request (GDPR)", { person_id: "pe_1" })).toBe(
      "Erase a person for a privacy request (GDPR)",
    );
  });
});
