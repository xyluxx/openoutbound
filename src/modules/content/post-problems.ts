/**
 * Problems about published posts: `send_unknown` when the engine cannot tell whether LinkedIn
 * published a post, `duplicate_send` when a post went out twice. Both are for a person; the
 * first closes when the post is settled with `manage_posts` action `resolve_unknown`.
 */
import { and, eq, sql } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { type Post, posts } from "../../db/schema/index.js";
import { duplicateSendKey } from "../email/duplicate-sends.js";
import { sendUnknownKey } from "../email/unknown-sends.js";
import { openProblem, resolveProblemsFor } from "../problems/service.js";

/** The first words of a post, for problem texts. */
export function postExcerpt(post: Pick<Post, "body">): string {
  const text = post.body.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

/** The profile a post goes out on, in words. */
export function postAccountName(post: Pick<Post, "account_ref">): string {
  return post.account_ref?.name ?? post.account_ref?.account_id ?? "the LinkedIn profile";
}

/** Opens (or refreshes) the post's `send_unknown` problem: high severity, for a person. */
export async function openPostUnknownProblem(
  ctx: OpContext,
  post: Pick<Post, "id" | "body" | "account_ref" | "publish_attempt">,
  detail: string,
): Promise<{ id: string; created: boolean }> {
  const account = postAccountName(post);
  return openProblem(ctx, {
    kind: "send_unknown",
    severity: "high",
    owner: "person",
    title: "Check whether a LinkedIn post went out",
    reason: `The post "${postExcerpt(post)}" on ${account} may or may not be live: ${detail}. The engine will not publish it again on its own.`,
    remedy: `Look at the recent activity of ${account} on LinkedIn, then use manage_posts action resolve_unknown with outcome published (add the url if you found it), republish or cancel (post_id ${post.id}).`,
    subject: { type: "post", id: post.id },
    data: { post_id: post.id, attempt: post.publish_attempt },
    dedupeKey: sendUnknownKey(post.id),
  });
}

/** Resolves the post's `send_unknown` problem, if one is open. Returns how many were resolved. */
export async function resolvePostUnknownProblem(
  ctx: OpContext,
  postId: string,
  resolution: string,
): Promise<number> {
  return resolveProblemsFor(ctx, { dedupeKey: sendUnknownKey(postId) }, resolution);
}

export interface PostDuplicate {
  /** Publish attempts that went out (or, when not proven, may have), oldest first. */
  attempts: number[];
  /** False when the newest attempt's own outcome is unknown, so it only may have gone out. */
  proven: boolean;
  /** Link to the other copy, when the late answer brought one. */
  otherUrl?: string | null;
}

/**
 * Records that a post went out twice (or may have): `why.duplicate_attempts` and a
 * `duplicate_send` problem (normal severity, for a person, one per post). Nothing is undone.
 */
export async function recordPostDuplicate(
  ctx: OpContext,
  post: Post,
  input: PostDuplicate,
): Promise<void> {
  const attempts = [...new Set(input.attempts)].sort((a, b) => a - b);
  await ctx.db
    .update(posts)
    .set({
      why: sql`coalesce(${posts.why}, '{}'::jsonb) || ${JSON.stringify({ duplicate_attempts: attempts })}::jsonb`,
    })
    .where(and(eq(posts.id, post.id), eq(posts.workspace_id, post.workspace_id)));
  const urls = [post.url, input.otherUrl].filter((url): url is string => Boolean(url));
  const where = urls.length > 0 ? ` Copies: ${[...new Set(urls)].join(" and ")}.` : "";
  const account = postAccountName(post);
  await openProblem(ctx, {
    kind: "duplicate_send",
    severity: "normal",
    owner: "person",
    title: input.proven ? "LinkedIn post went out twice" : "LinkedIn post may have gone out twice",
    reason: input.proven
      ? `The post "${postExcerpt(post)}" went out twice on ${account}: the answer to an earlier try came late, after it was published again (tries ${attempts.join(" and ")}).${where}`
      : `The post "${postExcerpt(post)}" went out on ${account} with an earlier try whose answer came late, and a newer try may have gone out too (tries ${attempts.join(" and ")}).${where}`,
    remedy: `Look at the recent activity of ${account} on LinkedIn and delete the extra copy if there is one. Nothing will be published again. Then close this with resolve_exception action resolve.`,
    subject: { type: "post", id: post.id },
    data: { post_id: post.id, attempts, proven: input.proven, urls },
    dedupeKey: duplicateSendKey(post.id),
  });
  ctx.log.warn(
    { post_id: post.id, attempts, proven: input.proven },
    "a post went out twice: an earlier attempt's answer came late",
  );
}
