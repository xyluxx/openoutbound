/** Post operations (MCP tool `manage_posts`, toolset content). */
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { POST_STATUSES } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import {
  awaitingApproval,
  awaitingApprovalOutput,
  dateTimeInput,
  defineOperation,
  dryRun,
  dryRunOutput,
  isoDateTime,
  paginated,
  paginationInput,
} from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import { linkedin_accounts, type Post, posts, social_accounts } from "../../db/schema/index.js";
import { buildGroundingPack } from "../knowledge/service.js";
import { loadWorkspace } from "../linkedin/accounts.js";
import { encodeOAuthState, OAUTH_STATE_TTL_MS } from "./oauth.js";
import {
  needsApproval,
  noAccountError,
  POST_MAX_CHARS,
  postChanged,
  postOutput,
  requirePost,
  resolveAccountRef,
  settingsPillars,
  toPostOutput,
} from "./posts.js";
import { draftPostPrompt } from "./prompts/draft-post.js";
import { publishPost, whyForNewRequest } from "./publish.js";
import { resolveUnknownPost } from "./resolve-unknown.js";

const postId = idSchema("pst").describe("Post id (pst_...)");
const accountId = z
  .string()
  .regex(/^(sac|lia)_[0-9a-hjkmnp-tv-z]{26}$/)
  .describe(
    "Posting account: sac_... (connected with connect_account) or lia_... (LinkedIn account)",
  );

function checkBody(body: string): void {
  if (!body.trim()) {
    throw new OpenOutboundError("validation_failed", "The post is empty.", {
      hint: "Write the text with manage_posts action update (body).",
    });
  }
  if (body.length > POST_MAX_CHARS) {
    throw new OpenOutboundError(
      "validation_failed",
      `The post is longer than ${POST_MAX_CHARS} characters.`,
      {
        hint: "Shorten it with manage_posts action update.",
        details: { length: body.length },
      },
    );
  }
}

/** Writes `values` only while the post still has the status it was read with. */
async function updatePost(ctx: OpContext, post: Post, values: Partial<Post>): Promise<Post> {
  const [row] = await ctx.db
    .update(posts)
    .set(values)
    .where(
      and(
        eq(posts.id, post.id),
        eq(posts.workspace_id, post.workspace_id),
        eq(posts.status, post.status),
      ),
    )
    .returning();
  if (row) return row;
  const [now] = await ctx.db
    .select({ status: posts.status })
    .from(posts)
    .where(and(eq(posts.id, post.id), eq(posts.workspace_id, post.workspace_id)));
  throw postChanged(post, now?.status ?? "deleted");
}

/**
 * Refuses a post that may be live already (`unknown`: settle it first) or is being handed to
 * LinkedIn right now (`publishing`).
 */
function refuseUnsettled(post: Post, outcome: string): void {
  if (post.status === "unknown") {
    throw new OpenOutboundError(
      "conflict",
      `Post ${post.id} may already be live: its last publish got no clear answer (status unknown).`,
      {
        hint: `Look at the profile on LinkedIn, then settle it with manage_posts action resolve_unknown (post_id ${post.id}, outcome ${outcome}).`,
        details: { status: post.status },
      },
    );
  }
  if (post.status === "publishing") {
    throw new OpenOutboundError("conflict", `Post ${post.id} is being published right now.`, {
      hint: "Wait a minute, then check it with manage_posts action list.",
      details: { status: post.status },
    });
  }
}

// --- list ------------------------------------------------------------------------------------

export const listPosts = defineOperation({
  id: "posts.list",
  summary: "List LinkedIn posts (drafts, scheduled, published)",
  description:
    "Lists the workspace's LinkedIn posts, newest first, with status, pillar, account, schedule and published URL. Use it to review drafts before scheduling or to check what went out. Approvals for pending posts are handled in review_items. Failed posts show the provider error in `error`; unknown posts (the publish got no clear answer) wait for manage_posts action resolve_unknown, and `note` says what to do.",
  effect: "read",
  input: paginationInput.extend({
    status: z.array(z.enum(POST_STATUSES)).optional().describe("Any of these statuses"),
    pillar: z.string().optional(),
  }),
  output: paginated(postOutput),
  http: { method: "GET", path: "/v1/posts" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Drafts", input: { status: ["draft"] } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [eq(posts.workspace_id, workspace.id)];
    if (input.status?.length) conditions.push(inArray(posts.status, input.status));
    if (input.pillar) conditions.push(eq(posts.pillar, input.pillar));
    if (input.cursor)
      conditions.push(lt(posts.id, String(decodeCursor<{ id: string }>(input.cursor).id)));
    const rows = await ctx.db
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(desc(posts.id))
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({ id: row.id }), toPostOutput);
  },
});

