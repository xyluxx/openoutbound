import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { OpenOutboundError } from "../../core/errors.js";
import { type FailureClass, providerFailure } from "../../core/failures.js";
import {
  approvals,
  type NewPost,
  type Post,
  posts,
  problems,
  social_accounts,
  workspaces,
} from "../../db/schema/index.js";
import { createUnipileClient } from "../../providers/linkedin/unipile-client.js";
import { createLinkedInOfficial } from "../../providers/social/linkedin-official.js";
import { createUnipileSocial } from "../../providers/social/unipile.js";
import type { SocialPublisher } from "../../providers/types.js";
import { type HealthBinding, trackProviderHealth } from "../../runtime/provider-health.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedLinkedInAccount } from "../../testing/factories.js";
import { postApprovalResolver } from "./approval.js";
import { cancelPost, listPosts, publishPostOp, schedulePost, updatePostOp } from "./operations.js";
import {
  ACCEPTED_WITHOUT_ID_NOTE,
  MAX_PUBLISH_ATTEMPTS,
  POST_STUCK_MS,
  publishPost,
  sweepStuckPublishes,
} from "./publish.js";
import { APPROVED_LEFT_MS, publishDueJob } from "./publish-job.js";
import { resolveUnknownPost } from "./resolve-unknown.js";

vi.mock("../knowledge/service.js", () => ({ buildGroundingPack: vi.fn() }));
vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

const NOW = "2026-09-22T15:00:00.000Z";
const AGENT = { type: "agent" as const, id: "key_agent", name: "Agent" };
const OWNER = { type: "human" as const, id: "usr_owner", name: "Owner" };
const UNIPILE_ACCOUNT = "uni_acc_Sam01Example";
const MEMBER = "urn:li:person:exampleSub01";
const TOKEN = "example-linkedin-access-token";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

function fakePublisher(id: string) {
  return {
    id,
    publish: vi.fn(async (input: Parameters<SocialPublisher["publish"]>[0]) => ({
      externalId: `urn:li:share:${id}-${input.text.length}`,
      url: `https://www.linkedin.com/feed/update/urn:li:share:${id}/`,
    })),
  } satisfies SocialPublisher;
}

/** A promise settled from outside, to hold a publish call open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function setup(publisher?: SocialPublisher) {
  const unipile = fakePublisher("unipile");
  const ctx = await createTestContext({
    db,
    now: NOW,
    providers: { social: [publisher ?? unipile] },
  });
  await seedLinkedInAccount(ctx, { provider: "unipile", external_account_id: UNIPILE_ACCOUNT });
  return { ctx, unipile, agent: ctx.with({ principal: AGENT }) };
}

async function seedPost(ctx: TestContext, values: Partial<NewPost> = {}): Promise<Post> {
  const [row] = await ctx.db
    .insert(posts)
    .values({
      workspace_id: ctx.workspace.id,
      status: "approved",
      body: "Three lessons from rebuilding our onboarding flow.",
      account_ref: { provider: "unipile", account_id: UNIPILE_ACCOUNT, name: "Sam Sender" },
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

async function call<I, O extends z.ZodType>(
  op: { handler(ctx: TestContext, input: I): Promise<unknown>; output: O; input: z.ZodType<I> },
  ctx: TestContext,
  input: unknown,
): Promise<z.output<O>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input)));
}

async function problemsOf(ctx: TestContext, postId: string) {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.subject_id, postId)));
}

async function decide(ctx: TestContext, approvalId: string, decision: "approve" | "reject") {
  const [approval] = await ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!approval) throw new Error(`approval ${approvalId} not found`);
  return postApprovalResolver.apply(ctx, approval, { decision, decidedBy: OWNER });
}

const runDue = (ctx: TestContext) =>
  publishDueJob.handler(ctx.jobContext({ name: "content.publish_due" }), {});

/** A post whose first publish got no clear answer. */
async function unknownPost(ctx: TestContext, publisher: ReturnType<typeof fakePublisher>) {
  const post = await seedPost(ctx);
  publisher.publish.mockRejectedValueOnce(
    providerFailure({ provider: "unipile", class: "timeout" }),
  );
  const after = await publishPost(ctx, post);
  expect(after.status).toBe("unknown");
  return after;
}

