/**
 * Delivery invariant for LinkedIn posts, boundary B6 (docs/concepts/delivery-guarantees.md): one
 * test per scenario S1 to S8. Both publishers share this path; publish.test.ts runs it through
 * the real `linkedin_official` and Unipile publishers behind a fake fetch.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { providerFailure } from "../../core/failures.js";
import { approvals, type NewPost, type Post, posts, problems } from "../../db/schema/index.js";
import { createUnipileClient } from "../../providers/linkedin/unipile-client.js";
import { createUnipileSocial } from "../../providers/social/unipile.js";
import type { SocialPublisher } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedLinkedInAccount } from "../../testing/factories.js";
import { postApprovalResolver } from "./approval.js";
import { publishPostOp } from "./operations.js";
import { ACCEPTED_WITHOUT_ID_NOTE, POST_STUCK_MS, publishPost } from "./publish.js";
import { publishDueJob } from "./publish-job.js";
import { resolveUnknownPost } from "./resolve-unknown.js";

vi.mock("../knowledge/service.js", () => ({ buildGroundingPack: vi.fn() }));
vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

const NOW = "2026-09-22T15:00:00.000Z";
const ACCOUNT = "uni_acc_Dana01Example";
const AGENT = { type: "agent" as const, id: "key_agent", name: "Agent" };
const STUCK_MINUTES = POST_STUCK_MS / 60_000 + 1;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

type Answer = { externalId: string; url?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function world() {
  const publisher = {
    id: "unipile",
    publish: vi.fn(
      async (_input: Parameters<SocialPublisher["publish"]>[0]): Promise<Answer> => ({
        externalId: "urn:li:activity:7380000000000000010",
        url: "https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000010/",
      }),
    ),
  } satisfies SocialPublisher;
  const ctx = await createTestContext({ db, now: NOW, providers: { social: [publisher] } });
  await seedLinkedInAccount(ctx, { provider: "unipile", external_account_id: ACCOUNT });
  return { ctx, publisher };
}

async function seedPost(ctx: TestContext, values: Partial<NewPost> = {}): Promise<Post> {
  const [row] = await ctx.db
    .insert(posts)
    .values({
      workspace_id: ctx.workspace.id,
      status: "scheduled",
      scheduled_for: new Date(NOW),
      body: "What we learned from shipping weekly for a year.",
      account_ref: { provider: "unipile", account_id: ACCOUNT, name: "Dana Example" },
      ...values,
    })
    .returning();
  if (!row) throw new Error("post insert failed");
  return row;
}

async function reload(ctx: TestContext, id: string): Promise<Post> {
  const [row] = await ctx.db.select().from(posts).where(eq(posts.id, id));
  if (!row) throw new Error(`post ${id} not found`);
  return row;
}

async function problemsOf(ctx: TestContext, postId: string) {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.subject_id, postId)));
}

async function call<I, O extends z.ZodType>(
  op: { handler(ctx: TestContext, input: I): Promise<unknown>; output: O; input: z.ZodType<I> },
  ctx: TestContext,
  input: unknown,
): Promise<z.output<O>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input)));
}

const runDue = (ctx: TestContext) =>
  publishDueJob.handler(ctx.jobContext({ name: "content.publish_due" }), {});

describe("delivery invariant: LinkedIn post (B6)", () => {
  it("B6 S1 a post found mid-publish becomes unknown and is not published again", async () => {
    const { ctx, publisher } = await world();
    // A run claimed it and then stopped (the worker died) before any answer came back.
    const post = await seedPost(ctx, {
      status: "publishing",
      publish_attempt: 1,
      publish_started_at: new Date(NOW),
    });
    ctx.clock.advanceBy({ minutes: STUCK_MINUTES });
    expect(await runDue(ctx)).toMatchObject({ published: 0, unknown: 1 });
    expect(await reload(ctx, post.id)).toMatchObject({ status: "unknown", publish_attempt: 1 });
    expect((await problemsOf(ctx, post.id))[0]).toMatchObject({
      kind: "send_unknown",
      status: "open",
    });
    ctx.clock.advanceBy({ hours: 6 });
    await runDue(ctx);
    expect(publisher.publish).not.toHaveBeenCalled();
    expect((await reload(ctx, post.id)).status).toBe("unknown");
  });

  it("B6 S2 a post whose publish timed out after the request becomes unknown, never retried", async () => {
    const { ctx, publisher } = await world();
    const post = await seedPost(ctx);
    publisher.publish.mockRejectedValueOnce(
      providerFailure({ provider: "unipile", class: "timeout" }),
    );
    expect(await runDue(ctx)).toMatchObject({ published: 0, failed: 0, unknown: 1 });
    expect(await reload(ctx, post.id)).toMatchObject({ status: "unknown", publish_attempt: 1 });
    ctx.clock.advanceBy({ days: 1 });
    await runDue(ctx);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect((await problemsOf(ctx, post.id)).map((row) => row.kind)).toEqual(["send_unknown"]);
  });

  it("B6 S3 a post LinkedIn took without an id counts as published", async () => {
    const { ctx, publisher } = await world();
    // An answer without an id, and the error the publishers raise for one: both went out.
    publisher.publish.mockResolvedValueOnce({ externalId: "" });
    publisher.publish.mockRejectedValueOnce(
      providerFailure({ provider: "unipile", class: "malformed", upstreamStatus: 201 }),
    );
    for (const post of [await seedPost(ctx), await seedPost(ctx)]) {
      const after = await publishPost(ctx, post);
      expect(after).toMatchObject({ status: "published", url: null, external_id: null });
      expect(after.why?.publish_note).toBe(ACCEPTED_WITHOUT_ID_NOTE);
    }
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(ctx.emitted("post.published")).toHaveLength(2);
  });

  it("B6 S4 two runs publishing the same post hand it over once", async () => {
    const { ctx, publisher } = await world();
    const post = await seedPost(ctx);
    const answer = deferred<Answer>();
    publisher.publish.mockImplementationOnce(() => answer.promise);
    const first = publishPost(ctx, post);
    await vi.waitFor(() => expect(publisher.publish).toHaveBeenCalledTimes(1));
    // The second run read the post while it was still scheduled.
    const second = await publishPost(ctx, post);
    expect(second).toMatchObject({ status: "publishing", publish_attempt: 1 });
    answer.resolve({ externalId: "urn:li:activity:1", url: "https://www.linkedin.com/feed/1/" });
    expect(await first).toMatchObject({ status: "published", publish_attempt: 1 });
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it("B6 S5 a post whose connection never opened is tried again on the same row", async () => {
    const { ctx, publisher } = await world();
    const post = await seedPost(ctx);
    publisher.publish.mockRejectedValueOnce(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      }),
    );
    expect(await runDue(ctx)).toMatchObject({ published: 0, retrying: 1 });
    expect(await reload(ctx, post.id)).toMatchObject({ status: "scheduled", publish_attempt: 1 });
    ctx.clock.advanceBy({ minutes: 5 });
    expect(await runDue(ctx)).toMatchObject({ published: 1 });
    expect(await reload(ctx, post.id)).toMatchObject({ status: "published", publish_attempt: 2 });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(
      await ctx.db.select().from(posts).where(eq(posts.workspace_id, ctx.workspace.id)),
    ).toHaveLength(1);
  });

  it("B6 S5 a post whose connection timed out while opening is tried again on the same row", async () => {
    const { ctx, publisher } = await world();
    const post = await seedPost(ctx);
    // The real Unipile publisher, whose connection times out while opening.
    const unipile = createUnipileSocial(
      createUnipileClient({
        dsn: "api1.unipile.example.com:13111",
        apiKey: "example-unipile-key",
        fetch: (async () => {
          const cause = Object.assign(new Error("Connect Timeout Error"), {
            code: "UND_ERR_CONNECT_TIMEOUT",
          });
          throw new TypeError("fetch failed", { cause });
        }) as typeof globalThis.fetch,
      }),
    );
    publisher.publish.mockImplementationOnce((input) => unipile.publish(input));
    expect(await runDue(ctx)).toMatchObject({ published: 0, unknown: 0, retrying: 1 });
    expect(await reload(ctx, post.id)).toMatchObject({ status: "scheduled", publish_attempt: 1 });
    expect(await problemsOf(ctx, post.id)).toEqual([]);
    ctx.clock.advanceBy({ minutes: 5 });
    expect(await runDue(ctx)).toMatchObject({ published: 1 });
    expect(await reload(ctx, post.id)).toMatchObject({ status: "published", publish_attempt: 2 });
  });

  it("B6 S6 a post whose first try succeeds after the republish is recorded as a duplicate", async () => {
    const { ctx, publisher } = await world();
    const post = await seedPost(ctx);
    const late = deferred<Answer>();
    publisher.publish.mockImplementationOnce(() => late.promise);
    const firstTry = publishPost(ctx, post);
    await vi.waitFor(() => expect(publisher.publish).toHaveBeenCalledTimes(1));
    ctx.clock.advanceBy({ minutes: STUCK_MINUTES });
    await runDue(ctx);
    expect((await reload(ctx, post.id)).status).toBe("unknown");

    // A person found nothing on the profile and had it published again.
    expect(
      await call(resolveUnknownPost, ctx, { post_id: post.id, outcome: "republish" }),
    ).toMatchObject({
      status: "published",
    });
    // Then the first try's answer arrives: it went out too.
    late.resolve({
      externalId: "urn:li:activity:7380000000000000099",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000099/",
    });
    await firstTry;
    const row = await reload(ctx, post.id);
    expect(row).toMatchObject({ status: "published", publish_attempt: 2 });
    expect(row.why?.duplicate_attempts).toEqual([1, 2]);
    const duplicate = (await problemsOf(ctx, post.id)).find((p) => p.kind === "duplicate_send");
    expect(duplicate).toMatchObject({
      title: "LinkedIn post went out twice",
      owner: "person",
      data: { attempts: [1, 2], proven: true },
    });
    expect(duplicate?.reason).toContain("urn:li:activity:7380000000000000099");
    expect(ctx.emitted("problem.opened").map((e) => e.data.kind)).toContain("duplicate_send");
  });

  it("B6 S7 a post asked to publish twice goes out once", async () => {
    const { ctx, publisher } = await world();
    const post = await seedPost(ctx, { status: "draft", scheduled_for: null });
    const first = await call(publishPostOp, ctx, { post_id: post.id });
    const again = await call(publishPostOp, ctx, { post_id: post.id });
    expect(first).toMatchObject({ status: "published" });
    expect(again).toMatchObject({ status: "published", id: post.id });
    await runDue(ctx);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(ctx.emitted("post.published")).toHaveLength(1);
  });

  it("B6 S8 a post is never published again on its own: a person decides", async () => {
    const { ctx, publisher } = await world();
    const post = await seedPost(ctx);
    publisher.publish.mockRejectedValueOnce(
      providerFailure({ provider: "unipile", class: "unavailable", upstreamStatus: 502 }),
    );
    await runDue(ctx);
    for (let run = 0; run < 3; run++) {
      ctx.clock.advanceBy({ hours: 2 });
      await runDue(ctx);
    }
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    await expect(call(publishPostOp, ctx, { post_id: post.id })).rejects.toMatchObject({
      code: "conflict",
    });
    // An agent's request to publish it again waits for a person.
    const agent = ctx.with({ principal: AGENT });
    const asked = await call(resolveUnknownPost, agent, { post_id: post.id, outcome: "republish" });
    expect(asked).toMatchObject({ status: "awaiting_approval" });
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const [approval] = await ctx.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, (asked as { approval_id: string }).approval_id));
    if (!approval) throw new Error("approval missing");
    await postApprovalResolver.apply(ctx, approval, {
      decision: "approve",
      decidedBy: { type: "human", id: "usr_owner", name: "Owner" },
    });
    expect(await reload(ctx, post.id)).toMatchObject({ status: "published", publish_attempt: 2 });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });

  it("B6 S8 an approval to publish again that a person overtook publishes nothing", async () => {
    const { ctx, publisher } = await world();
    const post = await seedPost(ctx);
    const noAnswer = () => providerFailure({ provider: "unipile", class: "timeout" });
    publisher.publish.mockRejectedValueOnce(noAnswer()).mockRejectedValueOnce(noAnswer());
    await runDue(ctx);
    expect(await reload(ctx, post.id)).toMatchObject({ status: "unknown", publish_attempt: 1 });
    // An agent asks to publish it again; meanwhile the owner does so directly, and that try gets
    // no clear answer either.
    const agent = ctx.with({ principal: AGENT });
    const asked = await call(resolveUnknownPost, agent, { post_id: post.id, outcome: "republish" });
    const approvalId = (asked as { approval_id: string }).approval_id;
    await call(resolveUnknownPost, ctx, { post_id: post.id, outcome: "republish" });
    expect(await reload(ctx, post.id)).toMatchObject({ status: "unknown", publish_attempt: 2 });
    const [request] = await ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
    if (!request) throw new Error("approval missing");
    expect(request.status).toBe("cancelled");
    // Approved anyway (decided at the same moment): it was about the first try only.
    const applied = await postApprovalResolver.apply(ctx, request, {
      decision: "approve",
      decidedBy: { type: "human", id: "usr_owner", name: "Owner" },
    });
    expect(applied.message).toContain("nothing to apply");
    expect(await reload(ctx, post.id)).toMatchObject({ status: "unknown", publish_attempt: 2 });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });
});
