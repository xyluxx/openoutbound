import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ActorRef } from "../../core/context.js";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import {
  approvals,
  enrollments,
  type Mailbox,
  messages,
  type NewMessage,
  type Person,
  problems,
} from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import {
  seedCampaign,
  seedEnrollment,
  seedLinkedInAccount,
  seedMailbox,
  seedMessage,
  seedPerson,
} from "../../testing/factories.js";
import { messageResolver } from "../campaigns/approvals.js";
import { module as campaigns } from "../campaigns/index.js";
import { tools as campaignTools } from "../campaigns/tools.js";
import { sendJobKey } from "./queue.js";
import { resolveUnknownOperation } from "./unknown-operations.js";
import { openEmailUnknownProblem } from "./unknown-sends.js";

vi.mock("../leads/service.js", async () => (await import("./test-support.js")).fakeLeadsService);
vi.mock("../../runtime/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/notify.js")>()),
  notify: vi.fn(async () => {}),
}));

const NOW = new Date("2026-09-21T16:00:00Z");
const DISPATCHED = new Date("2026-09-21T15:55:00Z");

let ctx: TestContext;
let mailbox: Mailbox;
let dana: Person;

async function run<I extends AnyZodObject, O extends z.ZodType>(
  op: OperationDefinition<I, O>,
  input: z.input<I>,
  context: TestContext = ctx,
): Promise<z.output<O>> {
  return op.output.parse(await op.handler(context, op.input.parse(input)));
}

const resolve = (
  input: z.input<typeof resolveUnknownOperation.input>,
  context: TestContext = ctx,
) => run(resolveUnknownOperation, input, context);

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as { code?: string; message?: string; hint?: string },
  );
  if (!error) throw new Error("expected a failure");
  return error;
}

async function unknownEmail(over: Partial<NewMessage> = {}) {
  const message = await seedMessage(ctx, {
    person_id: dana.id,
    mailbox_id: mailbox.id,
    to_address: dana.email,
    status: "unknown",
    subject: "Checking in",
    body_text: "Hi Dana, a short note.",
    message_id_header: "<unknown-1@brand.example.com>",
    dispatch_started_at: DISPATCHED,
    reconcile_checks: 3,
    ...over,
  });
  await openEmailUnknownProblem(ctx, message, mailbox.email, "the connection dropped");
  return message;
}

async function reload(id: string) {
  const [row] = await ctx.db.select().from(messages).where(eq(messages.id, id));
  if (!row) throw new Error("message gone");
  return row;
}

async function problemOf(messageId: string) {
  const rows = await ctx.db
    .select()
    .from(problems)
    .where(eq(problems.dedupe_key, `send_unknown:${messageId}`));
  return rows[0];
}

beforeEach(async () => {
  ctx = await createTestContext({ now: NOW });
  mailbox = await seedMailbox(ctx, { email: "sam@brand.example.com" });
  dana = await seedPerson(ctx, { email: "dana@harbor.example.com" });
});
afterEach(async () => {
  await ctx.close();
});

