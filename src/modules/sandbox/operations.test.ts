import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messages, people } from "../../db/schema/index.js";
import { ingestInboundEmail } from "../../modules/email/service.js";
import { decideEmailOutcome } from "../../sandbox/simulator/decide.js";
import { findPendingEmailCandidates } from "../../sandbox/simulator/email-reply.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { seedMailbox, seedMessage, seedPerson, seedThread } from "../../testing/factories.js";
import { getSandboxStatus, seedSandbox, simulateSandbox } from "./operations.js";

vi.mock("../../modules/email/service.js", () => ({
  ingestInboundEmail: vi.fn(async () => ({
    messageId: "msg_ingested",
    threadId: null,
    kind: "reply" as const,
  })),
}));

const ingestMock = vi.mocked(ingestInboundEmail);

describe("sandbox.seed", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx?.close();
  });

  it("seeds both workspaces and the output parses against the declared schema", async () => {
    ctx = await createTestContext();
    const output = seedSandbox.output.parse(await seedSandbox.handler(ctx, { reset: false }));
    expect(output.workspaces.map((w) => w.slug).sort()).toEqual(["brightsmile", "northwind"]);
    expect(output.workspaces.every((w) => w.counts.people > 0)).toBe(true);
  });

  it("defaults reset to false when omitted", async () => {
    ctx = await createTestContext();
    const parsedInput = seedSandbox.input.parse({});
    expect(parsedInput.reset).toBe(false);
  });
});

describe("sandbox.status", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx?.close();
  });

  it("reports no sandbox workspaces before sandbox.seed has run", async () => {
    ctx = await createTestContext();
    const output = getSandboxStatus.output.parse(await getSandboxStatus.handler(ctx, {}));
    expect(output.workspaces).toEqual([]);
    expect(output.try_first.length).toBeGreaterThan(0);
  });

  it("shows a caller bound to one workspace only that workspace", async () => {
    ctx = await createTestContext();
    const seeded = seedSandbox.output.parse(await seedSandbox.handler(ctx, { reset: false }));
    const northwind = seeded.workspaces.find((row) => row.slug === "northwind");
    const bound = ctx.with({ principal: { type: "agent", workspaceId: northwind?.workspace_id } });
    const own = getSandboxStatus.output.parse(await getSandboxStatus.handler(bound, {}));
    expect(own.workspaces.map((row) => row.slug)).toEqual(["northwind"]);
    const elsewhere = ctx.with({ principal: { type: "agent", workspaceId: ctx.workspace.id } });
    const none = getSandboxStatus.output.parse(await getSandboxStatus.handler(elsewhere, {}));
    expect(none.workspaces).toEqual([]);
  });

  it("reports counts and quick-start prompts after sandbox.seed has run", async () => {
    ctx = await createTestContext();
    await seedSandbox.handler(ctx, { reset: false });
    // An instance-level caller (the test context's principal is bound to its own workspace).
    const instance = ctx.with({ principal: { workspaceId: null } });
    const output = getSandboxStatus.output.parse(await getSandboxStatus.handler(instance, {}));
    expect(output.workspaces).toHaveLength(2);
    for (const workspace of output.workspaces) {
      expect(workspace.counts.companies).toBeGreaterThan(0);
      expect(workspace.quick_start_prompts.length).toBe(3);
      // The seeded demo content includes "sent, no reply yet" emails (see
      // seedSuppressionsAndThreads). Each counts as pending only when the simulator will answer
      // it, which depends on the ids it got.
      const candidates = await findPendingEmailCandidates(ctx, workspace.workspace_id);
      expect(candidates.length).toBeGreaterThan(0);
      const sent = await ctx.db
        .select({ id: messages.id, personId: people.id, emailStatus: people.email_status })
        .from(messages)
        .innerJoin(people, eq(people.id, messages.person_id))
        .where(
          and(eq(messages.workspace_id, workspace.workspace_id), inArray(messages.id, candidates)),
        );
      const answered = sent.filter(
        (row) =>
          decideEmailOutcome({
            personId: row.personId,
            messageId: row.id,
            emailStatus: row.emailStatus,
          }).kind !== "none",
      ).length;
      expect(workspace.pending_simulated_replies).toEqual({
        email_replies: answered,
        linkedin_accepts: 0,
        linkedin_replies: 0,
        meeting_bookings: 0,
        meeting_no_shows: 0,
      });
    }
  });
});

describe("sandbox.simulate", () => {
  let ctx: TestContext;
  afterEach(async () => {
    ingestMock.mockClear();
    await ctx?.close();
  });

  it("refuses to run outside a sandbox workspace", async () => {
    ctx = await createTestContext({ sandbox: false });
    await expect(simulateSandbox.handler(ctx, {})).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("fast-forwards a pending reply and reports it delivered", async () => {
    ctx = await createTestContext({ sandbox: true });
    const personId = "sim_op_pe";
    let messageId = "";
    for (let i = 0; i < 20_000; i++) {
      const candidate = `sim_op_msg_${i}`;
      if (
        decideEmailOutcome({ personId, messageId: candidate, emailStatus: "valid" }).kind ===
        "reply"
      ) {
        messageId = candidate;
        break;
      }
    }
    expect(messageId).not.toBe("");

    const thread = await seedThread(ctx);
    const mailbox = await seedMailbox(ctx);
    const person = await seedPerson(ctx, { id: personId, email_status: "valid" });
    await seedMessage(ctx, {
      id: messageId,
      thread_id: thread.id,
      mailbox_id: mailbox.id,
      person_id: person.id,
      status: "sent",
    });

    const output = simulateSandbox.output.parse(await simulateSandbox.handler(ctx, {}));
    expect(output.pending_before.email_replies).toBe(1);
    expect(output.delivered.email_replies).toBe(1);
    expect(ingestMock).toHaveBeenCalledTimes(1);
    // What the sandbox sent so far (to the simulator), for "what would have been sent".
    expect(output.workspace).toBe(ctx.workspace.slug);
    expect(output.outbox).toEqual({ emails_sent: 1, linkedin_sent: 0, waiting: 0 });
  });
});
