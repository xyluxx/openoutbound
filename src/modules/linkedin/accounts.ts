/**
 * LinkedIn account state: lookups, provider resolution, restriction and disconnection handling.
 * Restrictions never auto-resume: only `linkedin.accounts.resume` (a human) brings an account back.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { isOpenOutboundError, notFound, OpenOutboundError } from "../../core/errors.js";
import { failureOf, isRetryable } from "../../core/failures.js";
import type { Db } from "../../db/client.js";
import {
  type LinkedInAccount,
  linkedin_accounts,
  messages,
  type Workspace,
  workspaces,
} from "../../db/schema/index.js";
import type { LinkedInProvider } from "../../providers/types.js";
import { notify } from "../../runtime/notify.js";
import { PAUSE_CLASSES } from "../../runtime/provider-health.js";
import { RATE_LIMIT_RESTRICT_THRESHOLD } from "./limits.js";
import { openAccountDown } from "./send-problems.js";

export async function findAccount(
  db: Db,
  workspaceId: string,
  accountId: string,
): Promise<LinkedInAccount | null> {
  const [row] = await db
    .select()
    .from(linkedin_accounts)
    .where(
      and(eq(linkedin_accounts.id, accountId), eq(linkedin_accounts.workspace_id, workspaceId)),
    );
  return row ?? null;
}

/** The account in the context workspace, or an actionable `not_found`. */
export async function requireAccount(
  ctx: OpContext,
  workspaceId: string,
  accountId: string,
): Promise<LinkedInAccount> {
  const account = await findAccount(ctx.db, workspaceId, accountId);
  if (!account) {
    throw new OpenOutboundError("not_found", `LinkedIn account ${accountId} not found.`, {
      hint: "List accounts with `manage_linkedin` action `list` and use an id starting with lia_.",
      details: { what: "LinkedIn account", id: accountId },
    });
  }
  return account;
}

/** Current workspace row (status and settings can change while a job runs). */
export async function loadWorkspace(ctx: OpContext, workspaceId: string): Promise<Workspace> {
  const [row] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!row) throw notFound("Workspace", workspaceId);
  return row;
}

/** Provider instance for the account (sandbox workspaces always use their sandbox provider). */
export async function providerFor(
  ctx: OpContext,
  account: Pick<LinkedInAccount, "provider">,
): Promise<LinkedInProvider> {
  if (ctx.workspace?.is_sandbox) return ctx.providers.get("linkedin");
  return ctx.providers.get("linkedin", { id: account.provider });
}

export type ProviderFailure =
  | "restricted"
  | "rate_limited"
  | "disconnected"
  /** The provider itself is paused for the workspace (rejected key, used-up quota). */
  | "provider_paused"
  | "unknown"
  | "permanent"
  | "transient";

/**
 * Classifies a provider error: the LinkedIn slot flags first (restricted, disconnected, rate
 * limited), then the failure class (`failureOf`): `auth_invalid` of this account's session
 * (scope call) is a disconnection, `rate_limited` a rate limit, `outcome_unknown` an action
 * that may or may not have reached LinkedIn; then the engine's one retry rule (`isRetryable`).
 * A rejected provider key, a used-up quota or a missing permission of the provider account
 * (scope account or provider) is not this LinkedIn account's fault: it is `provider_paused`,
 * provider health pauses the provider with a `provider_down` problem, and actions wait for the
 * fix instead of failing.
 */