// --- draft -----------------------------------------------------------------------------------

export const draftPosts = defineOperation({
  id: "posts.draft",
  summary: "Draft LinkedIn posts with AI from the knowledge base",
  description:
    "Writes 1-5 LinkedIn post drafts from the knowledge base, content pillars (settings content.pillars or earlier posts) and voice samples, and saves them as drafts. Use it to keep the founder's profile active between campaigns; nothing is published until a draft is scheduled or published and approved. For outreach comments on prospects' posts use campaign steps instead. The AI only uses facts from the knowledge base, so add proof and stories there first.",
  effect: "write",
  input: z.object({
    topic: z.string().max(500).optional().describe("What the post should be about"),
    pillar: z.string().max(80).optional().describe("Content pillar, e.g. 'forecasting lessons'"),
    instructions: z.string().max(2000).optional(),
    count: z.number().int().min(1).max(5).default(1),
    length: z.enum(["short", "medium", "long"]).default("short"),
    offer_id: idSchema("off").optional().describe("Ground the post in this offer"),
    account_id: accountId
      .optional()
      .describe("Posting account to attach (default: decided at scheduling)"),
  }),
  output: z.object({ items: z.array(postOutput) }),
  http: { method: "POST", path: "/v1/posts/draft" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Two drafts on one pillar",
      input: { pillar: "inventory planning lessons", count: 2 },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = await loadWorkspace(ctx, requireWorkspace(ctx).id);
    const settings = parseWorkspaceSettings(workspace.settings);
    const accountRef = input.account_id
      ? await resolveAccountRef(ctx, workspace, input.account_id)
      : null;
    const pack = await buildGroundingPack(ctx, {
      offerId: input.offer_id ?? null,
      maxChars: 6000,
      ...(input.topic || input.pillar ? { query: input.topic ?? input.pillar ?? "" } : {}),
    });
    const recent = await ctx.db
      .select({ body: posts.body, pillar: posts.pillar })
      .from(posts)
      .where(eq(posts.workspace_id, workspace.id))
      .orderBy(desc(posts.created_at))
      .limit(15);
    const pillars = [
      ...new Set([
        ...settingsPillars(workspace),
        ...recent.map((row) => row.pillar).filter((p): p is string => Boolean(p)),
      ]),
    ].slice(0, 8);
    const result = await ctx.brain.run(draftPostPrompt, {
      company_name: pack.company.name ?? settings.company.name,
      language: settings.ai.language,
      tone_notes: settings.ai.tone_notes,
      pillar: input.pillar ?? null,
      pillars,
      topic: input.topic ?? null,
      instructions: input.instructions ?? null,
      grounding: pack.text,
      fact_index: pack.facts.map((fact) => `[${fact.id}] ${fact.title}`),
      voice_samples: pack.voiceSamples.slice(0, 3),
      recent_posts: recent
        .map((row) => row.body.split("\n")[0]?.slice(0, 140) ?? "")
        .filter(Boolean),
      count: input.count,
      length: input.length,
    });
    const knownIds = new Set(pack.facts.map((fact) => fact.id));
    const created: Post[] = [];
    for (const draft of result.output.posts.slice(0, input.count)) {
      const [row] = await ctx.db
        .insert(posts)
        .values({
          workspace_id: workspace.id,
          status: "draft",
          body: draft.body.trim(),
          pillar: input.pillar ?? draft.pillar,
          account_ref: accountRef,
          why: {
            angle: draft.angle,
            knowledge_item_ids: draft.knowledge_item_ids.filter((id) => knownIds.has(id)),
            offer_id: input.offer_id ?? null,
          },
        })
        .returning();
      if (row) created.push(row);
    }
    return { items: created.map(toPostOutput) };
  },
});

// --- update ----------------------------------------------------------------------------------

