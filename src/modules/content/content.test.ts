import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { Engine } from "../../core/engine.js";
import { OpenOutboundError } from "../../core/errors.js";
import {
  approvals,
  type NewPost,
  type Post,
  posts,
  social_accounts,
  workspaces,
} from "../../db/schema/index.js";
import type { SocialPublisher } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { seedLinkedInAccount } from "../../testing/factories.js";
import { buildGroundingPack } from "../knowledge/service.js";
import { postApprovalResolver } from "./approval.js";
import { managePosts, module } from "./index.js";
import { decodeOAuthState, linkedinOAuthRoutes, pkceChallenge } from "./oauth.js";
import {
  cancelPost,
  connectPostingAccount,
  draftPosts,
  listPostingAccounts,
  listPosts,
  publishPostOp,
  schedulePost,
  updatePostOp,
} from "./operations.js";
import { type DraftPostVars, draftPostPrompt } from "./prompts/draft-post.js";
import { publishDueJob } from "./publish-job.js";

const knowledge = vi.hoisted(() => ({
  pack: {
    company: { name: "Brightpath Example Co", website: "https://brightpath.example.com" },
    offer: null,
    rules: ["Never promise delivery dates."],
    facts: [
      {
        id: "kno_fact1",
        kind: "proof",
        title: "Onboarding time cut in half",
        body: "A logistics client cut onboarding from 10 to 5 days.",
      },
    ],
    voiceSamples: ["Short sentences. Concrete numbers. No fluff."],
    text: "## Proof\n- A logistics client cut onboarding from 10 to 5 days.",
  },
}));
vi.mock("../knowledge/service.js", () => ({
  buildGroundingPack: vi.fn(async () => knowledge.pack),
}));
vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

const NOW = "2026-09-22T15:00:00.000Z";
const AGENT = { type: "agent" as const, id: "key_agent", name: "Agent" };
const OWNER = { type: "human" as const, id: "usr_owner", name: "Owner" };
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
    authUrl: vi.fn(
      (input: { state: string; redirectUri: string }) =>
        `https://www.linkedin.com/oauth/v2/authorization?state=${input.state}`,
    ),
    exchangeCode: vi.fn(async (_input: { code: string; redirectUri: string }) => ({
      account: { provider: "linkedin_official", account_id: MEMBER, name: "Sam Sender" },
      credentials: { access_token: TOKEN },
      expiresAt: "2026-11-21T15:00:00.000Z",
    })),
  } satisfies SocialPublisher;
}

function draftAnswer(vars: DraftPostVars) {
  return {
    posts: Array.from({ length: vars.count }, (_, index) => ({
      body: `Lesson ${index + 1}: we cut onboarding from 10 to 5 days.\n\nHere is what changed.`,
      pillar: "operations lessons",
      angle: "Concrete onboarding result",
      knowledge_item_ids: ["kno_fact1", "kno_not_in_pack"],
    })),
  };
}

async function setup(over: Parameters<typeof createTestContext>[0] = {}) {
  const official = fakePublisher("linkedin_official");
  const unipile = fakePublisher("unipile");
  const ctx = await createTestContext({
    db,
    now: NOW,
    providers: { social: [official, unipile] },
    brain: { "content.post.draft": draftAnswer },
    ...over,
  });
  return { ctx, official, unipile, agent: ctx.with({ principal: AGENT }) };
}

/** Runs an operation handler and parses its output like the executor does. */
async function call<I, O extends z.ZodType>(
  op: { handler(ctx: TestContext, input: I): Promise<unknown>; output: O; input: z.ZodType<I> },
  ctx: TestContext,
  input: unknown,
): Promise<z.output<O>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input)));
}

async function seedPost(ctx: TestContext, values: Partial<NewPost> = {}): Promise<Post> {
  const [row] = await ctx.db
    .insert(posts)
    .values({
      workspace_id: ctx.workspace.id,
      status: "draft",
      body: "Three lessons from rebuilding our onboarding flow.",
      ...values,
    })
    .returning();
  if (!row) throw new Error("post insert failed");
  return row;
}

async function seedSocialAccount(ctx: TestContext) {
  const secretId = await ctx.vault.putSecret(
    ctx.workspace.id,
    `social:linkedin_official:${MEMBER}`,
    JSON.stringify({ access_token: TOKEN }),
  );
  const [row] = await ctx.db
    .insert(social_accounts)
    .values({
      workspace_id: ctx.workspace.id,
      provider: "linkedin_official",
      external_id: MEMBER,
      name: "Sam Sender",
      secret_id: secretId,
    })
    .returning();
  if (!row) throw new Error("social account insert failed");
  return row;
}

