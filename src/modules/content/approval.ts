/**
 * Approval resolver for kind `post`: approve (or edit) schedules the post or publishes it
 * right away when it is due (scheduled instead while the workspace is paused); reject returns
 * it to draft. A `republish` approval (manage_posts action resolve_unknown) publishes a post
 * with an unknown outcome once more, only at the try it was asked about; rejecting it leaves the
 * post unknown. Every write only applies while the post is still as the approval found it;
 * repeat decisions change nothing.
 */
import { and, eq } from "drizzle-orm";
import type { ApprovalResolver } from "../../core/operation.js";
import { type Post, posts, workspaces } from "../../db/schema/index.js";
import { POST_MAX_CHARS } from "./posts.js";
import { publishPost } from "./publish.js";
import { republishUnknownPost } from "./resolve-unknown.js";

function editedBody(edits: Record<string, unknown> | undefined): string | null {
  const body = edits?.body;
  return typeof body === "string" && body.trim() && body.length <= POST_MAX_CHARS ? body : null;
}

function editedTime(edits: Record<string, unknown> | undefined, fallback: unknown): Date | null {
  const value = edits?.scheduled_for ?? fallback;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type Target = { type: string; id: string };

/** What a publish came to, for the approver. */
export function publishResult(post: Post, target: Target) {
  switch (post.status) {
    case "published":
      return {
        message: `Post published${post.url ? `: ${post.url}` : "."}`,
        target,
        data: { status: post.status, url: post.url },
      };
    case "unknown":
      return {
        message: `LinkedIn may or may not have published the post (${post.error ?? "no clear answer"}). It is not published again on its own: check the profile, then settle it with manage_posts action resolve_unknown.`,
        target,
        data: { status: post.status, error: post.error },
      };
    case "scheduled":
      return {
        message: post.error
          ? `Nothing reached LinkedIn (${post.error}); the post is tried again at ${post.scheduled_for?.toISOString() ?? "the next run"}.`
          : `Post scheduled for ${post.scheduled_for?.toISOString() ?? "the next run"}.`,
        target,
        data: {
          status: post.status,
          scheduled_for: post.scheduled_for?.toISOString() ?? null,
          error: post.error,
        },
      };
    case "failed":
      return {
        message: `Publishing failed: ${post.error ?? "unknown error"}`,
        target,
        data: { status: post.status, error: post.error },
      };
    default:
      return {
        message: `The post is ${post.status}.`,
        target,
        data: { status: post.status },
      };
  }
}

export const postApprovalResolver: ApprovalResolver = {
  kind: "post",
  apply: async (ctx, approval, decision) => {
    const postId = String(approval.target_id ?? approval.payload.post_id ?? "");
    const [post] = await ctx.db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.workspace_id, approval.workspace_id)));
    const target = { type: "post", id: postId };
    if (!post) return { message: "The post no longer exists.", target };
    if (approval.payload.action === "republish") {
      if (post.status !== "unknown") {
        return { message: `The post is ${post.status}; nothing to apply.`, target };
      }
      // The request was about one try: a post published again since then is a new question.
      if (approval.payload.attempt !== post.publish_attempt) {
        return {
          message: `The post was published again after this request (try ${post.publish_attempt}); nothing to apply. Settle the newer try with manage_posts action resolve_unknown.`,
          target,
        };
      }
      if (decision.decision === "reject") {
        return {
          message:
            "Not published again: the post stays unknown. Settle it with manage_posts action resolve_unknown (outcome published or cancel).",
          target,
        };
      }
      return publishResult(await republishUnknownPost(ctx, post, decision.decidedBy.name), target);
    }
    if (post.status !== "pending_review") {
      return { message: `The post is ${post.status}; nothing to apply.`, target };
    }
    const pending = and(
      eq(posts.id, post.id),
      eq(posts.workspace_id, post.workspace_id),
      eq(posts.status, "pending_review"),
    );
    const changed = async () => {
      const [now] = await ctx.db
        .select({ status: posts.status })
        .from(posts)
        .where(and(eq(posts.id, post.id), eq(posts.workspace_id, post.workspace_id)));
      return { message: `The post is ${now?.status ?? "gone"}; nothing to apply.`, target };
    };
    if (decision.decision === "reject") {
      const [rejected] = await ctx.db
        .update(posts)
        .set({
          status: "draft",
          scheduled_for: null,
          error: decision.note ? `rejected: ${decision.note}` : null,
        })
        .where(pending)
        .returning({ id: posts.id });
      if (!rejected) return changed();
      return { message: "Post returned to draft.", target };
    }
    const body = editedBody(decision.edits) ?? post.body;
    const scheduledFor = editedTime(decision.edits, approval.payload.scheduled_for);
    const now = ctx.clock.now();
    if (scheduledFor && scheduledFor.getTime() > now.getTime()) {
      const [scheduled] = await ctx.db
        .update(posts)
        .set({ status: "scheduled", body, scheduled_for: scheduledFor, error: null })
        .where(pending)
        .returning({ id: posts.id });
      if (!scheduled) return changed();
      return {
        message: `Post scheduled for ${scheduledFor.toISOString()}.`,
        target,
        data: { status: "scheduled", scheduled_for: scheduledFor.toISOString() },
      };
    }
    const [workspace] = await ctx.db
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, approval.workspace_id));
    if (workspace && workspace.status !== "active") {
      // Kill switch: nothing goes out while paused; publish_due sends it after resume.
      const [held] = await ctx.db
        .update(posts)
        .set({ status: "scheduled", body, scheduled_for: now, error: null })
        .where(pending)
        .returning({ id: posts.id });
      if (!held) return changed();
      return {
        message: `Post approved; the workspace is ${workspace.status}, so it goes out once it is active again.`,
        target,
        data: { status: "scheduled", scheduled_for: now.toISOString() },
      };
    }
    const [approved] = await ctx.db
      .update(posts)
      .set({ status: "approved", body, scheduled_for: null, error: null })
      .where(pending)
      .returning();
    if (!approved) return changed();
    return publishResult(await publishPost(ctx, approved), target);
  },
};