export const updatePostOp = defineOperation({
  id: "posts.update",
  summary: "Edit a post's text, pillar, account or schedule",
  description:
    "Edits a post that is not published yet. Use it to fix the AI draft before approval or to move the publish time. Changing the text or the account of a post that is waiting for review, approved or scheduled sends it back to draft (its approval no longer covers it); schedule or publish it again. Moving the time of a post waiting for review renews its approval request; moving the time of an approved post schedules it for that time. Published posts cannot be edited here.",
  effect: "write",
  input: z.object({
    post_id: postId,
    body: z.string().max(POST_MAX_CHARS).optional(),
    pillar: z.string().max(80).nullable().optional(),
    account_id: accountId.nullable().optional().describe("null detaches the account"),
    scheduled_for: dateTimeInput().optional().describe("New time for a scheduled post (ISO 8601)"),
  }),
  output: z.object({ post: postOutput, warnings: z.array(z.string()) }),
  http: { method: "PATCH", path: "/v1/posts/:post_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Fix the text",
      input: { post_id: "pst_01k6a3v0q8x3m2n4p5r6s7t8v9", body: "New first line..." },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const post = await requirePost(ctx, workspace.id, input.post_id);
    if (post.status === "published") {
      throw new OpenOutboundError("conflict", "The post is already published.", {
        hint: "Edit it on LinkedIn directly; draft a new post for new text.",
      });
    }
    refuseUnsettled(post, "published, republish or cancel");
    if (input.scheduled_for && input.scheduled_for.getTime() <= ctx.clock.now().getTime()) {
      throw new OpenOutboundError("validation_failed", "scheduled_for is in the past.", {
        hint: "Pass a future time, or use manage_posts action publish to post now.",
        details: { field: "scheduled_for" },
      });
    }
    const values: Partial<Post> = {};
    const warnings: string[] = [];
    /** Text or account changes void the review. */
    let reviewed = false;
    if (input.pillar !== undefined) values.pillar = input.pillar;
    if (input.account_id !== undefined) {
      const ref = input.account_id
        ? await resolveAccountRef(ctx, workspace, input.account_id)
        : null;
      values.account_ref = ref;
      if (ref?.provider !== post.account_ref?.provider) reviewed = true;
      if (ref?.account_id !== post.account_ref?.account_id) reviewed = true;
    }
    if (input.scheduled_for !== undefined) values.scheduled_for = input.scheduled_for;
    if (input.body !== undefined && input.body !== post.body) {
      checkBody(input.body);
      values.body = input.body;
      reviewed = true;
    }
    if (reviewed && post.status !== "draft") {
      values.status = "draft";
      values.why = whyForNewRequest(post.why);
      await ctx.approvals.cancel({ target: { type: "post", id: post.id } }, "post edited");
      warnings.push(
        "The text or account changed after review: the post is a draft again. Schedule or publish it again.",
      );
    } else if (post.status === "approved" && input.scheduled_for !== undefined) {
      // Approved but not out yet (a run stopped before publishing it): its approval still covers
      // the text, and it now waits for the new time instead of going out at once.
      values.status = "scheduled";
      warnings.push("The approved post now waits for the new time.");
    }
    let row = Object.keys(values).length ? await updatePost(ctx, post, values) : post;
    const moved =
      input.scheduled_for !== undefined &&
      input.scheduled_for.getTime() !== post.scheduled_for?.getTime();
    if (row.status === "pending_review" && moved && input.scheduled_for) {
      // The pending request names the old time: ask again with the new one.
      await requestPostApproval(ctx, row, "schedule", input.scheduled_for);
      row = await requirePost(ctx, workspace.id, post.id);
      warnings.push("The approval request was renewed with the new time.");
    }
    return { post: toPostOutput(row), warnings };
  },
});

// --- schedule / publish ----------------------------------------------------------------------

async function requestPostApproval(
  ctx: OpContext,
  post: Post,
  action: "schedule" | "publish",
  scheduledFor: Date | null,
) {
  await ctx.approvals.cancel(
    { target: { type: "post", id: post.id } },
    "replaced by a new request",
  );
  const when = scheduledFor ? `on ${scheduledFor.toISOString()}` : "right after approval";
  const summary = `Publish on LinkedIn as ${post.account_ref?.name ?? post.account_ref?.account_id ?? "the default account"} ${when}: "${post.body.slice(0, 160)}${post.body.length > 160 ? "..." : ""}"`;
  const { id } = await ctx.approvals.request({
    kind: "post",
    title: `LinkedIn post${post.pillar ? ` (${post.pillar})` : ""}`,
    summary,
    payload: {
      post_id: post.id,
      action,
      scheduled_for: scheduledFor?.toISOString() ?? null,
      body: post.body,
    },
    target: { type: "post", id: post.id },
  });
  await updatePost(ctx, post, { status: "pending_review", scheduled_for: scheduledFor });
  return awaitingApproval(id, summary);
}

