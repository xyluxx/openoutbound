/**
 * LinkedIn channel service: safe action planning, queueing and relation lookups (binding
 * signatures used by campaigns and other modules).
 */
import { and, eq, inArray } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { LinkedInRelationStatus } from "../../core/enums.js";
import { invalid, notFound, OpenOutboundError } from "../../core/errors.js";
import { linkedin_accounts, linkedin_relations, messages, people } from "../../db/schema/index.js";
import type { LinkedInPost } from "../../providers/types.js";
import { findAccount, handleAccountFailure, loadWorkspace, providerFor } from "./accounts.js";
import { loadPlannerInput } from "./capacity.js";
import {
  findSlot,
  LINKEDIN_ACTIONS,
  type LinkedInActionKind,
  type PlanOutcome,
  planAction,
  usedOn,
} from "./limits.js";
import { findRelation } from "./relations.js";
import { dayKey } from "./time.js";

export type { LinkedInActionKind } from "./limits.js";

export type PlanLinkedInActionResult =
  | { ok: true; accountId: string; runAt: Date }
  | {
      ok: false;
      reason: "no_active_account" | "no_capacity" | "outside_hours" | "workspace_paused";
      /** Next moment the action could run, when known. */
      retryAt?: Date;
    };

export function isLinkedInAction(value: string): value is LinkedInActionKind {
  return (LINKEDIN_ACTIONS as readonly string[]).includes(value);
}

/**
 * Picks an account and a time that respect daily and weekly caps, ramp, hours and gaps.
 * Accounts are tried preferred first, then least used today. Succeeds only for the working
 * window that contains `notBefore` (default now); otherwise returns the next allowed moment.
 */
export async function planLinkedInAction(
  ctx: OpContext,
  input: {
    accountIds: string[];
    preferredAccountId?: string | null;
    action: LinkedInActionKind;
    notBefore?: Date;
  },
): Promise<PlanLinkedInActionResult> {
  const workspace = await loadWorkspace(ctx, requireWorkspace(ctx).id);
  // Kill switch: paused (and archived) workspaces take no LinkedIn actions.
  if (workspace.status !== "active") return { ok: false, reason: "workspace_paused" };
  if (!isLinkedInAction(input.action)) {
    throw invalid(`Unknown LinkedIn action "${input.action}".`, { allowed: LINKEDIN_ACTIONS });
  }
  const ids = [...new Set(input.accountIds)];
  if (ids.length === 0) return { ok: false, reason: "no_active_account" };
  const accounts = await ctx.db
    .select()
    .from(linkedin_accounts)
    .where(
      and(
        eq(linkedin_accounts.workspace_id, workspace.id),
        inArray(linkedin_accounts.id, ids),
        eq(linkedin_accounts.status, "active"),
      ),
    );
  if (accounts.length === 0) return { ok: false, reason: "no_active_account" };

  const now = ctx.clock.now();
  const start =
    input.notBefore && input.notBefore.getTime() > now.getTime() ? input.notBefore : now;
  const candidates = [];
  for (const account of accounts) {
    const planner = await loadPlannerInput(ctx.db, {
      account,
      workspace,
      action: input.action,
      from: start,
    });
    candidates.push({
      account,
      planner,
      used: usedOn(planner, dayKey(start, planner.schedule.timezone)),
    });
  }
  candidates.sort((a, b) => {
    const preferredA = a.account.id === input.preferredAccountId ? 0 : 1;
    const preferredB = b.account.id === input.preferredAccountId ? 0 : 1;
    if (preferredA !== preferredB) return preferredA - preferredB;
    if (a.used !== b.used) return a.used - b.used;
    return a.account.id < b.account.id ? -1 : 1;
  });

  let best: Extract<PlanOutcome, { ok: false }> | null = null;
  for (const candidate of candidates) {
    const outcome = planAction(candidate.planner, start);
    if (outcome.ok) return { ok: true, accountId: candidate.account.id, runAt: outcome.runAt };
    if (
      !best ||
      (outcome.retryAt && (!best.retryAt || outcome.retryAt.getTime() < best.retryAt.getTime()))
    ) {
      best = outcome;
    }
  }
  if (!best) return { ok: false, reason: "no_capacity" };
  return best.retryAt
    ? { ok: false, reason: best.reason, retryAt: best.retryAt }
    : { ok: false, reason: best.reason };
}

