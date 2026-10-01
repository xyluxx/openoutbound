/**
 * `posts.resolve_unknown`: a person settles a post whose publish got no clear answer (status
 * `unknown`; the engine will not publish it again on its own). Published records it as live,
 * republish publishes it once more (after a human approval, like every publish), cancel returns
 * it to draft. Each closes the post's `send_unknown` problem.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { forbidden, OpenOutboundError } from "../../core/errors.js";
import { idSchema } from "../../core/ids.js";
import { awaitingApproval, awaitingApprovalOutput, defineOperation } from "../../core/operation.js";
import { type Post, posts, workspaces } from "../../db/schema/index.js";
import { postExcerpt, resolvePostUnknownProblem } from "./post-problems.js";
import { needsApproval, postChanged, postOutput, requirePost, toPostOutput } from "./posts.js";
import { publishPost, recordPublished, withPublishNote } from "./publish.js";

export const POST_RESOLVE_OUTCOMES = ["published", "republish", "cancel"] as const;
export type PostResolveOutcome = (typeof POST_RESOLVE_OUTCOMES)[number];

const EXAMPLE_POST_ID = "pst_01k6a3v0q8x3m2n4p5r6s7t8v9";

/** Only an `unknown` post at the attempt that was read is settled. */
function stillUnknown(post: Pick<Post, "id" | "workspace_id" | "publish_attempt">) {
  return and(
    eq(posts.id, post.id),
    eq(posts.workspace_id, post.workspace_id),
    eq(posts.status, "unknown"),
    eq(posts.publish_attempt, post.publish_attempt),
  );
}

/**
 * Publishes a post with an unknown outcome once more, at a person's decision: right away while
 * the workspace is active, else when it is active again (`scheduled`, picked up by
 * `content.publish_due`). Closes the post's `send_unknown` problem.
 */
export async function republishUnknownPost(ctx: OpContext, post: Post, by: string): Promise<Post> {
  const [workspace] = await ctx.db
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, post.workspace_id))
    .limit(1);
  const active = workspace?.status === "active";
  const now = ctx.clock.now();
  const [row] = await ctx.db
    .update(posts)
    .set({
      status: active ? "approved" : "scheduled",
      scheduled_for: active ? null : now,
      error: null,
      why: withPublishNote(`Published again at the request of ${by}.`, {
        republished_after_unknown: now.toISOString(),
      }),
    })
    .where(stillUnknown(post))
    .returning();
  if (!row) throw postChanged(post, await statusNow(ctx, post));
  // A request still waiting about this try is settled now: approving it later would publish it
  // a third time.
  await ctx.approvals.cancel(
    { target: { type: "post", id: post.id } },
    `Published again at the request of ${by}.`,
  );
  await resolvePostUnknownProblem(ctx, post.id, `Published again at the request of ${by}.`);
  return active ? publishPost(ctx, row) : row;
}

async function statusNow(ctx: OpContext, post: Pick<Post, "id" | "workspace_id">) {
  const [row] = await ctx.db
    .select({ status: posts.status })
    .from(posts)
    .where(and(eq(posts.id, post.id), eq(posts.workspace_id, post.workspace_id)))
    .limit(1);
  return row?.status ?? "deleted";
}