export const schedulePost = defineOperation({
  id: "posts.schedule",
  summary: "Schedule a post for a future time (approval by default)",
  description:
    "Schedules a draft for publishing at a future time on the chosen or default account. Requests are sent for human approval (kind post) unless a human with the approve scope asks; the post publishes automatically at its time once approved. Use publish to post right away. Posts go out only while the workspace is active.",
  effect: "write",
  input: z.object({
    post_id: postId,
    scheduled_for: dateTimeInput().describe("When to publish (ISO 8601, in the future)"),
    account_id: accountId.optional(),
  }),
  output: z.union([postOutput, awaitingApprovalOutput]),
  http: { method: "POST", path: "/v1/posts/:post_id/schedule" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Tuesday morning",
      input: {
        post_id: "pst_01k6a3v0q8x3m2n4p5r6s7t8v9",
        scheduled_for: "2026-09-29T08:30:00-05:00",
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = await loadWorkspace(ctx, requireWorkspace(ctx).id);
    const post = await requirePost(ctx, workspace.id, input.post_id);
    if (post.status === "published") {
      throw new OpenOutboundError("conflict", "The post is already published.", {
        hint: "Draft a new post.",
      });
    }
    refuseUnsettled(post, "republish");
    if (input.scheduled_for.getTime() <= ctx.clock.now().getTime()) {
      throw new OpenOutboundError("validation_failed", "scheduled_for is in the past.", {
        hint: "Pass a future time, or use manage_posts action publish to post now.",
        details: { field: "scheduled_for" },
      });
    }
    checkBody(post.body);
    const accountRef = await resolveAccountRef(ctx, workspace, input.account_id ?? null);
    const ref = input.account_id ? accountRef : (post.account_ref ?? accountRef);
    if (!ref) throw noAccountError();
    const ready = await updatePost(ctx, post, {
      account_ref: ref,
      error: null,
      why: whyForNewRequest(post.why),
    });
    if (needsApproval(ctx)) return requestPostApproval(ctx, ready, "schedule", input.scheduled_for);
    const row = await updatePost(ctx, ready, {
      status: "scheduled",
      scheduled_for: input.scheduled_for,
    });
    return toPostOutput(row);
  },
});

export const publishPostOp = defineOperation({
  id: "posts.publish",
  summary: "Publish a post now (approval by default)",
  description:
    "Publishes a post to LinkedIn right away on the chosen or default account. Agents always get an approval request (kind post) and the post goes out when a human approves; a human with the approve scope publishes directly. Use schedule for a later time and dry_run to preview. Publishing is public and cannot be undone from here; a publish that got no clear answer becomes unknown and is never repeated on its own (settle it with resolve_unknown).",
  effect: "send",
  input: z.object({ post_id: postId, account_id: accountId.optional() }),
  output: z.union([
    postOutput,
    awaitingApprovalOutput,
    dryRunOutput(
      z.object({
        post_id: z.string(),
        account: z.string(),
        characters: z.number(),
        needs_approval: z.boolean(),
      }),
    ),
  ]),
  http: { method: "POST", path: "/v1/posts/:post_id/publish" },
  dryRun: "supported",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Publish", input: { post_id: "pst_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const workspace = await loadWorkspace(ctx, requireWorkspace(ctx).id);
    const post = await requirePost(ctx, workspace.id, input.post_id);
    if (post.status === "published") return toPostOutput(post);
    refuseUnsettled(post, "republish");
    checkBody(post.body);
    const accountRef = await resolveAccountRef(ctx, workspace, input.account_id ?? null);
    const ref = input.account_id ? accountRef : (post.account_ref ?? accountRef);
    if (!ref) throw noAccountError();
    if (ctx.request.dryRun) {
      return dryRun({
        post_id: post.id,
        account: ref.name ?? ref.account_id,
        characters: post.body.length,
        needs_approval: needsApproval(ctx),
      });
    }
    const ready = await updatePost(ctx, post, {
      account_ref: ref,
      error: null,
      why: whyForNewRequest(post.why),
    });
    if (needsApproval(ctx)) return requestPostApproval(ctx, ready, "publish", null);
    const approved = await updatePost(ctx, ready, { status: "approved", scheduled_for: null });
    return toPostOutput(await publishPost(ctx, approved));
  },
});

// --- cancel ----------------------------------------------------------------------------------