/**
 * Queues an `approved` LinkedIn message row (channel linkedin, with linkedin_account_id and
 * scheduled_for): sets it `scheduled`, reserves capacity, enqueues `linkedin.action`.
 * The slot is re-checked under a per-account lock, so concurrent queues keep their gaps; when
 * the planned day is full the action moves to the next allowed slot. Repeat calls are no-ops.
 */
export async function queueLinkedInAction(ctx: OpContext, messageId: string): Promise<void> {
  const workspace = await loadWorkspace(ctx, requireWorkspace(ctx).id);
  const [message] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspace_id, workspace.id)));
  if (!message) throw notFound("Message", messageId);
  if (message.channel !== "linkedin" || message.direction !== "outbound") {
    throw invalid(`Message ${messageId} is not an outbound LinkedIn message.`);
  }
  if (message.status === "scheduled") {
    await enqueueAction(ctx, message.id, message.scheduled_for ?? ctx.clock.now());
    return;
  }
  if (["sending", "unknown", "sent"].includes(message.status)) return;
  if (message.status !== "approved") {
    throw new OpenOutboundError(
      "conflict",
      `Message ${messageId} is ${message.status}; only approved messages can be queued.`,
      { hint: "Approve the message first (review_items), then queue it again." },
    );
  }
  if (!isLinkedInAction(message.action)) {
    throw invalid(`Message ${messageId} has action "${message.action}", not a LinkedIn action.`);
  }
  const accountId = message.linkedin_account_id;
  if (!accountId) {
    throw invalid(`Message ${messageId} has no linkedin_account_id.`, {
      hint: "Plan it with planLinkedInAction and store the chosen account on the message.",
    });
  }
  const action = message.action;
  const now = ctx.clock.now();
  const from =
    message.scheduled_for && message.scheduled_for.getTime() > now.getTime()
      ? message.scheduled_for
      : now;

  const runAt = await ctx.db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(linkedin_accounts)
      .where(
        and(eq(linkedin_accounts.id, accountId), eq(linkedin_accounts.workspace_id, workspace.id)),
      )
      .for("update");
    if (!account) throw notFound("LinkedIn account", accountId);
    if (account.status !== "active") {
      throw new OpenOutboundError(
        "conflict",
        `LinkedIn account ${account.name ?? account.id} is ${account.status}; nothing can be queued on it.`,
        {
          hint: "Resume the account with `manage_linkedin` action `resume` (a human must resume restricted accounts).",
          details: { account_id: account.id, status: account.status },
        },
      );
    }
    const planner = await loadPlannerInput(tx, {
      account,
      workspace,
      action,
      from,
      excludeMessageId: message.id,
    });
    const slot = findSlot(planner, from);
    if (!slot) {
      throw new OpenOutboundError(
        "limit_reached",
        `No allowed slot in the next 3 weeks for a LinkedIn ${action} on account ${account.name ?? account.id}.`,
        {
          hint: "Check the account limits and working hours with `manage_linkedin` action `list`.",
          details: { account_id: account.id, action },
        },
      );
    }
    await tx
      .update(messages)
      .set({ status: "scheduled", scheduled_for: slot.at, error: null })
      .where(and(eq(messages.id, message.id), eq(messages.status, "approved")));
    return slot.at;
  });
  await enqueueAction(ctx, message.id, runAt);
}

/**
 * Enqueues the action job (one per message). When a job for the message already exists and is
 * waiting for an older slot, it is woken so it re-reads the new `scheduled_for`.
 */