async function reload(ctx: TestContext, id: string): Promise<Post> {
  const [row] = await ctx.db.select().from(posts).where(eq(posts.id, id));
  if (!row) throw new Error(`post ${id} not found`);
  return row;
}

async function decide(
  ctx: TestContext,
  approvalId: string,
  decision: "approve" | "reject" | "edit",
  extra: { edits?: Record<string, unknown>; note?: string } = {},
) {
  const [approval] = await ctx.db.select().from(approvals).where(eq(approvals.id, approvalId));
  if (!approval) throw new Error(`approval ${approvalId} not found`);
  return postApprovalResolver.apply(ctx, approval, { decision, decidedBy: OWNER, ...extra });
}

function awaitingId(result: unknown): string {
  const record = result as { status?: string; approval_id?: string };
  expect(record.status).toBe("awaiting_approval");
  return record.approval_id ?? "";
}

const runDue = (ctx: TestContext) =>
  publishDueJob.handler(ctx.jobContext({ name: "content.publish_due" }), {});
/** A `content.publish_due` run that did nothing. */
const NONE = { published: 0, failed: 0, unknown: 0, retrying: 0 };

describe("module registration", () => {
  it("maps every manage_posts action and schedules the publish job", () => {
    const ids = new Set(module.operations?.map((op) => op.id));
    for (const id of Object.values(managePosts.actions ?? {})) expect(ids.has(id)).toBe(true);
    expect(module.schedules?.[0]).toMatchObject({
      cron: "*/5 * * * *",
      job: "content.publish_due",
      perWorkspace: true,
    });
    expect(module.approvalResolvers?.map((resolver) => resolver.kind)).toEqual(["post"]);
    expect(draftPostPrompt).toMatchObject({ id: "content.post.draft", tier: "standard" });
  });
});

describe("drafting", () => {
  it("drafts from the grounding pack, pillars, voice and recent posts", async () => {
    const { ctx } = await setup();
    await ctx.db
      .update(workspaces)
      .set({ settings: { content: { pillars: ["operations lessons", "hiring"] } } as never })
      .where(eq(workspaces.id, ctx.workspace.id));
    await seedPost(ctx, { pillar: "customer stories", body: "Why our clients stay.\nMore text." });

    const result = await call(draftPosts, ctx, { topic: "onboarding", count: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      status: "draft",
      pillar: "operations lessons",
      angle: "Concrete onboarding result",
      account: null,
    });
    const row = await reload(ctx, result.items[0]?.id ?? "");
    // Only ids from the pack are kept as sources.
    expect(row.why?.knowledge_item_ids).toEqual(["kno_fact1"]);

    expect(vi.mocked(buildGroundingPack)).toHaveBeenLastCalledWith(ctx, {
      offerId: null,
      maxChars: 6000,
      query: "onboarding",
    });
    const [brainCall] = ctx.brain.calls;
    expect(brainCall?.promptId).toBe("content.post.draft");
    expect(brainCall?.vars).toMatchObject({
      company_name: "Brightpath Example Co",
      pillars: ["operations lessons", "hiring", "customer stories"],
      topic: "onboarding",
      grounding: knowledge.pack.text,
      fact_index: ["[kno_fact1] Onboarding time cut in half"],
      voice_samples: ["Short sentences. Concrete numbers. No fluff."],
      recent_posts: ["Why our clients stay."],
      count: 2,
      length: "short",
    });
    expect(brainCall?.user).toContain("<knowledge>");
  });

  it("keeps the requested pillar and attaches the chosen account", async () => {
    const { ctx } = await setup();
    const account = await seedLinkedInAccount(ctx, {
      provider: "unipile",
      external_account_id: "uni_acc_Sam01Example",
    });
    const result = await call(draftPosts, ctx, { pillar: "hiring", account_id: account.id });
    expect(result.items[0]).toMatchObject({
      pillar: "hiring",
      account: { provider: "unipile", account_id: "uni_acc_Sam01Example", name: "Sam Sender" },
    });
  });
});