describe("publishing: each failure class", () => {
  const refusedBeforeHandover: FailureClass[] = [
    "quota_exhausted",
    "auth_invalid",
    "forbidden",
    "not_found",
    "bad_request",
    "refused",
  ];
  const mayHaveReachedLinkedIn: FailureClass[] = [
    "timeout",
    "network",
    "unavailable",
    "outcome_unknown",
  ];

  it.each(mayHaveReachedLinkedIn)("%s makes the post unknown with a problem", async (cls) => {
    const { ctx, unipile } = await setup();
    const post = await seedPost(ctx);
    unipile.publish.mockRejectedValueOnce(providerFailure({ provider: "unipile", class: cls }));
    const after = await publishPost(ctx, post);
    expect(after).toMatchObject({ status: "unknown", publish_attempt: 1, published_at: null });
    expect(after.why?.publish_note).toMatch(/may or may not have published/);
    const [problem] = await problemsOf(ctx, post.id);
    expect(problem).toMatchObject({ kind: "send_unknown", owner: "person", status: "open" });
    expect(problem?.remedy).toContain("manage_posts action resolve_unknown");
    expect(ctx.emitted("post.published")).toHaveLength(0);
  });

  it.each(refusedBeforeHandover)(
    "%s of this call fails the post: nothing went out",
    async (cls) => {
      const { ctx, unipile } = await setup();
      const post = await seedPost(ctx);
      unipile.publish.mockRejectedValueOnce(
        providerFailure({ provider: "unipile", class: cls, scope: "call" }),
      );
      const after = await publishPost(ctx, post);
      expect(after).toMatchObject({ status: "failed", publish_attempt: 1 });
      expect(after.why?.failed_before_handover).toBe(true);
      expect(await problemsOf(ctx, post.id)).toHaveLength(0);
    },
  );

  const pausing: Array<[FailureClass, "account" | "provider"]> = [
    ["auth_invalid", "account"],
    ["forbidden", "account"],
    ["quota_exhausted", "provider"],
  ];

  it.each(pausing)(
    "%s of the %s pauses the publisher: the post waits, without counting a try",
    async (cls, scope) => {
      const { ctx, unipile } = await setup();
      const post = await seedPost(ctx, {
        status: "scheduled",
        scheduled_for: new Date(NOW),
        why: { publish_retries: 2 },
      });
      unipile.publish.mockRejectedValueOnce(
        providerFailure({ provider: "unipile", class: cls, scope }),
      );
      const after = await publishPost(ctx, post);
      expect(after).toMatchObject({ status: "scheduled", publish_attempt: 1 });
      expect(after.scheduled_for?.toISOString()).toBe("2026-09-22T16:00:00.000Z");
      expect(after.why?.publish_retries).toBe(2);
      expect(after.why?.failed_before_handover).toBeUndefined();
      expect(after.why?.publish_note).toMatch(/^Nothing reached LinkedIn .+ the post waits/);
      expect(await problemsOf(ctx, post.id)).toHaveLength(0);
    },
  );

  it("waits as long as a paused publisher says, and at least 15 minutes", async () => {
    const { ctx, unipile } = await setup();
    const paused = (retryAfterSeconds: number) =>
      providerFailure({
        provider: "unipile",
        class: "quota_exhausted",
        scope: "account",
        retryAfterSeconds,
        details: { paused: true },
      });
    unipile.publish.mockRejectedValueOnce(paused(7200)).mockRejectedValueOnce(paused(60));
    const later = await publishPost(ctx, await seedPost(ctx));
    const soon = await publishPost(ctx, await seedPost(ctx));
    expect(later.scheduled_for?.toISOString()).toBe("2026-09-22T17:00:00.000Z");
    expect(soon.scheduled_for?.toISOString()).toBe("2026-09-22T15:15:00.000Z");
  });

  it("tries a rate limited post again later, on the same row", async () => {
    const { ctx, unipile } = await setup();
    const post = await seedPost(ctx);
    unipile.publish.mockRejectedValueOnce(
      providerFailure({ provider: "unipile", class: "rate_limited", retryAfterSeconds: 3600 }),
    );
    const after = await publishPost(ctx, post);
    expect(after).toMatchObject({ id: post.id, status: "scheduled", publish_attempt: 1 });
    expect(after.scheduled_for?.toISOString()).toBe("2026-09-22T16:00:00.000Z");
    expect(after.why?.publish_note).toMatch(/Nothing reached LinkedIn/);
    ctx.clock.advanceBy({ hours: 1 });
    expect(await runDue(ctx)).toMatchObject({ published: 1 });
    expect(await reload(ctx, post.id)).toMatchObject({ status: "published", publish_attempt: 2 });
    expect(unipile.publish).toHaveBeenCalledTimes(2);
  });

  it("counts an accepted answer without a readable id as published, with a note", async () => {
    const { ctx, unipile } = await setup();
    const post = await seedPost(ctx);
    unipile.publish.mockRejectedValueOnce(
      providerFailure({ provider: "unipile", class: "malformed", upstreamStatus: 201 }),
    );
    const after = await publishPost(ctx, post);
    expect(after).toMatchObject({ status: "published", url: null, external_id: null });
    expect(after.why?.publish_note).toBe(ACCEPTED_WITHOUT_ID_NOTE);
    expect(ctx.emitted("post.published")).toHaveLength(1);
  });

  it("reads the error shapes providers used before failures.ts", async () => {
    const legacy: Array<[unknown, Post["status"]]> = [
      [
        new OpenOutboundError("provider_error", "LinkedIn post failed (503)", {
          details: { provider: "linkedin_official", status: 503, retryable: true },
        }),
        "unknown",
      ],
      [
        new OpenOutboundError("provider_error", "Unipile accepted the post but returned no id.", {
          details: { provider: "unipile", reason: "malformed_response", retryable: false },
        }),
        "published",
      ],
      [
        new OpenOutboundError("provider_error", "LinkedIn post failed (429)", {
          details: {
            provider: "linkedin_official",
            status: 429,
            retryable: true,
            rateLimited: true,
          },
          retryAfterSeconds: 3600,
        }),
        "scheduled",
      ],
      [
        new OpenOutboundError("validation_failed", "Post is longer than 3000 characters."),
        "failed",
      ],
      [new Error("socket hang up"), "unknown"],
      [
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        }),
        "scheduled",
      ],
    ];
    for (const [error, status] of legacy) {
      const { ctx, unipile } = await setup();
      const post = await seedPost(ctx);
      unipile.publish.mockRejectedValueOnce(error);
      expect((await publishPost(ctx, post)).status, String(error)).toBe(status);
    }
  });

  it("fails for good after the last try that failed before handover", async () => {
    const { ctx, unipile } = await setup();
    const post = await seedPost(ctx, {
      status: "scheduled",
      scheduled_for: new Date(NOW),
      publish_attempt: MAX_PUBLISH_ATTEMPTS - 1,
      why: { publish_retries: MAX_PUBLISH_ATTEMPTS - 1 },
    });
    unipile.publish.mockRejectedValueOnce(
      providerFailure({ provider: "unipile", class: "rate_limited" }),
    );
    const after = await publishPost(ctx, post);
    expect(after).toMatchObject({ status: "failed", publish_attempt: MAX_PUBLISH_ATTEMPTS });
    expect(after.error).toContain(`gave up after ${MAX_PUBLISH_ATTEMPTS} tries`);
  });

  it("counts tries per publish request; a new request or a cancel starts afresh", async () => {
    const { ctx, unipile } = await setup();
    const rateLimited = () => providerFailure({ provider: "unipile", class: "rate_limited" });
    // The last try of a request, on a post with many attempts behind it.
    const post = await seedPost(ctx, {
      publish_attempt: 2 * MAX_PUBLISH_ATTEMPTS,
      why: { angle: "Onboarding lessons", publish_retries: MAX_PUBLISH_ATTEMPTS - 1 },
    });
    unipile.publish.mockRejectedValueOnce(rateLimited());
    const failed = await publishPost(ctx, post);
    expect(failed.status).toBe("failed");
    expect(failed.why).toEqual({ angle: "Onboarding lessons", failed_before_handover: true });

    // Published again: a new request with tries of its own.
    unipile.publish.mockRejectedValueOnce(rateLimited());
    expect(await call(publishPostOp, ctx, { post_id: post.id })).toMatchObject({
      status: "scheduled",
      note: expect.stringMatching(/^Nothing reached LinkedIn/),
    });
    expect((await reload(ctx, post.id)).why).toEqual({
      angle: "Onboarding lessons",
      publish_retries: 1,
      publish_note: expect.stringMatching(/^Nothing reached LinkedIn/),
    });

    // Cancelled: a draft without the last request's note.
    expect(await call(cancelPost, ctx, { post_id: post.id })).toMatchObject({
      status: "draft",
      note: null,
    });
    expect((await reload(ctx, post.id)).why).toEqual({ angle: "Onboarding lessons" });
  });

  it("publishes an approved post a stopped run left before its claim", async () => {
    const { ctx, unipile } = await setup();
    const tenMinutesAgo = new Date(Date.parse(NOW) - APPROVED_LEFT_MS);
    const fresh = await seedPost(ctx, { updated_at: new Date(Date.parse(NOW) - 60_000) });
    const left = await seedPost(ctx, { updated_at: new Date(tenMinutesAgo.getTime() - 60_000) });

    const result = await publishDueJob.handler(ctx.jobContext({ name: "content.publish_due" }), {});

    expect(result).toMatchObject({ published: 1, failed: 0, unknown: 0 });
    expect(unipile.publish).toHaveBeenCalledTimes(1);
    expect(await reload(ctx, left.id)).toMatchObject({ status: "published", publish_attempt: 1 });
    // Approved a minute ago: its own run may still be on its way to the claim.
    expect(await reload(ctx, fresh.id)).toMatchObject({ status: "approved", publish_attempt: 0 });
  });

  it("waits for the new time of an approved post a stopped run left, once a person moves it", async () => {
    const { ctx, unipile } = await setup();
    const left = await seedPost(ctx, {
      updated_at: new Date(Date.parse(NOW) - APPROVED_LEFT_MS - 60_000),
    });
    const tomorrow = "2026-09-23T15:00:00.000Z";
    const { post } = await call(updatePostOp, ctx, { post_id: left.id, scheduled_for: tomorrow });
    // Its approval still covers the text: it waits for the new time.
    expect(post).toMatchObject({ status: "scheduled", scheduled_for: tomorrow });
    ctx.clock.advanceBy({ minutes: 15 });
    expect(await runDue(ctx)).toMatchObject({ published: 0 });
    expect(unipile.publish).not.toHaveBeenCalled();
    ctx.clock.advanceBy({ days: 1 });
    expect(await runDue(ctx)).toMatchObject({ published: 1 });
    expect(await reload(ctx, left.id)).toMatchObject({ status: "published", publish_attempt: 1 });
  });

  it("leaves an approved post whose time is still ahead until that time", async () => {
    const { ctx, unipile } = await setup();
    const ahead = await seedPost(ctx, {
      scheduled_for: new Date(Date.parse(NOW) + 60 * 60_000),
      updated_at: new Date(Date.parse(NOW) - APPROVED_LEFT_MS - 60_000),
    });
    expect(await runDue(ctx)).toMatchObject({ published: 0 });
    expect(unipile.publish).not.toHaveBeenCalled();
    ctx.clock.advanceBy({ hours: 1 });
    expect(await runDue(ctx)).toMatchObject({ published: 1 });
    expect(await reload(ctx, ahead.id)).toMatchObject({ status: "published" });
  });

  it("leaves an approved post alone while the workspace is paused", async () => {
    const { ctx, unipile } = await setup();
    const post = await seedPost(ctx, { updated_at: new Date(Date.parse(NOW) - 3_600_000) });
    await ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, ctx.workspace.id));

    const result = await publishDueJob.handler(ctx.jobContext({ name: "content.publish_due" }), {});

    expect(result).toMatchObject({ published: 0, skipped: "workspace_paused" });
    expect(unipile.publish).not.toHaveBeenCalled();
    expect(await reload(ctx, post.id)).toMatchObject({ status: "approved" });
  });

  it("claims no more posts once the job ran out of time", async () => {
    const { ctx, unipile } = await setup();
    const first = await seedPost(ctx, {
      status: "scheduled",
      scheduled_for: new Date(Date.parse(NOW) - 60_000),
    });
    const second = await seedPost(ctx, { status: "scheduled", scheduled_for: new Date(NOW) });
    const controller = new AbortController();
    unipile.publish.mockImplementationOnce(async (input) => {
      // The job's time runs out while LinkedIn answers the first post.
      controller.abort(new Error("job timed out"));
      return {
        externalId: "urn:li:share:first",
        url: `https://www.linkedin.com/feed/${input.text.length}/`,
      };
    });
    const job = ctx.jobContext({ name: "content.publish_due", signal: controller.signal });
    expect(await publishDueJob.handler(job, {})).toMatchObject({ published: 1, unknown: 0 });
    expect(await reload(ctx, first.id)).toMatchObject({ status: "published" });
    // The second one was never claimed: nothing was sent, nothing to check.
    expect(await reload(ctx, second.id)).toMatchObject({ status: "scheduled", publish_attempt: 0 });
    expect(await problemsOf(ctx, second.id)).toEqual([]);
    expect(unipile.publish).toHaveBeenCalledTimes(1);
  });

  it("passes the job's signal to the publisher", async () => {
    const { ctx, unipile } = await setup();
    await seedPost(ctx, { status: "scheduled", scheduled_for: new Date(NOW) });
    const job = ctx.jobContext({ name: "content.publish_due" });
    await publishDueJob.handler(job, {});
    expect(unipile.publish.mock.calls[0]?.[0].signal).toBe(job.job.signal);
  });
});