describe("messages.resolve_unknown", () => {
  it("is the resolve_unknown action of manage_messages", () => {
    const manageMessages = campaignTools.find((tool) => tool.name === "manage_messages");
    expect(manageMessages?.actions).toMatchObject({ resolve_unknown: "messages.resolve_unknown" });
    expect(campaigns.operations?.map((op) => op.id)).toContain("messages.resolve_unknown");
  });

  it("sent: records the email as sent when it was dispatched and resolves the problem", async () => {
    const message = await unknownEmail();
    const result = await resolve({
      message_id: message.id,
      outcome: "sent",
      note: "Found it in the Sent folder",
    });
    expect(result).toEqual({
      message_id: message.id,
      channel: "email",
      outcome: "sent",
      status: "sent",
      changed: true,
    });
    const row = await reload(message.id);
    expect(row.status).toBe("sent");
    expect(row.sent_at?.toISOString()).toBe(DISPATCHED.toISOString());
    expect(ctx.emitted("message.sent")[0]?.data).toMatchObject({ message_id: message.id });
    const problem = await problemOf(message.id);
    expect(problem?.status).toBe("resolved");
    expect(problem?.resolution).toContain("Found it in the Sent folder");
    // Safe to repeat.
    expect(await resolve({ message_id: message.id, outcome: "sent" })).toMatchObject({
      status: "sent",
      changed: false,
    });
  });

  it("resend: queues it again with the same Message-ID and resolves the problem", async () => {
    const message = await unknownEmail();
    expect(await resolve({ message_id: message.id, outcome: "resend" })).toMatchObject({
      status: "scheduled",
      changed: true,
    });
    const row = await reload(message.id);
    expect(row).toMatchObject({
      status: "scheduled",
      reconcile_checks: 0,
      message_id_header: "<unknown-1@brand.example.com>",
    });
    expect(row.why?.resent_after_unknown).toBe(NOW.toISOString());
    expect(ctx.enqueued("email.send")).toEqual([
      expect.objectContaining({
        payload: { message_id: message.id },
        options: expect.objectContaining({ singletonKey: sendJobKey(message.id) }),
      }),
    ]);
    expect((await problemOf(message.id))?.status).toBe("resolved");
    // Not unknown any more: a second resend is refused.
    const error = await failure(resolve({ message_id: message.id, outcome: "resend" }));
    expect(error.code).toBe("conflict");
    expect(ctx.enqueued("email.send")).toHaveLength(1);
  });

  it("resend needs the send scope; the other outcomes do not", async () => {
    const message = await unknownEmail();
    const writer = ctx.with({ principal: { scopes: ["read", "write"] } });
    const error = await failure(resolve({ message_id: message.id, outcome: "resend" }, writer));
    expect(error).toMatchObject({ code: "forbidden" });
    expect((await reload(message.id)).status).toBe("unknown");
    expect(await resolve({ message_id: message.id, outcome: "cancel" }, writer)).toMatchObject({
      status: "cancelled",
    });
  });

  it("cancel: drops it, resolves the problem and wakes the sequence", async () => {
    const { campaign } = await seedCampaign(ctx);
    const enrollment = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: dana.id,
      next_run_at: new Date("2026-09-21T17:00:00Z"),
    });
    const message = await unknownEmail({
      campaign_id: campaign.id,
      enrollment_id: enrollment.id,
    });
    expect(await resolve({ message_id: message.id, outcome: "cancel" })).toMatchObject({
      status: "cancelled",
      changed: true,
    });
    const row = await reload(message.id);
    expect(row.status).toBe("cancelled");
    expect(row.error).toContain("not sent again");
    expect((await problemOf(message.id))?.status).toBe("resolved");
    const [woken] = await ctx.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, enrollment.id));
    expect(woken?.next_run_at?.toISOString()).toBe(NOW.toISOString());
    expect(ctx.emitted("message.sent")).toHaveLength(0);
    expect(await resolve({ message_id: message.id, outcome: "cancel" })).toMatchObject({
      changed: false,
    });
  });

  it("previews with dry_run and changes nothing", async () => {
    const message = await unknownEmail({ why: { resent_after_unknown: "2026-09-20T10:00:00Z" } });
    const result = await resolve(
      { message_id: message.id, outcome: "resend" },
      ctx.with({ request: { dryRun: true } }),
    );
    expect(result).toMatchObject({
      dry_run: true,
      preview: {
        message_id: message.id,
        channel: "email",
        to: "dana@harbor.example.com",
        subject: "Checking in",
        outcome: "resend",
      },
    });
    if (!("dry_run" in result)) throw new Error("expected a preview");
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("gets this message twice");
    expect((await reload(message.id)).status).toBe("unknown");
    expect(ctx.enqueued()).toHaveLength(0);
    expect((await problemOf(message.id))?.status).toBe("open");
  });

  it("refuses messages that are not unknown, not the engine's or not in the workspace", async () => {
    const scheduled = await seedMessage(ctx, { status: "scheduled", mailbox_id: mailbox.id });
    const conflict = await failure(resolve({ message_id: scheduled.id, outcome: "sent" }));
    expect(conflict.code).toBe("conflict");
    expect(conflict.message).toContain("is scheduled, not unknown");
    expect(conflict.hint).toContain("manage_messages action list");

    const external = await seedMessage(ctx, { status: "sent", origin: "external" });
    expect((await failure(resolve({ message_id: external.id, outcome: "sent" }))).code).toBe(
      "unsupported",
    );

    const other = await createTestContext({ db: ctx.testDb, now: NOW });
    const foreign = await seedMessage(other, { status: "unknown" });
    expect((await failure(resolve({ message_id: foreign.id, outcome: "cancel" }))).code).toBe(
      "not_found",
    );
    expect((await reload(foreign.id)).status).toBe("unknown");
  });

  it("settles LinkedIn actions too", async () => {
    const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
    const person = await seedPerson(ctx, {
      full_name: "Dana Reyes",
      linkedin_url: "https://www.linkedin.com/in/dana-reyes-example",
    });
    const linkedin = (action: "comment" | "invite") =>
      seedMessage(ctx, {
        channel: "linkedin",
        action,
        status: "unknown",
        subject: null,
        body_text: action === "comment" ? "Great post" : "",
        in_reply_to: action === "comment" ? "post_1" : null,
        linkedin_account_id: account.id,
        person_id: person.id,
        dispatch_started_at: DISPATCHED,
      });
    const comment = await linkedin("comment");
    expect(await resolve({ message_id: comment.id, outcome: "sent" })).toMatchObject({
      channel: "linkedin",
      status: "sent",
    });
    expect((await reload(comment.id)).status).toBe("sent");

    const invite = await linkedin("invite");
    await resolve({ message_id: invite.id, outcome: "resend" });
    expect((await reload(invite.id)).status).toBe("scheduled");
    expect(ctx.enqueued("linkedin.action").at(-1)?.options).toMatchObject({
      singletonKey: `linkedin.action:${invite.id}`,
    });
  });
});