describe("scheduling and publishing", () => {
  it("waits for approval on agent schedules, then publishes once when due", async () => {
    const { ctx, agent, official } = await setup();
    const account = await seedSocialAccount(ctx);
    const post = await seedPost(ctx, { pillar: "operations lessons" });

    const result = await call(schedulePost, agent, {
      post_id: post.id,
      scheduled_for: "2026-09-23T14:00:00.000Z",
    });
    const approvalId = awaitingId(result);
    const pending = await reload(ctx, post.id);
    expect(pending).toMatchObject({ status: "pending_review" });
    expect(pending.account_ref).toMatchObject({
      provider: "linkedin_official",
      account_id: MEMBER,
      secret_id: account.secret_id,
    });
    expect(ctx.recorded.approvals[0]?.request).toMatchObject({
      kind: "post",
      payload: { post_id: post.id, action: "schedule" },
      target: { type: "post", id: post.id },
    });

    const applied = await decide(ctx, approvalId, "approve");
    expect(applied.message).toBe("Post scheduled for 2026-09-23T14:00:00.000Z.");
    expect(await reload(ctx, post.id)).toMatchObject({ status: "scheduled" });

    expect(await runDue(ctx)).toEqual(NONE);
    ctx.clock.advanceBy({ days: 1 });
    expect(await runDue(ctx)).toEqual({ ...NONE, published: 1 });
    expect(official.publish).toHaveBeenCalledTimes(1);
    expect(official.publish.mock.calls[0]?.[0]).toEqual({
      accountRef: { provider: "linkedin_official", account_id: MEMBER, name: "Sam Sender" },
      text: post.body,
      credentials: { access_token: TOKEN },
      // The job's signal: the call stops when the job is cancelled or runs out of time.
      signal: expect.any(AbortSignal),
    });
    const published = await reload(ctx, post.id);
    expect(published).toMatchObject({
      status: "published",
      url: "https://www.linkedin.com/feed/update/urn:li:share:linkedin_official/",
    });
    expect(published.external_id).toMatch(/^urn:li:share:/);
    expect(ctx.emitted("post.published")).toHaveLength(1);

    // Repeat runs and repeat decisions never publish twice.
    expect(await runDue(ctx)).toEqual(NONE);
    expect((await decide(ctx, approvalId, "approve")).message).toContain("nothing to apply");
    expect(official.publish).toHaveBeenCalledTimes(1);
  });

  it("lets a human with the approve scope publish directly", async () => {
    const { ctx, unipile } = await setup();
    await seedLinkedInAccount(ctx, {
      provider: "unipile",
      external_account_id: "uni_acc_Sam01Example",
    });
    const post = await seedPost(ctx);
    const result = await call(publishPostOp, ctx, { post_id: post.id });
    expect(result).toMatchObject({
      status: "published",
      account: { provider: "unipile", account_id: "uni_acc_Sam01Example" },
    });
    expect(ctx.recorded.approvals).toHaveLength(0);
    expect(unipile.publish).toHaveBeenCalledTimes(1);

    // Publishing again returns the published post without a second call.
    expect(await call(publishPostOp, ctx, { post_id: post.id })).toMatchObject({
      status: "published",
    });
    expect(unipile.publish).toHaveBeenCalledTimes(1);
  });

  it("publishes right after approval when an agent asks to publish now", async () => {
    const { ctx, agent, official } = await setup();
    await seedSocialAccount(ctx);
    const post = await seedPost(ctx);
    const approvalId = awaitingId(await call(publishPostOp, agent, { post_id: post.id }));
    expect(official.publish).not.toHaveBeenCalled();
    const applied = await decide(ctx, approvalId, "approve");
    expect(applied.data).toMatchObject({ status: "published" });
    expect(official.publish).toHaveBeenCalledTimes(1);
  });

  it("publishes the reviewer's edited text", async () => {
    const { ctx, agent, official } = await setup();
    await seedSocialAccount(ctx);
    const post = await seedPost(ctx);
    const approvalId = awaitingId(await call(publishPostOp, agent, { post_id: post.id }));
    await decide(ctx, approvalId, "edit", { edits: { body: "Edited: two lessons, not three." } });
    expect(official.publish.mock.calls[0]?.[0].text).toBe("Edited: two lessons, not three.");
    expect(await reload(ctx, post.id)).toMatchObject({
      status: "published",
      body: "Edited: two lessons, not three.",
    });
  });

  it("returns rejected posts to draft with the reviewer's note", async () => {
    const { ctx, agent, official } = await setup();
    await seedSocialAccount(ctx);
    const post = await seedPost(ctx);
    const approvalId = awaitingId(
      await call(schedulePost, agent, {
        post_id: post.id,
        scheduled_for: "2026-09-24T14:00:00.000Z",
      }),
    );
    const applied = await decide(ctx, approvalId, "reject", { note: "Too salesy" });
    expect(applied.message).toBe("Post returned to draft.");
    expect(await reload(ctx, post.id)).toMatchObject({
      status: "draft",
      scheduled_for: null,
      error: "rejected: Too salesy",
    });
    expect(official.publish).not.toHaveBeenCalled();
  });

  it("holds approved posts while the workspace is paused and sends them after resume", async () => {
    const { ctx, agent, official } = await setup();
    await seedSocialAccount(ctx);
    const post = await seedPost(ctx);
    const approvalId = awaitingId(await call(publishPostOp, agent, { post_id: post.id }));
    await ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, ctx.workspace.id));
    const applied = await decide(ctx, approvalId, "approve");
    expect(applied.data).toMatchObject({ status: "scheduled" });
    expect(official.publish).not.toHaveBeenCalled();
    expect(await runDue(ctx)).toMatchObject({ published: 0, skipped: "workspace_paused" });

    await ctx.db
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, ctx.workspace.id));
    expect(await runDue(ctx)).toEqual({ ...NONE, published: 1 });
    expect(official.publish).toHaveBeenCalledTimes(1);
  });

  it("marks the post failed on provider errors and flags expired tokens", async () => {
    const { ctx, official } = await setup();
    const account = await seedSocialAccount(ctx);
    const post = await seedPost(ctx);
    official.publish.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "LinkedIn post failed (401)", {
        details: { provider: "linkedin_official", expired: true },
      }),
    );
    const result = await call(publishPostOp, ctx, { post_id: post.id });
    expect(result).toMatchObject({ status: "failed", error: "LinkedIn post failed (401)" });
    expect((await reload(ctx, post.id)).published_at).toBeNull();
    const [row] = await ctx.db
      .select()
      .from(social_accounts)
      .where(eq(social_accounts.id, account.id));
    expect(row?.status).toBe("expired");
    expect(ctx.emitted("post.published")).toHaveLength(0);
  });

  it("fails due posts whose LinkedIn account is no longer active", async () => {
    const { ctx, unipile } = await setup();
    await seedLinkedInAccount(ctx, {
      provider: "unipile",
      external_account_id: "uni_acc_Paused01",
      status: "restricted",
    });
    const post = await seedPost(ctx, {
      status: "scheduled",
      scheduled_for: new Date("2026-09-22T14:00:00.000Z"),
      account_ref: { provider: "unipile", account_id: "uni_acc_Paused01" },
    });
    expect(await runDue(ctx)).toEqual({ ...NONE, failed: 1 });
    expect(await reload(ctx, post.id)).toMatchObject({
      status: "failed",
      error: "LinkedIn account is restricted",
    });
    expect(unipile.publish).not.toHaveBeenCalled();
  });

  it("skips due posts while the workspace is paused", async () => {
    const { ctx, official } = await setup();
    await seedSocialAccount(ctx);
    const post = await seedPost(ctx, {
      status: "scheduled",
      scheduled_for: new Date("2026-09-22T14:00:00.000Z"),
      account_ref: { provider: "linkedin_official", account_id: MEMBER },
    });
    await ctx.db
      .update(workspaces)
      .set({ status: "paused" })
      .where(eq(workspaces.id, ctx.workspace.id));
    expect(await runDue(ctx)).toEqual({ ...NONE, skipped: "workspace_paused" });
    expect((await reload(ctx, post.id)).status).toBe("scheduled");
    expect(official.publish).not.toHaveBeenCalled();
  });

  it("previews a publish with dry_run", async () => {
    const { ctx, official } = await setup();
    await seedSocialAccount(ctx);
    const post = await seedPost(ctx);
    const preview = await call(publishPostOp, ctx.with({ request: { dryRun: true } }), {
      post_id: post.id,
    });
    expect(preview).toMatchObject({
      dry_run: true,
      preview: {
        post_id: post.id,
        account: "Sam Sender",
        characters: post.body.length,
        needs_approval: false,
      },
    });
    expect((await reload(ctx, post.id)).status).toBe("draft");
    expect(official.publish).not.toHaveBeenCalled();
  });

  it("rejects past times, empty posts and missing accounts", async () => {
    const { ctx } = await setup();
    const post = await seedPost(ctx);
    await expect(
      call(schedulePost, ctx, { post_id: post.id, scheduled_for: "2026-09-22T14:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "scheduled_for" } });
    await expect(call(publishPostOp, ctx, { post_id: post.id })).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "account_id" },
    });
    await seedSocialAccount(ctx);
    const empty = await seedPost(ctx, { body: "   " });
    await expect(call(publishPostOp, ctx, { post_id: empty.id })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("editing and cancelling", () => {
  it("renews the approval when a pending post moves, and voids it when the text changes", async () => {
    const { ctx, agent } = await setup();
    await seedSocialAccount(ctx);
    const post = await seedPost(ctx);
    const firstId = awaitingId(
      await call(schedulePost, agent, {
        post_id: post.id,
        scheduled_for: "2026-09-24T14:00:00.000Z",
      }),
    );
    const moved = await call(updatePostOp, agent, {
      post_id: post.id,
      scheduled_for: "2026-09-25T14:00:00.000Z",
    });
    expect(moved.post).toMatchObject({
      status: "pending_review",
      scheduled_for: "2026-09-25T14:00:00.000Z",
    });
    expect(moved.warnings).toEqual(["The approval request was renewed with the new time."]);
    const status = async (id: string) =>
      (await ctx.db.select().from(approvals).where(eq(approvals.id, id)))[0]?.status;
    expect(await status(firstId)).toBe("cancelled");
    const secondId = ctx.recorded.approvals[1]?.id ?? "";
    expect(ctx.recorded.approvals[1]?.request.payload).toMatchObject({
      scheduled_for: "2026-09-25T14:00:00.000Z",
    });
    expect((await decide(ctx, secondId, "approve")).message).toBe(
      "Post scheduled for 2026-09-25T14:00:00.000Z.",
    );

    const edited = await call(updatePostOp, agent, { post_id: post.id, body: "New first line." });
    expect(edited.post).toMatchObject({ status: "draft", body: "New first line." });
    expect(edited.warnings).toHaveLength(1);
    await expect(
      call(updatePostOp, ctx, { post_id: post.id, scheduled_for: "2026-09-22T14:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("voids the review when a scheduled post changes account", async () => {
    const { ctx } = await setup();
    await seedSocialAccount(ctx);
    const account = await seedLinkedInAccount(ctx, {
      provider: "unipile",
      external_account_id: "uni_acc_Other01",
    });
    const post = await seedPost(ctx, {
      status: "scheduled",
      scheduled_for: new Date("2026-09-24T14:00:00.000Z"),
      account_ref: { provider: "linkedin_official", account_id: MEMBER },
    });
    const same = await call(updatePostOp, ctx, { post_id: post.id, pillar: "hiring" });
    expect(same).toMatchObject({ post: { status: "scheduled", pillar: "hiring" }, warnings: [] });
    const changed = await call(updatePostOp, ctx, { post_id: post.id, account_id: account.id });
    expect(changed.post).toMatchObject({
      status: "draft",
      account: { provider: "unipile", account_id: "uni_acc_Other01" },
    });
    expect(changed.warnings).toHaveLength(1);
  });

  it("cancels a scheduled post back to draft and refuses published ones", async () => {
    const { ctx } = await setup();
    const scheduled = await seedPost(ctx, {
      status: "scheduled",
      scheduled_for: new Date("2026-09-24T14:00:00.000Z"),
    });
    expect(await call(cancelPost, ctx, { post_id: scheduled.id })).toMatchObject({
      status: "draft",
      scheduled_for: null,
    });
    const published = await seedPost(ctx, { status: "published", published_at: new Date(NOW) });
    await expect(call(cancelPost, ctx, { post_id: published.id })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      call(updatePostOp, ctx, { post_id: published.id, body: "Changed" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("lists posts by status and the accounts that can publish", async () => {
    const { ctx } = await setup();
    await seedPost(ctx, { status: "scheduled", scheduled_for: new Date("2026-09-24T14:00:00Z") });
    await seedPost(ctx);
    const drafts = await call(listPosts, ctx, { status: ["draft"] });
    expect(drafts.items.map((item) => item.status)).toEqual(["draft"]);

    await seedSocialAccount(ctx);
    await seedLinkedInAccount(ctx, { provider: "unipile" });
    await seedLinkedInAccount(ctx, { provider: "unipile", status: "paused" });
    const accounts = await call(listPostingAccounts, ctx, {});
    expect(accounts.items.map((item) => [item.kind, item.provider])).toEqual([
      ["social", "linkedin_official"],
      ["linkedin", "unipile"],
    ]);
  });
});

describe("linkedin_official OAuth", () => {
  async function oauthSetup() {
    const s = await setup();
    const link = await call(connectPostingAccount, s.ctx, {});
    const state = new URL(link.auth_url).searchParams.get("state") ?? "";
    const engine = {
      config: s.ctx.config,
      db: s.ctx.db,
      systemContext: async () => s.ctx,
    } as unknown as Engine;
    const hono = new Hono();
    linkedinOAuthRoutes(hono, { engine });
    return { ...s, link, state, hono };
  }

  it("issues a 15 minute signed state with a PKCE verifier", async () => {
    const { ctx, link, state } = await oauthSetup();
    expect(link.auth_url.startsWith(`${ctx.config.baseUrl}/oauth/linkedin/start?state=`)).toBe(
      true,
    );
    expect(link.expires_at).toBe("2026-09-22T15:15:00.000Z");
    const decoded = decodeOAuthState(ctx.vault, state, ctx.clock.now());
    expect(decoded?.ws).toBe(ctx.workspace.id);
    expect(decoded?.v.length).toBeGreaterThan(40);
    expect(decodeOAuthState(ctx.vault, state, new Date("2026-09-22T15:16:00.000Z"))).toBeNull();
    const tampered = `${state.slice(0, 40)}${state[40] === "A" ? "B" : "A"}${state.slice(41)}`;
    expect(decodeOAuthState(ctx.vault, tampered, ctx.clock.now())).toBeNull();
  });

  it("redirects to LinkedIn and stores the account from the callback", async () => {
    const { ctx, official, state, hono } = await oauthSetup();
    const start = await hono.request(`/oauth/linkedin/start?state=${state}`);
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe(
      `https://www.linkedin.com/oauth/v2/authorization?state=${state}`,
    );
    const verifier = decodeOAuthState(ctx.vault, state, ctx.clock.now())?.v ?? "";
    expect(official.authUrl.mock.calls[0]?.[0]).toEqual({
      state,
      redirectUri: `${ctx.config.baseUrl}/oauth/linkedin/callback`,
      codeChallenge: pkceChallenge(verifier),
    });

    const callback = await hono.request(`/oauth/linkedin/callback?code=code-1&state=${state}`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("LinkedIn connected");
    expect(official.exchangeCode.mock.calls[0]?.[0]).toMatchObject({
      code: "code-1",
      codeVerifier: verifier,
    });
    const rows = await ctx.db
      .select()
      .from(social_accounts)
      .where(eq(social_accounts.workspace_id, ctx.workspace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "linkedin_official",
      external_id: MEMBER,
      name: "Sam Sender",
      status: "active",
    });
    expect(rows[0]?.expires_at?.toISOString()).toBe("2026-11-21T15:00:00.000Z");
    expect(ctx.recorded.audit).toContainEqual(
      expect.objectContaining({
        operation: "posts.accounts.oauth_callback",
        target: { type: "social_account", id: rows[0]?.id },
      }),
    );
    const secret = await ctx.vault.getSecret(rows[0]?.secret_id ?? "", ctx.workspace.id);
    expect(JSON.parse(secret ?? "{}")).toEqual({ access_token: TOKEN });

    // Connecting the same member again updates the row instead of adding one.
    await hono.request(`/oauth/linkedin/callback?code=code-2&state=${state}`);
    const again = await ctx.db
      .select()
      .from(social_accounts)
      .where(eq(social_accounts.workspace_id, ctx.workspace.id));
    expect(again).toHaveLength(1);
  });

  it("refuses bad states, LinkedIn errors and failed exchanges", async () => {
    const { official, state, hono } = await oauthSetup();
    expect((await hono.request("/oauth/linkedin/start?state=forged")).status).toBe(400);
    expect((await hono.request("/oauth/linkedin/callback?code=c&state=forged")).status).toBe(400);
    const denied = await hono.request(
      `/oauth/linkedin/callback?error=user_cancelled_login&error_description=Cancelled&state=${state}`,
    );
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("Cancelled");
    official.exchangeCode.mockRejectedValueOnce(new Error("token exchange failed"));
    const failed = await hono.request(`/oauth/linkedin/callback?code=c&state=${state}`);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("token exchange failed");
  });
});