export function classifyFailure(error: unknown): ProviderFailure {
  if (!isOpenOutboundError(error)) return "transient";
  const details = error.details ?? {};
  if (details.restricted === true) return "restricted";
  if (details.disconnected === true) return "disconnected";
  const failure = failureOf(error);
  if (failure?.class === "auth_invalid" && failure.scope === "call") return "disconnected";
  if (details.paused === true) return "provider_paused";
  if (failure && PAUSE_CLASSES.has(failure.class) && failure.scope !== "call") {
    return "provider_paused";
  }
  if (details.rateLimited === true || failure?.class === "rate_limited") return "rate_limited";
  if (failure?.class === "outcome_unknown") return "unknown";
  return isRetryable(error) ? "transient" : "permanent";
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

/**
 * Moves the account's scheduled LinkedIn messages back to `approved` (capacity released) so
 * nothing runs while the account is paused, restricted or disconnected. Returns the count.
 */
export async function unscheduleMessages(
  db: Db,
  account: Pick<LinkedInAccount, "id" | "workspace_id">,
  note: string,
): Promise<number> {
  const rows = await db
    .update(messages)
    .set({ status: "approved", error: note })
    .where(
      and(
        eq(messages.workspace_id, account.workspace_id),
        eq(messages.linkedin_account_id, account.id),
        eq(messages.channel, "linkedin"),
        inArray(messages.status, ["scheduled"]),
      ),
    )
    .returning({ id: messages.id });
  return rows.length;
}

async function tryNotify(ctx: OpContext, input: Parameters<typeof notify>[1]): Promise<void> {
  try {
    await notify(ctx, input);
  } catch (error) {
    ctx.log.warn({ err: errorText(error) }, "linkedin: notification failed");
  }
}

/**
 * Restriction signal: status `restricted`, every queued action paused, event + notification
 * and a `mailbox_down` problem. Idempotent: an already restricted account only gets its queue
 * paused again.
 */
export async function restrictAccount(
  ctx: OpContext,
  account: LinkedInAccount,
  reason: string,
): Promise<{ transitioned: boolean; paused: number }> {
  const now = ctx.clock.now();
  const rows = await ctx.db
    .update(linkedin_accounts)
    .set({
      status: "restricted",
      status_reason: reason.slice(0, 300),
      health: {
        ...account.health,
        last_error: reason.slice(0, 300),
        last_error_at: now.toISOString(),
      },
    })
    .where(
      and(
        eq(linkedin_accounts.id, account.id),
        inArray(linkedin_accounts.status, ["active", "paused", "pending", "disconnected"]),
      ),
    )
    .returning({ id: linkedin_accounts.id });
  const paused = await unscheduleMessages(
    ctx.db,
    account,
    `paused: account restricted (${reason})`,
  );
  const transitioned = rows.length > 0;
  if (transitioned) {
    await ctx.events.emit("linkedin.account_restricted", {
      workspaceId: account.workspace_id,
      subject: { type: "linkedin_account", id: account.id },
      data: { account_id: account.id, reason },
    });
    await tryNotify(ctx, {
      title: `LinkedIn account restricted: ${account.name ?? account.id}`,
      lines: [
        `Reason: ${reason}`,
        `All LinkedIn actions for this account are paused (${paused} queued).`,
        "Log in to LinkedIn yourself, complete any check, use the account manually for 7 days, then resume it.",
      ],
      severity: "critical",
      event: "linkedin.account_restricted",
    });
    await openAccountDown(ctx, account, "restricted", reason);
  }
  return { transitioned, paused };
}

/**
 * Lost session or credentials: status `disconnected`, queue paused, human notified and a
 * `mailbox_down` problem opened.
 */
export async function disconnectAccount(
  ctx: OpContext,
  account: LinkedInAccount,
  reason: string,
): Promise<{ transitioned: boolean; paused: number }> {
  const rows = await ctx.db
    .update(linkedin_accounts)
    .set({ status: "disconnected", status_reason: reason.slice(0, 300) })
    .where(
      and(
        eq(linkedin_accounts.id, account.id),
        inArray(linkedin_accounts.status, ["active", "paused"]),
      ),
    )
    .returning({ id: linkedin_accounts.id });
  const paused = await unscheduleMessages(
    ctx.db,
    account,
    `paused: account disconnected (${reason})`,
  );
  const transitioned = rows.length > 0;
  if (transitioned) {
    await tryNotify(ctx, {
      title: `LinkedIn account disconnected: ${account.name ?? account.id}`,
      lines: [
        `Reason: ${reason}`,
        "Reconnect it with `manage_linkedin` action `connect`, then resume it.",
      ],
      severity: "warning",
    });
    await openAccountDown(ctx, account, "disconnected", reason);
  }
  return { transitioned, paused };
}

/**
 * Counts consecutive rate limits; the third in a row is treated as a restriction signal.
 * Returns true when the account was restricted.
 */
export async function recordRateLimit(
  ctx: OpContext,
  account: LinkedInAccount,
  reason: string,
): Promise<boolean> {
  const previous =
    account.health.last_error === "rate_limited" ? (account.health.consecutive_failures ?? 0) : 0;
  const count = previous + 1;
  if (count >= RATE_LIMIT_RESTRICT_THRESHOLD) {
    await restrictAccount(
      ctx,
      account,
      `Repeated rate limits from LinkedIn (${count} in a row): ${reason}`,
    );
    return true;
  }
  await ctx.db
    .update(linkedin_accounts)
    .set({
      health: {
        ...account.health,
        consecutive_failures: count,
        last_error: "rate_limited",
        last_error_at: ctx.clock.now().toISOString(),
      },
    })
    .where(eq(linkedin_accounts.id, account.id));
  return false;
}

/** Clears failure counters after a successful provider call. */
export async function recordSuccess(db: Db, account: LinkedInAccount): Promise<void> {
  if (!account.health.consecutive_failures && !account.health.last_error) return;
  await db
    .update(linkedin_accounts)
    .set({ health: { ...account.health, consecutive_failures: 0, last_error: null } })
    .where(eq(linkedin_accounts.id, account.id));
}

/**
 * Applies the account-level consequence of a provider failure (restriction, disconnection,
 * rate limit). Returns the classification so callers can decide about the current item.
 */
export async function handleAccountFailure(
  ctx: OpContext,
  account: LinkedInAccount,
  error: unknown,
): Promise<ProviderFailure | "restricted_after_rate_limits"> {
  const kind = classifyFailure(error);
  if (kind === "restricted") await restrictAccount(ctx, account, errorText(error));
  else if (kind === "disconnected") await disconnectAccount(ctx, account, errorText(error));
  else if (kind === "rate_limited") {
    if (await recordRateLimit(ctx, account, errorText(error)))
      return "restricted_after_rate_limits";
  }
  return kind;
}