export const resolveUnknownPost = defineOperation({
  id: "posts.resolve_unknown",
  summary: "Settle a post the engine could not tell was published",
  description:
    "Settles a LinkedIn post with status unknown (its publish got no clear answer, so the engine will not publish it again on its own): outcome published records it as live (pass url when you found it), republish publishes it once more, cancel returns it to draft. Use it after a person looked at the profile's recent activity, as the send_unknown problem asks. Not for drafts, scheduled or failed posts: use publish, schedule or cancel for those. Republishing can put the post on the profile twice if the first one did go out, needs the send scope, and like any publish waits for a human approval (review_items) unless a human with the approve scope asks.",
  effect: "write",
  input: z.object({
    post_id: idSchema("pst").describe("Post id (pst_...) with status unknown"),
    outcome: z
      .enum(POST_RESOLVE_OUTCOMES)
      .describe(
        "published = it is live; republish = it is not, publish it again; cancel = it is not, keep it as a draft",
      ),
    url: z
      .string()
      .url()
      .max(500)
      .optional()
      .describe("Link to the live post, for outcome published"),
    note: z.string().max(300).optional().describe("What was checked, kept with the resolution"),
  }),
  output: z.union([postOutput, awaitingApprovalOutput]),
  http: { method: "POST", path: "/v1/posts/:post_id/resolve_unknown" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "It is on the profile",
      input: {
        post_id: EXAMPLE_POST_ID,
        outcome: "published",
        url: "https://www.linkedin.com/feed/update/urn:li:share:7380000000000000000/",
        note: "Found it in the profile's recent activity.",
      },
    },
    {
      title: "Not on the profile: publish it again",
      input: { post_id: EXAMPLE_POST_ID, outcome: "republish" },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const post = await requirePost(ctx, workspace.id, input.post_id);
    if (input.url && input.outcome !== "published") {
      throw new OpenOutboundError("validation_failed", "url only goes with outcome published.", {
        hint: "Drop url, or use outcome published when the post is live.",
        details: { field: "url" },
      });
    }
    if (post.status !== "unknown") {
      // Already settled the way asked: safe to repeat.
      if (settledAs(post, input.outcome)) return toPostOutput(post);
      throw new OpenOutboundError(
        "conflict",
        `Post ${post.id} is ${post.status}, not unknown: only a post whose publish got no clear answer can be settled.`,
        {
          hint: "Find the ones to settle with manage_posts action list (status unknown); publish, schedule or cancel other posts with those actions.",
          details: { status: post.status },
        },
      );
    }
    const by = input.note ? `${ctx.principal.name} (${input.note.trim()})` : ctx.principal.name;
    switch (input.outcome) {
      case "published": {
        const row = await recordPublished(ctx, post, {
          from: "unknown",
          attempt: post.publish_attempt,
          externalId: null,
          url: input.url ?? null,
          note: `Confirmed as published by ${by}.`,
          publishedAt: post.publish_started_at ?? ctx.clock.now(),
        });
        if (!row) throw postChanged(post, await statusNow(ctx, post));
        return toPostOutput(row);
      }
      case "cancel": {
        const [row] = await ctx.db
          .update(posts)
          .set({
            status: "draft",
            scheduled_for: null,
            error: null,
            why: withPublishNote(`Not published, checked by ${by}; back to draft.`),
          })
          .where(stillUnknown(post))
          .returning();
        if (!row) throw postChanged(post, await statusNow(ctx, post));
        await ctx.approvals.cancel({ target: { type: "post", id: post.id } }, "not published");
        await resolvePostUnknownProblem(ctx, post.id, `Not published, checked by ${by}.`);
        return toPostOutput(row);
      }
      case "republish": {
        if (!ctx.principal.scopes.includes("send")) throw forbidden("send");
        if (needsApproval(ctx)) return requestRepublishApproval(ctx, post);
        return toPostOutput(await republishUnknownPost(ctx, post, by));
      }
    }
  },
});

function settledAs(post: Post, outcome: PostResolveOutcome): boolean {
  return (
    (outcome === "published" && post.status === "published") ||
    (outcome === "cancel" && post.status === "draft")
  );
}

/**
 * Asks a human to approve publishing an unknown post again (kind post, action republish). The
 * post stays unknown until they decide; rejecting leaves it unknown.
 */
async function requestRepublishApproval(ctx: OpContext, post: Post) {
  await ctx.approvals.cancel(
    { target: { type: "post", id: post.id } },
    "replaced by a new request",
  );
  const account = post.account_ref?.name ?? post.account_ref?.account_id ?? "the default account";
  const summary = `Publish again on LinkedIn as ${account} (the first publish got no clear answer, so it may be live already): "${postExcerpt(post)}"`;
  const { id } = await ctx.approvals.request({
    kind: "post",
    title: "Publish a LinkedIn post again",
    summary,
    payload: {
      post_id: post.id,
      action: "republish",
      scheduled_for: null,
      body: post.body,
      attempt: post.publish_attempt,
    },
    target: { type: "post", id: post.id },
  });
  return awaitingApproval(id, summary);
}