describe("publishing: answers that come late", () => {
  it("records a late success as published when the post was found stopped", async () => {
    const { ctx, unipile } = await setup();
    const post = await seedPost(ctx);
    const first = deferred<{ externalId: string; url: string }>();
    unipile.publish.mockImplementationOnce(() => first.promise);
    const running = publishPost(ctx, post);
    await vi.waitFor(() => expect(unipile.publish).toHaveBeenCalledTimes(1));

    ctx.clock.advanceBy({ minutes: POST_STUCK_MS / 60_000 + 1 });
    expect(await sweepStuckPublishes(ctx, ctx.workspace.id)).toBe(1);
    expect(await reload(ctx, post.id)).toMatchObject({ status: "unknown" });

    first.resolve({
      externalId: "urn:li:share:late1",
      url: "https://www.linkedin.com/feed/late1/",
    });
    const after = await running;
    expect(after).toMatchObject({
      status: "published",
      url: "https://www.linkedin.com/feed/late1/",
      publish_attempt: 1,
    });
    const [problem] = await problemsOf(ctx, post.id);
    expect(problem).toMatchObject({ kind: "send_unknown", status: "resolved" });
    expect(ctx.emitted("post.published")).toHaveLength(1);
  });

  it("publishes from the earlier try when the newer one failed before handover", async () => {
    const { ctx, unipile } = await setup();
    const post = await seedPost(ctx);
    const first = deferred<{ externalId: string; url: string }>();
    const second = deferred<{ externalId: string; url: string }>();
    unipile.publish
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const running = publishPost(ctx, post);
    await vi.waitFor(() => expect(unipile.publish).toHaveBeenCalledTimes(1));
    ctx.clock.advanceBy({ minutes: POST_STUCK_MS / 60_000 + 1 });
    await sweepStuckPublishes(ctx, ctx.workspace.id);
    const republished = call(resolveUnknownPost, ctx, { post_id: post.id, outcome: "republish" });
    await vi.waitFor(() => expect(unipile.publish).toHaveBeenCalledTimes(2));

    // The first try went out after all, while the second is still on its way.
    first.resolve({
      externalId: "urn:li:share:first",
      url: "https://www.linkedin.com/feed/first/",
    });
    expect(await running).toMatchObject({ status: "publishing", publish_attempt: 2 });
    second.reject(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
    );
    expect(await republished).toMatchObject({
      status: "published",
      url: "https://www.linkedin.com/feed/first/",
    });
    expect((await problemsOf(ctx, post.id)).map((row) => row.kind)).toEqual(["send_unknown"]);
    expect(ctx.emitted("post.published")).toHaveLength(1);
  });

  it("says a post may have gone out twice when the newer try got no clear answer", async () => {
    const { ctx, unipile } = await setup();
    const post = await seedPost(ctx);
    const first = deferred<{ externalId: string; url: string }>();
    const second = deferred<{ externalId: string; url: string }>();
    unipile.publish
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const running = publishPost(ctx, post);
    await vi.waitFor(() => expect(unipile.publish).toHaveBeenCalledTimes(1));
    ctx.clock.advanceBy({ minutes: POST_STUCK_MS / 60_000 + 1 });
    await sweepStuckPublishes(ctx, ctx.workspace.id);
    const republished = call(resolveUnknownPost, ctx, { post_id: post.id, outcome: "republish" });
    await vi.waitFor(() => expect(unipile.publish).toHaveBeenCalledTimes(2));
    first.resolve({
      externalId: "urn:li:share:first",
      url: "https://www.linkedin.com/feed/first/",
    });
    await running;
    second.reject(providerFailure({ provider: "unipile", class: "timeout" }));
    expect(await republished).toMatchObject({ status: "published" });
    const duplicate = (await problemsOf(ctx, post.id)).find((row) => row.kind === "duplicate_send");
    expect(duplicate).toMatchObject({
      title: "LinkedIn post may have gone out twice",
      data: { attempts: [1, 2], proven: false },
    });
  });
});