describe("messages.resolve_unknown resend asks a person", () => {
  const person: ActorRef = { type: "human", id: "usr_owner", name: "Owner" };
  /** An agent key with its default scopes: it must ask for approvals. */
  const agent = () =>
    ctx.with({
      principal: {
        type: "agent",
        id: "key_resend_agent",
        name: "Resend agent",
        scopes: ["read", "write", "send", "spend"],
      },
    });

  async function approvalsFor(messageId: string) {
    return ctx.db.select().from(approvals).where(eq(approvals.target_id, messageId));
  }

  it("an agent's resend waits for a person: the message stays unknown and nothing is queued", async () => {
    const message = await unknownEmail();
    const answer = await resolve({ message_id: message.id, outcome: "resend" }, agent());
    expect(answer).toMatchObject({ status: "awaiting_approval" });
    if (!("approval_id" in answer)) throw new Error("expected an approval");
    expect(answer.summary).toContain("person");
    const [approval] = await approvalsFor(message.id);
    expect(approval).toMatchObject({
      id: answer.approval_id,
      kind: "message",
      status: "pending",
      target_type: "message",
      target_id: message.id,
      payload: { message_id: message.id, action: "resend", attempt: message.attempt },
      requested_by: { type: "agent", id: "key_resend_agent" },
    });
    expect(approval?.summary).toContain("dana@harbor.example.com");
    expect((await reload(message.id)).status).toBe("unknown");
    expect(ctx.enqueued("email.send")).toHaveLength(0);
    expect((await problemOf(message.id))?.status).toBe("open");
  });

  it("an agent's dry run says the resend will wait for a person", async () => {
    const message = await unknownEmail();
    const preview = await resolve(
      { message_id: message.id, outcome: "resend" },
      agent().with({ request: { dryRun: true } }),
    );
    if (!("dry_run" in preview)) throw new Error("expected a preview");
    expect(preview.warnings.join(" ")).toContain("approval");
    expect(await approvalsFor(message.id)).toHaveLength(0);
  });

  it("a person approving the request queues it once; rejecting leaves it unknown", async () => {
    const message = await unknownEmail();
    const asked = await resolve({ message_id: message.id, outcome: "resend" }, agent());
    if (!("approval_id" in asked)) throw new Error("expected an approval");
    const [approval] = await approvalsFor(message.id);
    if (!approval) throw new Error("no approval");

    const rejected = await messageResolver.apply(ctx, approval, {
      decision: "reject",
      decidedBy: person,
    });
    expect(rejected.message).toContain("stays unknown");
    expect((await reload(message.id)).status).toBe("unknown");
    expect(ctx.enqueued("email.send")).toHaveLength(0);

    const approved = await messageResolver.apply(ctx, approval, {
      decision: "approve",
      decidedBy: person,
    });
    expect(approved).toMatchObject({
      target: { type: "message", id: message.id },
      data: { status: "scheduled" },
    });
    const row = await reload(message.id);
    expect(row).toMatchObject({
      status: "scheduled",
      message_id_header: "<unknown-1@brand.example.com>",
    });
    expect(row.error).toContain("Owner");
    expect(ctx.enqueued("email.send")).toEqual([
      expect.objectContaining({
        payload: { message_id: message.id },
        options: expect.objectContaining({ singletonKey: sendJobKey(message.id) }),
      }),
    ]);
    const problem = await problemOf(message.id);
    expect(problem?.status).toBe("resolved");
    expect(problem?.resolution).toContain("Resend agent");

    // Deciding it again changes nothing: the message is no longer unknown.
    const repeat = await messageResolver.apply(ctx, approval, {
      decision: "approve",
      decidedBy: person,
    });
    expect(repeat.message).toContain("nothing to apply");
    expect(ctx.enqueued("email.send")).toHaveLength(1);
  });

  it("applies only to the attempt it was asked for, and takes no text edits", async () => {
    const message = await unknownEmail();
    await resolve({ message_id: message.id, outcome: "resend" }, agent());
    const [approval] = await approvalsFor(message.id);
    if (!approval) throw new Error("no approval");
    await expect(
      messageResolver.apply(ctx, approval, {
        decision: "edit",
        edits: { body: "Different text" },
        decidedBy: person,
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });

    // A newer attempt of the same message became unknown meanwhile: the old request is stale.
    await ctx.db
      .update(messages)
      .set({ attempt: message.attempt + 1 })
      .where(eq(messages.id, message.id));
    const stale = await messageResolver.apply(ctx, approval, {
      decision: "approve",
      decidedBy: person,
    });
    expect(stale.message).toContain("nothing to apply");
    expect((await reload(message.id)).status).toBe("unknown");
    expect(ctx.enqueued("email.send")).toHaveLength(0);
  });

  it("settling it as sent or cancelled closes a pending resend request", async () => {
    const message = await unknownEmail();
    await resolve({ message_id: message.id, outcome: "resend" }, agent());
    expect(await resolve({ message_id: message.id, outcome: "cancel" }, agent())).toMatchObject({
      status: "cancelled",
    });
    const [approval] = await approvalsFor(message.id);
    expect(approval?.status).toBe("cancelled");
  });

  it("a person holding approve resends directly", async () => {
    const message = await unknownEmail();
    expect(await resolve({ message_id: message.id, outcome: "resend" })).toMatchObject({
      status: "scheduled",
    });
    expect(await approvalsFor(message.id)).toHaveLength(0);
    expect(ctx.enqueued("email.send")).toHaveLength(1);
  });

  it("asks for LinkedIn actions too", async () => {
    const account = await seedLinkedInAccount(ctx, { provider: "unipile" });
    const invite = await seedMessage(ctx, {
      channel: "linkedin",
      action: "invite",
      status: "unknown",
      subject: null,
      body_text: "",
      linkedin_account_id: account.id,
      person_id: dana.id,
      dispatch_started_at: DISPATCHED,
    });
    expect(await resolve({ message_id: invite.id, outcome: "resend" }, agent())).toMatchObject({
      status: "awaiting_approval",
    });
    expect((await reload(invite.id)).status).toBe("unknown");
    expect(ctx.enqueued("linkedin.action")).toHaveLength(0);
    const [approval] = await approvalsFor(invite.id);
    if (!approval) throw new Error("no approval");
    await messageResolver.apply(ctx, approval, { decision: "approve", decidedBy: person });
    expect((await reload(invite.id)).status).toBe("scheduled");
    expect(ctx.enqueued("linkedin.action")).toHaveLength(1);
  });
});
