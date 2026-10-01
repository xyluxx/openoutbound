/**
 * Post helpers: output shape, posting-account resolution and the approval rule. Publishing
 * itself is in publish.ts.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { OpContext } from "../../core/context.js";
import { POST_STATUSES } from "../../core/enums.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import { isoDateTime } from "../../core/operation.js";
import {
  linkedin_accounts,
  type Post,
  posts,
  type SocialAccountRef,
  social_accounts,
  type Workspace,
} from "../../db/schema/index.js";
import { mustRequestApproval } from "../../runtime/approval-rule.js";

export const POST_MAX_CHARS = 3000;

export const postOutput = z.object({
  id: z.string(),
  status: z.enum(POST_STATUSES),
  body: z.string(),
  pillar: z.string().nullable(),
  account: z
    .object({ provider: z.string(), account_id: z.string(), name: z.string().nullable() })
    .nullable(),
  scheduled_for: isoDateTime().nullable(),
  published_at: isoDateTime().nullable(),
  url: z.string().nullable(),
  error: z.string().nullable(),
  note: z
    .string()
    .nullable()
    .describe(
      "What happened beyond the status, in plain words: why the outcome is unknown and what to do, a publish accepted without a link, the next try, who settled it",
    ),
  angle: z.string().nullable(),
  created_at: isoDateTime(),
});

/** The note shown with a post (see `postOutput.note`). */
function postNote(post: Post): string | null {
  const stored = post.why?.publish_note ?? null;
  if (post.status === "unknown") {
    return (
      stored ??
      "LinkedIn may or may not have published it. It is not published again on its own: check the profile, then settle it with manage_posts action resolve_unknown."
    );
  }
  if (post.status === "publishing") return "Being handed to LinkedIn right now.";
  return stored;
}

export function toPostOutput(post: Post): z.input<typeof postOutput> {
  return {
    id: post.id,
    status: post.status,
    body: post.body,
    pillar: post.pillar,
    account: post.account_ref
      ? {
          provider: post.account_ref.provider,
          account_id: post.account_ref.account_id,
          name: post.account_ref.name ?? null,
        }
      : null,
    scheduled_for: post.scheduled_for,
    published_at: post.published_at,
    url: post.url,
    error: post.error,
    note: postNote(post),
    angle: post.why?.angle ?? null,
    created_at: post.created_at,
  };
}

export async function requirePost(
  ctx: OpContext,
  workspaceId: string,
  postId: string,
): Promise<Post> {
  const [post] = await ctx.db
    .select()
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.workspace_id, workspaceId)));
  if (!post) throw notFound("Post", postId);
  return post;
}

/**
 * Posts need an approval of kind `post` unless a person with the `approve` scope asks (they
 * approve by asking): the one approval rule, `mustRequestApproval`.
 */
export function needsApproval(ctx: OpContext): boolean {
  return mustRequestApproval(ctx.principal);
}

/**
 * Posting account for a post: `sac_...` (OAuth social account) or `lia_...` (LinkedIn account
 * connected through Unipile or the sandbox). Without an id: the newest active social account,
 * else the first active LinkedIn account. Null when there is none.
 */
export async function resolveAccountRef(
  ctx: OpContext,
  workspace: Pick<Workspace, "id" | "is_sandbox">,
  accountId?: string | null,
): Promise<SocialAccountRef | null> {
  if (accountId?.startsWith("sac_") || !accountId) {
    const conditions = [
      eq(social_accounts.workspace_id, workspace.id),
      eq(social_accounts.status, "active"),
    ];
    if (accountId) conditions.push(eq(social_accounts.id, accountId));
    const [row] = await ctx.db
      .select()
      .from(social_accounts)
      .where(and(...conditions))
      .orderBy(desc(social_accounts.created_at))
      .limit(1);
    if (row) {
      return {
        provider: row.provider,
        account_id: row.external_id,
        ...(row.name ? { name: row.name } : {}),
        secret_id: row.secret_id,
      };
    }
    if (accountId) throw notFound("Social account", accountId);
  }
  const conditions = [
    eq(linkedin_accounts.workspace_id, workspace.id),
    eq(linkedin_accounts.status, "active"),
  ];
  if (accountId) conditions.push(eq(linkedin_accounts.id, accountId));
  const [account] = await ctx.db
    .select()
    .from(linkedin_accounts)
    .where(and(...conditions))
    .orderBy(linkedin_accounts.created_at)
    .limit(1);
  if (!account?.external_account_id) {
    if (accountId) {
      throw new OpenOutboundError("conflict", `LinkedIn account ${accountId} is not active.`, {
        hint: "Use an active account from manage_linkedin action list, or resume it first.",
      });
    }
    return null;
  }
  return {
    provider: workspace.is_sandbox ? "sandbox" : account.provider,
    account_id: account.external_account_id,
    ...(account.name ? { name: account.name } : {}),
    secret_id: null,
  };
}

export function noAccountError(): OpenOutboundError {
  return new OpenOutboundError("validation_failed", "No account to publish from.", {
    hint: "Connect one with manage_posts action connect_account (LinkedIn OAuth) or manage_linkedin action connect, then pass account_id.",
    details: { field: "account_id" },
  });
}

/** Content pillars from raw workspace settings (`content.pillars`), when present. */
export function settingsPillars(workspace: Pick<Workspace, "settings">): string[] {
  const content = (workspace.settings as Record<string, unknown> | null)?.content;
  const pillars =
    typeof content === "object" && content !== null
      ? (content as Record<string, unknown>).pillars
      : null;
  return Array.isArray(pillars)
    ? pillars.filter((p): p is string => typeof p === "string" && p.trim() !== "").slice(0, 10)
    : [];
}

/** A post that changed between reading and writing it (another call or run got there first). */
export function postChanged(post: Pick<Post, "id">, status: string): OpenOutboundError {
  return new OpenOutboundError(
    "conflict",
    `Post ${post.id} changed meanwhile (it is ${status} now).`,
    {
      hint: "Read it again with manage_posts action list, then decide again.",
      details: { status },
    },
  );
}