export const cancelPost = defineOperation({
  id: "posts.cancel",
  summary: "Unschedule a post (back to draft)",
  description:
    "Stops a pending, approved, scheduled or failed post from going out and returns it to draft; its pending approval is cancelled. Use it when plans change or the text needs rework. Published posts cannot be cancelled: delete them on LinkedIn; an unknown post (it may be live) is settled with resolve_unknown instead. The draft stays for later use.",
  effect: "write",
  input: z.object({ post_id: postId }),
  output: postOutput,
  http: { method: "POST", path: "/v1/posts/:post_id/cancel" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Cancel", input: { post_id: "pst_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const post = await requirePost(ctx, workspace.id, input.post_id);
    if (post.status === "published") {
      throw new OpenOutboundError("conflict", "The post is already published.", {
        hint: "Delete it on LinkedIn if it should not be visible.",
      });
    }
    refuseUnsettled(post, "cancel");
    await ctx.approvals.cancel({ target: { type: "post", id: post.id } }, "post cancelled");
    if (post.status === "draft") return toPostOutput(post);
    return toPostOutput(
      await updatePost(ctx, post, {
        status: "draft",
        scheduled_for: null,
        why: whyForNewRequest(post.why),
      }),
    );
  },
});

// --- posting accounts ------------------------------------------------------------------------

const postingAccountOutput = z.object({
  id: z.string(),
  kind: z.enum(["social", "linkedin"]),
  provider: z.string(),
  name: z.string().nullable(),
  status: z.string(),
  expires_at: isoDateTime().nullable(),
});

export const listPostingAccounts = defineOperation({
  id: "posts.accounts.list",
  summary: "List accounts that can publish posts",
  description:
    "Lists accounts that can publish: LinkedIn members connected through OAuth (sac_..., linkedin_official) and active LinkedIn accounts (lia_..., Unipile). Use the id as account_id when scheduling or publishing. OAuth tokens last about 60 days; reconnect when status is expired. Outreach limits are managed with manage_linkedin.",
  effect: "read",
  input: z.object({}),
  output: z.object({ items: z.array(postingAccountOutput) }),
  http: { method: "GET", path: "/v1/posts/accounts" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "All", input: {} }],
  handler: async (ctx) => {
    const workspace = requireWorkspace(ctx);
    const social = await ctx.db
      .select()
      .from(social_accounts)
      .where(eq(social_accounts.workspace_id, workspace.id))
      .orderBy(desc(social_accounts.created_at));
    const linkedin = await ctx.db
      .select()
      .from(linkedin_accounts)
      .where(
        and(
          eq(linkedin_accounts.workspace_id, workspace.id),
          eq(linkedin_accounts.status, "active"),
        ),
      );
    return {
      items: [
        ...social.map((row) => ({
          id: row.id,
          kind: "social" as const,
          provider: row.provider,
          name: row.name,
          status: row.status,
          expires_at: row.expires_at,
        })),
        ...linkedin.map((row) => ({
          id: row.id,
          kind: "linkedin" as const,
          provider: row.provider,
          name: row.name,
          status: row.status,
          expires_at: null,
        })),
      ],
    };
  },
});

export const connectPostingAccount = defineOperation({
  id: "posts.accounts.connect",
  summary: "Get a LinkedIn login link to connect a posting account (official API)",
  description:
    "Returns a link the human opens to authorize posting with LinkedIn's official API (Share on LinkedIn); the callback stores the token encrypted and adds the account. Use it for publishing only; outreach accounts are connected with manage_linkedin. Needs LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET (provider linkedin_official) configured. The link expires after 15 minutes.",
  effect: "write",
  input: z.object({}),
  output: z.object({
    auth_url: z.string(),
    expires_at: z.string(),
    next_steps: z.array(z.string()),
  }),
  http: { method: "POST", path: "/v1/posts/accounts/connect" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [{ title: "Connect", input: {} }],
  handler: async (ctx) => {
    const workspace = requireWorkspace(ctx);
    const publisher = await ctx.providers.get("social", { id: "linkedin_official" });
    if (!publisher.authUrl) {
      throw new OpenOutboundError("unsupported", "This social provider has no OAuth flow.", {
        hint: "Configure the linkedin_official provider with manage_providers.",
      });
    }
    const now = ctx.clock.now();
    const verifier = randomBytes(32).toString("base64url");
    const state = encodeOAuthState(ctx.vault, {
      ws: workspace.id,
      v: verifier,
      exp: now.getTime() + OAUTH_STATE_TTL_MS,
    });
    return {
      auth_url: `${ctx.config.baseUrl}/oauth/linkedin/start?state=${state}`,
      expires_at: new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString(),
      next_steps: [
        "Give auth_url to the human: they open it, log in to LinkedIn and approve posting.",
        "Then list accounts with manage_posts action accounts and use the sac_ id as account_id.",
      ],
    };
  },
});

export const contentOperations = [
  listPosts,
  draftPosts,
  updatePostOp,
  schedulePost,
  publishPostOp,
  cancelPost,
  resolveUnknownPost,
  listPostingAccounts,
  connectPostingAccount,
];