describe("posts.resolve_unknown", () => {
  it("records a post found on the profile as published, with its link", async () => {
    const { ctx, unipile } = await setup();
    const post = await unknownPost(ctx, unipile);
    const result = await call(resolveUnknownPost, ctx, {
      post_id: post.id,
      outcome: "published",
      url: "https://www.linkedin.com/feed/update/urn:li:share:found/",
      note: "Seen in the recent activity.",
    });
    expect(result).toMatchObject({
      status: "published",
      url: "https://www.linkedin.com/feed/update/urn:li:share:found/",
      published_at: NOW,
    });
    expect((await problemsOf(ctx, post.id))[0]).toMatchObject({ status: "resolved" });
    expect(ctx.emitted("post.published")).toHaveLength(1);
    // Repeating the same settlement is safe.
    expect(
      await call(resolveUnknownPost, ctx, { post_id: post.id, outcome: "published" }),
    ).toMatchObject({
      status: "published",
    });
    expect(unipile.publish).toHaveBeenCalledTimes(1);
  });

  it("returns a post that is not on the profile to draft", async () => {
    const { ctx, unipile } = await setup();
    const post = await unknownPost(ctx, unipile);
    const result = await call(resolveUnknownPost, ctx, { post_id: post.id, outcome: "cancel" });
    expect(result).toMatchObject({
      status: "draft",
      note: expect.stringContaining("Not published"),
    });
    expect((await problemsOf(ctx, post.id))[0]).toMatchObject({ status: "resolved" });
    await expect(
      call(resolveUnknownPost, ctx, { post_id: post.id, outcome: "republish" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("republishes at once for a human with the approve scope", async () => {
    const { ctx, unipile } = await setup();
    const post = await unknownPost(ctx, unipile);
    const result = await call(resolveUnknownPost, ctx, { post_id: post.id, outcome: "republish" });
    expect(result).toMatchObject({ status: "published" });
    const row = await reload(ctx, post.id);
    expect(row.publish_attempt).toBe(2);
    expect(row.why?.republished_after_unknown).toBe(NOW);
    expect(unipile.publish).toHaveBeenCalledTimes(2);
  });

  it("makes an agent's republish wait for a person; rejecting keeps the post unknown", async () => {
    const { ctx, agent, unipile } = await setup();
    const post = await unknownPost(ctx, unipile);
    const asked = await call(resolveUnknownPost, agent, { post_id: post.id, outcome: "republish" });
    expect(asked).toMatchObject({ status: "awaiting_approval" });
    const approvalId = (asked as { approval_id: string }).approval_id;
    expect(ctx.recorded.approvals[0]?.request).toMatchObject({
      kind: "post",
      payload: { post_id: post.id, action: "republish" },
    });
    expect((await reload(ctx, post.id)).status).toBe("unknown");
    const rejected = await decide(ctx, approvalId, "reject");
    expect(rejected.message).toContain("stays unknown");
    expect((await reload(ctx, post.id)).status).toBe("unknown");
    expect(unipile.publish).toHaveBeenCalledTimes(1);

    const again = await call(resolveUnknownPost, agent, { post_id: post.id, outcome: "republish" });
    const applied = await decide(ctx, (again as { approval_id: string }).approval_id, "approve");
    expect(applied.data).toMatchObject({ status: "published" });
    expect(unipile.publish).toHaveBeenCalledTimes(2);
  });

  it("needs the send scope to republish, and only settles unknown posts", async () => {
    const { ctx, unipile } = await setup();
    const post = await unknownPost(ctx, unipile);
    const noSend = ctx.with({
      principal: {
        type: "human",
        id: "usr_viewer",
        name: "Viewer",
        scopes: ["read", "write", "approve"],
      },
    });
    await expect(
      call(resolveUnknownPost, noSend, { post_id: post.id, outcome: "republish" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      call(resolveUnknownPost, ctx, {
        post_id: post.id,
        outcome: "cancel",
        url: "https://www.linkedin.com/feed/x/",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    const draft = await seedPost(ctx, { status: "draft" });
    await expect(
      call(resolveUnknownPost, ctx, { post_id: draft.id, outcome: "published" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("holds a republish while the workspace is paused and publishes it after resume", async () => {
    const { ctx, unipile } = await setup();
    const post = await unknownPost(ctx, unipile);
    await ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, ctx.workspace.id));
    const result = await call(resolveUnknownPost, ctx, { post_id: post.id, outcome: "republish" });
    expect(result).toMatchObject({ status: "scheduled", scheduled_for: NOW });
    expect(unipile.publish).toHaveBeenCalledTimes(1);
    await ctx.db
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, ctx.workspace.id));
    expect(await runDue(ctx)).toMatchObject({ published: 1 });
    expect(unipile.publish).toHaveBeenCalledTimes(2);
  });
});

describe("posts that may be live are never published again by the normal actions", () => {
  it("refuses publish, schedule, update and cancel of an unknown post, naming resolve_unknown", async () => {
    const { ctx, unipile } = await setup();
    const post = await unknownPost(ctx, unipile);
    const attempts = [
      call(publishPostOp, ctx, { post_id: post.id }),
      call(schedulePost, ctx, { post_id: post.id, scheduled_for: "2026-09-24T14:00:00.000Z" }),
      call(updatePostOp, ctx, { post_id: post.id, body: "New text" }),
      call(cancelPost, ctx, { post_id: post.id }),
    ];
    for (const attempt of attempts) {
      const error = await attempt.catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "conflict", details: { status: "unknown" } });
      expect((error as OpenOutboundError).hint).toContain("resolve_unknown");
    }
    expect(unipile.publish).toHaveBeenCalledTimes(1);
    const listed = await call(listPosts, ctx, { status: ["unknown"] });
    expect(listed.items[0]?.note).toContain("resolve_unknown");
  });

  it("refuses a post that is being published right now", async () => {
    const { ctx, unipile } = await setup();
    const post = await seedPost(ctx, { status: "publishing", publish_attempt: 1 });
    await expect(call(publishPostOp, ctx, { post_id: post.id })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("being published right now"),
    });
    expect(unipile.publish).not.toHaveBeenCalled();
  });

  it("publishes a failed post again: failed means nothing went out", async () => {
    const { ctx, unipile } = await setup();
    const post = await seedPost(ctx);
    unipile.publish.mockRejectedValueOnce(
      providerFailure({ provider: "unipile", class: "refused" }),
    );
    expect((await publishPost(ctx, post)).status).toBe("failed");
    expect(await call(publishPostOp, ctx, { post_id: post.id })).toMatchObject({
      status: "published",
    });
    expect(unipile.publish).toHaveBeenCalledTimes(2);
  });
});

describe("publishing through the real providers behind a fake fetch", () => {
  async function official(answer: () => Promise<Response>) {
    const fetch = (async () => answer()) as typeof globalThis.fetch;
    const publisher = createLinkedInOfficial({
      clientId: "example-client",
      clientSecret: "example-secret",
      config: {
        api_version: "202608",
        scopes: ["openid", "profile", "w_member_social"],
        pkce: false,
      },
      fetch,
      clock: { now: () => new Date(NOW) },
    });
    const ctx = await createTestContext({ db, now: NOW, providers: { social: [publisher] } });
    const secretId = await ctx.vault.putSecret(
      ctx.workspace.id,
      `social:linkedin_official:${MEMBER}`,
      JSON.stringify({ access_token: TOKEN }),
    );
    const [account] = await ctx.db
      .insert(social_accounts)
      .values({
        workspace_id: ctx.workspace.id,
        provider: "linkedin_official",
        external_id: MEMBER,
        name: "Sam Sender",
        secret_id: secretId,
      })
      .returning();
    const post = await seedPost(ctx, {
      account_ref: { provider: "linkedin_official", account_id: MEMBER, secret_id: secretId },
    });
    const after = await publishPost(ctx, post);
    const [stored] = await ctx.db
      .select()
      .from(social_accounts)
      .where(eq(social_accounts.id, account?.id ?? ""));
    return { after, account: stored };
  }

  async function unipileSocial(answer: () => Promise<Response>) {
    const fetch = (async () => answer()) as typeof globalThis.fetch;
    const publisher = createUnipileSocial(
      createUnipileClient({
        dsn: "api1.unipile.example.com:13111",
        apiKey: "test-key",
        fetch,
        timeoutMs: 5_000,
      }),
    );
    const { ctx } = await setup(publisher);
    return publishPost(ctx, await seedPost(ctx));
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  /** An answer whose body breaks off after its first bytes (the connection dropped). */
  const brokenOff = (status: number, headers: Record<string, string> = {}) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"object":'));
          const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
          controller.error(new TypeError("terminated", { cause: socket }));
        },
      }),
      { status, headers: { "content-type": "application/json", ...headers } },
    );

  it("linkedin_official: published with the post's link", async () => {
    const { after } = await official(async () =>
      json(201, {}, { "x-restli-id": "urn:li:share:7380000000000000001" }),
    );
    expect(after).toMatchObject({
      status: "published",
      external_id: "urn:li:share:7380000000000000001",
      url: "https://www.linkedin.com/feed/update/urn:li:share:7380000000000000001/",
    });
  });

  it("linkedin_official: accepted without an id is published, with a note", async () => {
    const { after } = await official(async () => json(201, {}));
    expect(after).toMatchObject({ status: "published", url: null });
    expect(after.why?.publish_note).toBe(ACCEPTED_WITHOUT_ID_NOTE);
  });

  it("linkedin_official: an answer that broke off is published when the post id came first, else unknown", async () => {
    const { after } = await official(async () =>
      brokenOff(201, { "x-restli-id": "urn:li:share:7380000000000000005" }),
    );
    expect(after).toMatchObject({
      status: "published",
      external_id: "urn:li:share:7380000000000000005",
      url: "https://www.linkedin.com/feed/update/urn:li:share:7380000000000000005/",
    });
    const { after: lost } = await official(async () => brokenOff(201));
    expect(lost.status).toBe("unknown");
    const { after: failed } = await official(async () => brokenOff(502));
    expect(failed.status).toBe("unknown");
  });

  it("linkedin_official: a server error after the request is unknown", async () => {
    const { after } = await official(async () => json(503, { message: "Service unavailable" }));
    expect(after.status).toBe("unknown");
  });

  it("linkedin_official: a rejected token fails the post and the account needs connecting", async () => {
    const { after, account } = await official(async () => json(401, { message: "Expired" }));
    expect(after).toMatchObject({ status: "failed" });
    expect(account?.status).toBe("expired");
  });

  it("linkedin_official: refused app credentials make the post wait; the account stays connected", async () => {
    const { after, account } = await official(async () =>
      json(401, { error: "invalid_client", error_description: "Client authentication failed" }),
    );
    expect(after).toMatchObject({ status: "scheduled", publish_attempt: 1 });
    expect(after.scheduled_for?.toISOString()).toBe("2026-09-22T16:00:00.000Z");
    expect(account?.status).toBe("active");
  });

  it("linkedin_official: a connection that never opened is tried again", async () => {
    const { after } = await official(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      });
    });
    expect(after).toMatchObject({ status: "scheduled", publish_attempt: 1 });
  });

  it("unipile: published with the post's link", async () => {
    const after = await unipileSocial(async () =>
      json(201, { object: "PostCreated", post_id: "urn:li:activity:7380000000000000002" }),
    );
    expect(after).toMatchObject({
      status: "published",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7380000000000000002/",
    });
  });

  it("unipile: an answer without an id is published with a note, one that cannot be read is unknown", async () => {
    const accepted = await unipileSocial(async () => json(201, { object: "PostCreated" }));
    expect(accepted).toMatchObject({ status: "published", url: null });
    expect(accepted.why?.publish_note).toBe(ACCEPTED_WITHOUT_ID_NOTE);
    // A 2xx page that is not Unipile's answer may come from something in between: checked by a
    // person, never assumed published and never published again on its own.
    const unreadable = await unipileSocial(
      async () => new Response("<html>ok</html>", { status: 200 }),
    );
    expect(unreadable.status).toBe("unknown");
  });

  it("unipile: a rejected API key makes the post wait", async () => {
    const after = await unipileSocial(async () => json(401, { title: "Unauthorized" }));
    expect(after).toMatchObject({ status: "scheduled", publish_attempt: 1 });
    expect(after.scheduled_for?.toISOString()).toBe("2026-09-22T16:00:00.000Z");
  });

  it("unipile: an answer that broke off is unknown", async () => {
    expect((await unipileSocial(async () => brokenOff(201))).status).toBe("unknown");
    expect((await unipileSocial(async () => brokenOff(502))).status).toBe("unknown");
  });

  it("unipile: a server error is unknown, a rate limit and a refusal are not", async () => {
    expect((await unipileSocial(async () => json(500, { title: "Internal" }))).status).toBe(
      "unknown",
    );
    expect(
      (await unipileSocial(async () => json(429, { type: "errors/too_many_requests" }))).status,
    ).toBe("scheduled");
    expect(
      (await unipileSocial(async () => json(422, { type: "errors/invalid_parameters" }))).status,
    ).toBe("failed");
  });
});

describe("a paused publisher", () => {
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  it("B6 S5 a post waits while its publisher is paused and goes out once it is fixed", async () => {
    const urls: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (url.includes("/oauth/v2/accessToken")) {
        return answer(401, { error: "invalid_client", error_description: "Bad client secret" });
      }
      return answer(201, {}, { "x-restli-id": "urn:li:share:7380000000000000004" });
    }) as typeof globalThis.fetch;
    const ctx = await createTestContext({ db, now: NOW });
    const binding: HealthBinding = {
      store: new Map(),
      workspaceId: ctx.workspace.id,
      slot: "social",
      provider: "linkedin_official",
      name: "LinkedIn (official API)",
      level: "instance",
      settings: "app-credentials-1",
      clock: ctx.clock,
      log: ctx.log,
      context: () => ctx,
    };
    const publisher = trackProviderHealth(
      createLinkedInOfficial({
        clientId: "example-client",
        clientSecret: "example-rotated-secret",
        config: {
          api_version: "202608",
          scopes: ["openid", "profile", "w_member_social"],
          pkce: false,
        },
        fetch,
        clock: ctx.clock,
      }),
      binding,
    );
    ctx.providers.set("social", publisher);
    const secretId = await ctx.vault.putSecret(
      ctx.workspace.id,
      `social:linkedin_official:${MEMBER}`,
      JSON.stringify({ access_token: TOKEN }),
    );
    const [account] = await ctx.db
      .insert(social_accounts)
      .values({
        workspace_id: ctx.workspace.id,
        provider: "linkedin_official",
        external_id: MEMBER,
        name: "Sam Sender",
        secret_id: secretId,
      })
      .returning();
    const post = await seedPost(ctx, {
      status: "scheduled",
      scheduled_for: new Date(NOW),
      account_ref: { provider: "linkedin_official", account_id: MEMBER, secret_id: secretId },
    });
    // Connecting a second account: LinkedIn refuses the app's secret, which pauses the publisher.
    await expect(
      publisher.exchangeCode?.({
        code: "example-code",
        redirectUri: "https://engine.example.com/oauth/linkedin/callback",
      }),
    ).rejects.toMatchObject({ details: { failure: { class: "auth_invalid", scope: "account" } } });

    expect(await runDue(ctx)).toMatchObject({ published: 0, failed: 0, unknown: 0, retrying: 1 });
    const waiting = await reload(ctx, post.id);
    expect(waiting).toMatchObject({ status: "scheduled", publish_attempt: 1 });
    expect(waiting.scheduled_for?.toISOString()).toBe("2026-09-22T16:00:00.000Z");
    expect(waiting.why?.publish_retries).toBeUndefined();
    expect(waiting.why?.failed_before_handover).toBeUndefined();
    const [stored] = await ctx.db
      .select()
      .from(social_accounts)
      .where(eq(social_accounts.id, account?.id ?? ""));
    expect(stored?.status).toBe("active");
    expect(urls.filter((url) => url.includes("/rest/posts"))).toEqual([]);

    // The secret is fixed: the publisher is built again with the new settings.
    binding.settings = "app-credentials-2";
    ctx.clock.advanceBy({ hours: 1 });
    expect(await runDue(ctx)).toMatchObject({ published: 1 });
    expect(await reload(ctx, post.id)).toMatchObject({
      status: "published",
      publish_attempt: 2,
      url: "https://www.linkedin.com/feed/update/urn:li:share:7380000000000000004/",
    });
  });
});