export async function enqueueAction(ctx: OpContext, messageId: string, runAt: Date): Promise<void> {
  const handle = await ctx.jobs.enqueue(
    "linkedin.action",
    { message_id: messageId },
    { runAt, singletonKey: `linkedin.action:${messageId}` },
  );
  if (handle.deduplicated) await ctx.jobs.wake(`linkedin.slot:${messageId}`);
}

/**
 * Re-queues approved actions of an account that were planned before (scheduled_for set), e.g.
 * after a pause or restriction was lifted. Returns how many were queued again.
 */
export async function requeueApproved(
  ctx: OpContext,
  workspaceId: string,
  accountId: string,
): Promise<number> {
  const rows = await ctx.db
    .select({ id: messages.id, scheduled_for: messages.scheduled_for })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspaceId),
        eq(messages.linkedin_account_id, accountId),
        eq(messages.channel, "linkedin"),
        eq(messages.direction, "outbound"),
        eq(messages.status, "approved"),
      ),
    );
  let queued = 0;
  for (const row of rows) {
    if (!row.scheduled_for) continue;
    try {
      await queueLinkedInAction(ctx, row.id);
      queued++;
    } catch (error) {
      ctx.log.warn({ message_id: row.id, err: String(error) }, "linkedin: could not re-queue");
    }
  }
  return queued;
}

/** Relation between one of our accounts and a person ('none' when unknown). */
export async function getRelation(
  ctx: OpContext,
  input: { accountId: string; personId: string },
): Promise<LinkedInRelationStatus> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select({ status: linkedin_relations.status })
    .from(linkedin_relations)
    .where(
      and(
        eq(linkedin_relations.workspace_id, workspace.id),
        eq(linkedin_relations.account_id, input.accountId),
        eq(linkedin_relations.person_id, input.personId),
      ),
    );
  return row?.status ?? "none";
}

/**
 * Most recent post by the person within maxAgeDays (default 30), or null. Reposts are
 * ignored. Returns null without calling LinkedIn when the account is not active.
 */
export async function getRecentPostForPerson(
  ctx: OpContext,
  input: { accountId: string; personId: string; maxAgeDays?: number },
): Promise<LinkedInPost | null> {
  const workspace = requireWorkspace(ctx);
  const account = await findAccount(ctx.db, workspace.id, input.accountId);
  if (!account) throw notFound("LinkedIn account", input.accountId);
  if (account.status !== "active" || !account.external_account_id) return null;
  const [person] = await ctx.db
    .select({ linkedin_url: people.linkedin_url })
    .from(people)
    .where(and(eq(people.id, input.personId), eq(people.workspace_id, workspace.id)));
  if (!person) throw notFound("Person", input.personId);
  const relation = await findRelation(ctx.db, account.id, input.personId);
  if (!person.linkedin_url && !relation?.provider_ref) return null;
  const provider = await providerFor(ctx, account);
  let posts: LinkedInPost[];
  try {
    posts = await provider.listRecentPosts(
      account.external_account_id,
      { profile_url: person.linkedin_url, provider_id: relation?.provider_ref ?? null },
      { limit: 10 },
    );
  } catch (error) {
    await handleAccountFailure(ctx, account, error);
    throw error;
  }
  return pickRecentPost(posts, ctx.clock.now(), input.maxAgeDays ?? 30);
}

/** Newest post with a known date within `maxAgeDays` (raw payload stripped). */
export function pickRecentPost(
  posts: LinkedInPost[],
  now: Date,
  maxAgeDays: number,
): LinkedInPost | null {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  let best: { post: LinkedInPost; at: number } | null = null;
  for (const post of posts) {
    const at = post.published_at ? Date.parse(post.published_at) : Number.NaN;
    if (Number.isNaN(at) || at < cutoff || at > now.getTime() + 86_400_000) continue;
    if (!best || at > best.at) best = { post, at };
  }
  if (!best) return null;
  const { raw: _raw, ...rest } = best.post;
  return rest;
}
