/** Problems operations: list, get, resolve (with the relationship view) and snooze. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { isOpenOutboundError } from "../../core/errors.js";
import type { AnyOperation } from "../../core/operation.js";
import { messages, posts, suppressions } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedMessage, seedPerson } from "../../testing/factories.js";
import { module } from "./index.js";
import { getProblemOp, listProblemsOp, resolveProblemOp, snoozeProblemOp } from "./operations.js";
import { openProblem } from "./service.js";

const NOW = "2026-09-22T15:00:00.000Z";
const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.parse(NOW) + hours * HOUR);

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function call<O extends AnyOperation>(
  op: O,
  ctx: TestContext,
  input: z.input<O["input"]>,
): Promise<z.output<O["output"]>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input)));
}

async function seeded() {
  const ctx = await createTestContext({ db, now: NOW });
  const person = await seedPerson(ctx, { full_name: "Dana Reyes" });
  const hot = await openProblem(ctx, {
    kind: "stuck",
    severity: "high",
    title: "Hot reply from Dana Reyes waits for an answer",
    reason: "Dana Reyes replied (interested) 30 hours ago.",
    remedy: "Draft an answer with reply_to_thread action draft.",
    personId: person.id,
    data: { rule: "hot_reply_unanswered" },
    dedupeKey: "stuck:hot_reply_unanswered:thr_1",
  });
  const privacy = await openProblem(ctx, {
    kind: "privacy_request",
    severity: "urgent",
    owner: "person",
    title: "Privacy request from Dana Reyes",
    reason: "Asked what data we hold.",
    remedy: "Answer within 30 days.",
    personId: person.id,
    dueAt: at(24 * 30),
  });
  const dns = await openProblem(ctx, {
    kind: "dns_failed",
    severity: "normal",
    title: "DMARC missing on example.org",
    reason: "No DMARC record.",
    remedy: "Add it, then run manage_mailboxes action check_dns.",
  });
  return { ctx, person, hot: hot.id, privacy: privacy.id, dns: dns.id };
}

describe("problems.list and problems.get", () => {
  it("lists open problems most severe first, with filters and pages", async () => {
    const s = await seeded();
    const all = await call(listProblemsOp, s.ctx, {});
    expect(all.items.map((item) => item.id)).toEqual([s.privacy, s.hot, s.dns]);
    expect(all.items[0]).toMatchObject({
      kind: "privacy_request",
      severity: "urgent",
      owner: "person",
      person_id: s.person.id,
      due_at: at(24 * 30).toISOString(),
    });
    const stuck = await call(listProblemsOp, s.ctx, { kinds: ["stuck"] });
    expect(stuck.items.map((item) => item.id)).toEqual([s.hot]);
    const mine = await call(listProblemsOp, s.ctx, { person_id: s.person.id });
    expect(mine.items).toHaveLength(2);

    const first = await call(listProblemsOp, s.ctx, { limit: 2 });
    expect(first).toMatchObject({ has_more: true });
    const second = await call(listProblemsOp, s.ctx, {
      limit: 2,
      cursor: first.next_cursor ?? undefined,
    });
    expect(second.items.map((item) => item.id)).toEqual([s.dns]);
    expect(second.has_more).toBe(false);
  });

  it("never shows another workspace's problems", async () => {
    const s = await seeded();
    const other = await createTestContext({ db, now: NOW });
    expect((await call(listProblemsOp, other, {})).items).toEqual([]);
    await expect(call(getProblemOp, other, { problem_id: s.hot })).rejects.toMatchObject({
      code: "not_found",
      hint: expect.stringContaining("resolve_exception action list"),
    });
  });

  it("gets one problem with its facts marked untrusted", async () => {
    const s = await seeded();
    const problem = await call(getProblemOp, s.ctx, { problem_id: s.hot });
    expect(problem).toMatchObject({
      id: s.hot,
      data: { rule: "hot_reply_unanswered" },
      resolution: null,
      untrusted: true,
    });
  });

  it("rejects ids that are not problem ids", () => {
    expect(getProblemOp.input.safeParse({ problem_id: "msg_1" }).success).toBe(false);
    expect(resolveProblemOp.input.safeParse({ problem_id: "" }).success).toBe(false);
  });
});

describe("problems.resolve", () => {
  it("resolves once and returns the person's fresh relationship view", async () => {
    const s = await seeded();
    const result = await call(resolveProblemOp, s.ctx, {
      problem_id: s.hot,
      resolution: "Sent Dana the pricing sheet.",
    });
    expect(result.resolved).toBe(true);
    expect(result.problem).toMatchObject({
      status: "resolved",
      resolution: "Sent Dana the pricing sheet.",
      resolved_by: "Test User",
    });
    expect(result.relationship).toMatchObject({ person_id: s.person.id, state: "stopped" });
    expect(result.relationship?.blockers.map((item) => item.code)).toContain(
      "privacy_request_open",
    );
    expect(result.next_step).toContain("Resolved.");
    expect(result.next_step).toContain("Still blocked:");
    expect(result.next_step).toContain("the stuck check opens it again within 15 minutes");

    const again = await call(resolveProblemOp, s.ctx, { problem_id: s.hot });
    expect(again.resolved).toBe(false);
    expect(again.next_step.startsWith("It was already resolved.")).toBe(true);
    expect(s.ctx.emitted("problem.resolved")).toHaveLength(1);
  });

  it("returns no relationship for a problem without a person", async () => {
    const s = await seeded();
    const result = await call(resolveProblemOp, s.ctx, { problem_id: s.dns });
    expect(result.relationship).toBeNull();
  });

  it("refuses a send_unknown problem while its message is unknown, naming resolve_unknown", async () => {
    const s = await seeded();
    const message = await seedMessage(s.ctx, { person_id: s.person.id, status: "unknown" });
    const unknown = await openProblem(s.ctx, {
      kind: "send_unknown",
      severity: "high",
      owner: "person",
      title: "Check whether an email went out",
      reason: "The mail server timed out after the email was handed over.",
      remedy: `Look in the Sent folder, then use manage_messages action resolve_unknown with outcome sent or resend (message_id ${message.id}).`,
      subject: { type: "message", id: message.id },
      personId: s.person.id,
      data: { message_id: message.id, channel: "email" },
      dedupeKey: `send_unknown:${message.id}`,
    });
    const refused = await call(resolveProblemOp, s.ctx, { problem_id: unknown.id }).catch(
      (error: unknown) => error,
    );
    if (!isOpenOutboundError(refused)) throw new Error("expected a refusal");
    expect(refused).toMatchObject({ code: "conflict", details: { message_id: message.id } });
    expect(refused.hint).toContain(
      `manage_messages action resolve_unknown (message_id ${message.id}`,
    );
    expect((await call(getProblemOp, s.ctx, { problem_id: unknown.id })).status).toBe("open");

    // Once the message is settled, the problem can be closed; nothing claims it comes back.
    await s.ctx.db.update(messages).set({ status: "cancelled" }).where(eq(messages.id, message.id));
    const result = await call(resolveProblemOp, s.ctx, { problem_id: unknown.id });
    expect(result.resolved).toBe(true);
    expect(result.next_step).not.toContain("again");
  });

  it("refuses a send_unknown problem while its post is unknown, naming the posts action", async () => {
    const s = await seeded();
    const [post] = await s.ctx.db
      .insert(posts)
      .values({
        workspace_id: s.ctx.workspace.id,
        body: "Notes from a long week of reorder planning.",
        status: "unknown",
        publish_attempt: 1,
      })
      .returning();
    if (!post) throw new Error("no post");
    const unknown = await openProblem(s.ctx, {
      kind: "send_unknown",
      severity: "high",
      owner: "person",
      title: "Check whether a LinkedIn post went out",
      reason: "LinkedIn did not answer in time after the post was handed over.",
      remedy: `Check the profile, then use manage_posts action resolve_unknown (post_id ${post.id}).`,
      subject: { type: "post", id: post.id },
      data: { post_id: post.id, attempt: 1 },
      dedupeKey: `send_unknown:${post.id}`,
    });
    const refused = await call(resolveProblemOp, s.ctx, { problem_id: unknown.id }).catch(
      (error: unknown) => error,
    );
    if (!isOpenOutboundError(refused)) throw new Error("expected a refusal");
    expect(refused).toMatchObject({ code: "conflict", details: { post_id: post.id } });
    expect(refused.hint).toContain(`manage_posts action resolve_unknown (post_id ${post.id}`);
    expect((await call(getProblemOp, s.ctx, { problem_id: unknown.id })).status).toBe("open");

    await s.ctx.db.update(posts).set({ status: "draft" }).where(eq(posts.id, post.id));
    const result = await call(resolveProblemOp, s.ctx, { problem_id: unknown.id });
    expect(result.resolved).toBe(true);
  });

  it("says a problem opens again only for kinds the engine checks again", async () => {
    const s = await seeded();
    const privacy = await openProblem(s.ctx, {
      kind: "privacy_request",
      severity: "urgent",
      title: "Privacy request from Dana Reyes",
      reason: "Asked to delete their data.",
      remedy: "Delete it with manage_leads action forget.",
      dedupeKey: "privacy_request:msg_1",
    });
    const dns = await openProblem(s.ctx, {
      kind: "dns_failed",
      severity: "high",
      title: "DNS of example.org stopped passing",
      reason: "DKIM stopped passing.",
      remedy: "Fix it, then run manage_mailboxes action check_dns.",
      dedupeKey: "dns_failed:example.org",
    });
    const closed = await call(resolveProblemOp, s.ctx, { problem_id: privacy.id });
    expect(closed.next_step).not.toContain("again");
    const checked = await call(resolveProblemOp, s.ctx, { problem_id: dns.id });
    expect(checked.next_step).toContain("The daily DNS check opens it again");
  });

  it("refuses to close a deletion request while the person is stored, naming forget", async () => {
    const s = await seeded();
    const deletion = await openProblem(s.ctx, {
      kind: "privacy_request",
      severity: "urgent",
      owner: "person",
      title: "Privacy request from Dana Reyes: delete their data",
      reason: "Dana Reyes asked to delete their data.",
      remedy: `Reply to them yourself, then run manage_leads action forget with person_id ${s.person.id}.`,
      personId: s.person.id,
      data: { kind: "delete" },
      dedupeKey: "privacy_request:msg_delete",
    });
    const agent = s.ctx.with({
      principal: { type: "agent", scopes: ["read", "write", "send", "spend", "approve"] },
    });
    const refused = await call(resolveProblemOp, agent, { problem_id: deletion.id }).catch(
      (error: unknown) => error,
    );
    if (!isOpenOutboundError(refused)) throw new Error("expected a refusal");
    expect(refused).toMatchObject({
      code: "forbidden",
      details: { missing_scope: "admin", problem_id: deletion.id, person_id: s.person.id },
    });
    expect(refused.hint).toBe(
      `They asked to be deleted: run manage_leads action forget with person_id ${s.person.id}; it resolves this problem. If their data must be kept, a person with the admin scope closes it with a note saying why.`,
    );
    expect((await call(getProblemOp, s.ctx, { problem_id: deletion.id })).status).toBe("open");

    // A person with the admin scope may keep the data, but only with a note saying why.
    await expect(call(resolveProblemOp, s.ctx, { problem_id: deletion.id })).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "resolution" },
    });
    const kept = await call(resolveProblemOp, s.ctx, {
      problem_id: deletion.id,
      resolution: "Kept: we must keep their invoices for 10 years.",
    });
    expect(kept).toMatchObject({ resolved: true, problem: { status: "resolved" } });
    // The privacy person stays blocked on purpose: no "Still blocked" advice.
    expect(kept.next_step).not.toContain("Still blocked");
  });

  it("closes access requests as before, without advice to lift a suppression", async () => {
    const s = await seeded();
    await s.ctx.db.insert(suppressions).values({
      workspace_id: s.ctx.workspace.id,
      type: "person",
      value: s.person.id,
      reason: "do_not_contact",
      source: "reply",
      note: "Privacy request (reply msg_1)",
    });
    const agent = s.ctx.with({
      principal: { type: "agent", scopes: ["read", "write", "send", "spend", "approve"] },
    });
    // The seeded privacy request asks what data we hold (no kind delete): it closes as before.
    const access = await call(resolveProblemOp, agent, {
      problem_id: s.privacy,
      resolution: "Sent them what we hold.",
    });
    expect(access.resolved).toBe(true);
    expect(access.next_step).not.toContain("Still blocked");
    // Other problems of that person never suggest lifting the suppression.
    const stuck = await call(resolveProblemOp, agent, { problem_id: s.hot });
    expect(stuck.relationship?.blockers.map((item) => item.code)).toContain("suppressed_person");
    expect(stuck.relationship?.blockers.every((item) => !item.fix?.includes("remove"))).toBe(true);
    expect(stuck.next_step).not.toContain("manage_suppressions");
  });

  it("refuses an unknown problem with the way to find one", async () => {
    const s = await seeded();
    await expect(
      call(resolveProblemOp, s.ctx, { problem_id: "pb_01k6a3v0q8x3m2n4p5r6s7t8v9" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("problems.snooze", () => {
  it("snoozes until a time and shows it as open again after", async () => {
    const s = await seeded();
    const result = await call(snoozeProblemOp, s.ctx, {
      problem_id: s.dns,
      until: at(48).toISOString(),
    });
    expect(result.problem).toMatchObject({
      status: "snoozed",
      snoozed_until: at(48).toISOString(),
    });
    expect(result.next_step).toBe(
      "Snoozed until Thursday 15:00 UTC; it counts as open again then.",
    );
    expect((await call(listProblemsOp, s.ctx, {})).items.map((item) => item.id)).not.toContain(
      s.dns,
    );
    s.ctx.clock.set(at(49));
    expect((await call(listProblemsOp, s.ctx, {})).items.map((item) => item.id)).toContain(s.dns);
  });

  it("validates the time and the status", async () => {
    const s = await seeded();
    await expect(
      call(snoozeProblemOp, s.ctx, { problem_id: s.dns, until: at(-1).toISOString() }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      call(snoozeProblemOp, s.ctx, { problem_id: s.dns, until: at(24 * 91).toISOString() }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await call(resolveProblemOp, s.ctx, { problem_id: s.dns });
    await expect(
      call(snoozeProblemOp, s.ctx, { problem_id: s.dns, until: at(5).toISOString() }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("resolve_exception", () => {
  it("is a core tool that lists, reads, resolves and snoozes problems", () => {
    expect(module.tools).toEqual([
      expect.objectContaining({
        name: "resolve_exception",
        toolset: "core",
        actions: {
          list: "problems.list",
          get: "problems.get",
          resolve: "problems.resolve",
          snooze: "problems.snooze",
        },
      }),
    ]);
    expect(module.operations?.map((op) => op.id)).toEqual([
      "problems.list",
      "problems.get",
      "problems.resolve",
      "problems.snooze",
    ]);
  });
});
