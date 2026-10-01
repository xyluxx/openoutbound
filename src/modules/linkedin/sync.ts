/**
 * Sync (every 15 minutes per account, singleton): accepted invitations -> relations connected
 * + `linkedin.connected`; inbound messages -> threads + messages + `reply.received`; pending
 * invitations older than 21 days -> withdrawn (a few per run, inside working hours only).
 * Webhook events go through the same handlers.
 *
 * The relations and message listings only move forward past what was received and stored: a
 * listing the provider ended with a cursor keeps that cursor and its synced_at (the next run
 * continues from the cursor; synced_at becomes the time the listing started once it ends), and a
 * listing that failed keeps its place. A stored cursor the provider rejects (`bad_request`,
 * `not_found`, `malformed`: it would fail the same way every run) is dropped, so the next run
 * lists again from synced_at. A failure is stored with its class in sync_state.last_error and
 * the run result; one listing failing does not stop the other unless the failure is about the
 * account or the provider. A lost LinkedIn session disconnects the account; a rejected provider
 * key or a paused provider leaves it active with the error.
 *
 * Overdue actions are re-queued (no provider call) unless a failure stopped the run; stale
 * invitations are withdrawn only after a clean run. After FAILED_SYNCS_PROBLEM failed runs in a
 * row the account gets a `mailbox_down` problem for reading (`mailbox_down:<id>:read`, like a
 * mailbox whose IMAP login fails), resolved by the next clean run.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { callFailure, stopsProvider } from "../../core/call-failure.js";
import type { JobContext, OpContext } from "../../core/context.js";
import { type Failure, type FailureClass, failureOf } from "../../core/failures.js";
import { defineJob } from "../../core/operation.js";
import {
  type LinkedInAccount,
  type LinkedInSyncState,
  linkedin_accounts,
  linkedin_relations,
} from "../../db/schema/index.js";
import type { LinkedInEvent } from "../../providers/types.js";
import { openProblem, resolveProblemsFor } from "../problems/service.js";
import {
  disconnectAccount,
  errorText,
  findAccount,
  handleAccountFailure,
  loadWorkspace,
  providerFor,
  restrictAccount,
} from "./accounts.js";
import { requeueOverdue } from "./action-job.js";
import { accountSchedule } from "./capacity.js";
import { activate, pollPendingAccount } from "./hosted-auth.js";
import { ingestInboundMessage } from "./inbound.js";
import { AUTO_WITHDRAW_DAYS } from "./limits.js";
import { markConnected, matchPerson } from "./relations.js";
import { resolveAccountDown } from "./send-problems.js";
import { requeueApproved } from "./service.js";
import { nextWindow } from "./time.js";

/** Withdrawals per sync run (every 15 minutes): spreads a backlog over time, no bursts. */
const MAX_WITHDRAWALS_PER_RUN = 2;

/** Failed sync runs in a row after which the account gets a problem (about 75 minutes). */
export const FAILED_SYNCS_PROBLEM = 5;

/** Failures a stored cursor keeps getting: asking it again would fail the same way. */
const REJECTED_CURSOR = new Set<FailureClass>(["bad_request", "not_found", "malformed"]);

/** Dedupe key of the `mailbox_down` problem of an account whose sync keeps failing. */
export function accountReadDownKey(accountId: string): string {
  return `mailbox_down:${accountId}:read`;
}

export interface SyncResult {
  account_id: string;
  status: string;
  connected: number;
  messages: number;
  duplicates: number;
  unmatched: number;
  withdrawn: number;
  requeued: number;
  error?: string;
  /** The first provider failure of the run, with its class. */
  failure?: Failure;
}

type Listing = "messages" | "relations";

/**
 * Moves a listing forward after a page was received and stored. A cursor means the provider
 * stopped before the end: keep it to continue next time and leave synced_at where it was, so
 * what was not listed yet is not skipped. When the listing ends, synced_at becomes the time it
 * started (later items are covered by the next window).
 */
function advance(state: LinkedInSyncState, listing: Listing, cursor: string | null, now: Date) {
  const started = state[`${listing}_cursor_started_at`] ?? now.toISOString();
  if (cursor) {
    state[`${listing}_cursor`] = cursor;
    state[`${listing}_cursor_started_at`] = started;
    return;
  }
  state[`${listing}_cursor`] = null;
  state[`${listing}_cursor_started_at`] = null;
  state[`${listing}_synced_at`] = started;
}

/**
 * Forgets a stored cursor the provider rejected (an expired or unknown cursor), so the next
 * run lists again from synced_at, which never moved past what was not read yet.
 */
function dropRejectedCursor(next: LinkedInSyncState, listing: Listing, error: unknown) {
  if (!next[`${listing}_cursor`]) return;
  const failureClass = failureOf(error)?.class;
  if (!failureClass || !REJECTED_CURSOR.has(failureClass)) return;
  next[`${listing}_cursor`] = null;
  next[`${listing}_cursor_started_at`] = null;
}

function workspaceIdOf(ctx: JobContext, payloadWorkspace?: string): string | null {
  return ctx.workspace?.id ?? payloadWorkspace ?? ctx.job.workspaceId ?? null;
}

export const syncWorkspaceJob = defineJob({
  name: "linkedin.sync_workspace",
  payload: z.object({ workspace_id: z.string().optional() }).loose(),
  maxAttempts: 3,
  handler: async (ctx, payload) => {
    const workspaceId = workspaceIdOf(ctx, payload.workspace_id);
    if (!workspaceId) return { enqueued: 0 };
    const accounts = await ctx.db
      .select({ id: linkedin_accounts.id })
      .from(linkedin_accounts)
      .where(
        and(
          eq(linkedin_accounts.workspace_id, workspaceId),
          inArray(linkedin_accounts.status, ["active", "paused", "pending"]),
        ),
      );
    for (const account of accounts) {
      await ctx.jobs.enqueue(
        "linkedin.sync",
        { account_id: account.id },
        { workspaceId, singletonKey: `linkedin.sync:${account.id}` },
      );
    }
    return { enqueued: accounts.length };
  },
});

export const syncAccountJob = defineJob({
  name: "linkedin.sync",
  payload: z.object({ account_id: z.string() }),
  maxAttempts: 3,
  timeoutMs: 4 * 60_000,
  handler: async (ctx, payload) => {
    const workspaceId = workspaceIdOf(ctx);
    if (!workspaceId) return { skipped: "no_workspace" };
    return syncAccount(ctx, workspaceId, payload.account_id);
  },
});

/** One sync pass for one account (see module doc). Never throws for provider failures. */
export async function syncAccount(
  ctx: JobContext,
  workspaceId: string,
  accountId: string,
): Promise<SyncResult | { skipped: string } | { account_id: string; status: string }> {
  const account = await findAccount(ctx.db, workspaceId, accountId);
  if (!account) return { skipped: "not_found" };
  if (account.status === "pending") {
    const polled = await pollPendingAccount(ctx, account);
    return { account_id: account.id, status: polled.status };
  }
  if (account.status !== "active" && account.status !== "paused") {
    return { skipped: `account_${account.status}` };
  }
  const result: SyncResult = {
    account_id: account.id,
    status: account.status,
    connected: 0,
    messages: 0,
    duplicates: 0,
    unmatched: 0,
    withdrawn: 0,
    requeued: 0,
  };
  const external = account.external_account_id;
  if (!external) return { skipped: "no_external_account" };
  const now = ctx.clock.now();
  const state = account.sync_state;
  const provider = await providerFor(ctx, account);
  const nextState: LinkedInSyncState = { ...state, last_error: null };
  let stopped = false;
  /** Runs one step; a failure is recorded and, when it concerns the account, ends the run. */
  const step = async (name: "relations" | "messages" | "actions", work: () => Promise<void>) => {
    if (stopped) return;
    try {
      await work();
    } catch (error) {
      const failure = callFailure(error, account.provider);
      // A lost LinkedIn session disconnects the account; a rejected provider key or a paused
      // provider leaves it alone (provider health pauses the provider until someone fixes it).
      await handleAccountFailure(ctx, account, error);
      result.error ??= errorText(error);
      result.failure ??= failure;
      nextState.last_error ??= {
        at: now.toISOString(),
        step: name,
        message: errorText(error),
        failure,
      };
      const current = await findAccount(ctx.db, workspaceId, account.id);
      const usable = current?.status === "active" || current?.status === "paused";
      if (stopsProvider(failure) || !usable) stopped = true;
    }
  };
  if (provider.syncRelations) {
    const syncRelations = provider.syncRelations.bind(provider);
    await step("relations", async () => {
      const since = state.relations_synced_at
        ? new Date(Date.parse(state.relations_synced_at) - 86_400_000)
        : new Date(now.getTime() - 30 * 86_400_000);
      const page = await syncRelations(external, {
        since,
        cursor: state.relations_cursor ?? null,
      }).catch((error: unknown) => {
        dropRejectedCursor(nextState, "relations", error);
        throw error;
      });
      for (const connection of page.connections) {
        if (await acceptConnection(ctx, account, connection)) result.connected++;
      }
      advance(nextState, "relations", page.cursor ?? null, now);
    });
  }
  if (provider.syncMessages) {
    const syncMessages = provider.syncMessages.bind(provider);
    await step("messages", async () => {
      const since = state.messages_synced_at
        ? new Date(Date.parse(state.messages_synced_at) - 10 * 60_000)
        : new Date(now.getTime() - 7 * 86_400_000);
      const page = await syncMessages(external, {
        since,
        cursor: state.messages_cursor ?? null,
      }).catch((error: unknown) => {
        dropRejectedCursor(nextState, "messages", error);
        throw error;
      });
      for (const message of page.messages) {
        const ingested = await ingestInboundMessage(ctx, account, message);
        if (ingested.result === "created") result.messages++;
        else if (ingested.result === "duplicate") result.duplicates++;
        else if (ingested.result === "unmatched") result.unmatched++;
      }
      advance(nextState, "messages", page.cursor ?? null, now);
    });
  }
  // Reading continues while paused; actions only when active and not after a failure that
  // stopped the run (the account or the provider). Re-queuing overdue actions calls no provider,
  // so a failed listing does not hold it back; withdrawals call LinkedIn: only after a clean run.
  await step("actions", async () => {
    const workspace = await loadWorkspace(ctx, account.workspace_id);
    if (account.status === "active" && workspace.status === "active") {
      result.requeued = await requeueOverdue(ctx, account);
      if (!result.failure) result.withdrawn = await withdrawStaleInvites(ctx, account);
    }
  });
  nextState.failed_syncs = result.failure ? (state.failed_syncs ?? 0) + 1 : 0;
  await ctx.db
    .update(linkedin_accounts)
    .set({ sync_state: nextState })
    .where(eq(linkedin_accounts.id, account.id));
  await reportSyncHealth(ctx, account, nextState);
  return result;
}

/** Resolves the account's problem for reading, if one is open (never throws). */
export async function resolveAccountReadDown(
  ctx: OpContext,
  account: Pick<LinkedInAccount, "id" | "workspace_id">,
  resolution: string,
): Promise<void> {
  if (ctx.workspace?.id !== account.workspace_id) return;
  try {
    await resolveProblemsFor(ctx, { dedupeKey: accountReadDownKey(account.id) }, resolution);
  } catch (cause) {
    ctx.log.warn({ err: String(cause), account_id: account.id }, "could not resolve mailbox_down");
  }
}

/**
 * Opens the account's problem for reading after FAILED_SYNCS_PROBLEM failed runs in a row, and
 * resolves it after a clean run (never throws).
 */
async function reportSyncHealth(
  ctx: OpContext,
  account: LinkedInAccount,
  state: LinkedInSyncState,
): Promise<void> {
  if (ctx.workspace?.id !== account.workspace_id) return;
  const failed = state.failed_syncs ?? 0;
  const key = accountReadDownKey(account.id);
  if (failed === 0) {
    await resolveAccountReadDown(ctx, account, "The LinkedIn sync works again.");
    return;
  }
  try {
    const error = state.last_error;
    if (failed < FAILED_SYNCS_PROBLEM || !error) return;
    const name = account.name ?? account.id;
    await openProblem(ctx, {
      kind: "mailbox_down",
      severity: "high",
      owner: "person",
      title: `LinkedIn account ${name} cannot read replies`,
      reason: `The last ${failed} syncs failed (${error.failure.class} in ${error.step}: ${error.message.replace(/\s+/g, " ").slice(0, 200)}). New replies and accepted invitations of this account are read only through the webhook, if one is set up, so a reply may not stop its sequence.`,
      remedy: `Check last_sync_error with manage_linkedin action list. When the provider is down or its key was refused, check it with manage_providers action test; a lost LinkedIn session needs manage_linkedin action connect. A clean sync closes this problem.`,
      subject: { type: "linkedin_account", id: account.id },
      data: {
        account_id: account.id,
        name: account.name,
        failed_syncs: failed,
        step: error.step,
        failure: error.failure,
      },
      dedupeKey: key,
    });
  } catch (cause) {
    ctx.log.warn({ err: String(cause), account_id: account.id }, "could not report sync health");
  }
}

async function acceptConnection(
  ctx: OpContext,
  account: LinkedInAccount,
  connection: { provider_id: string; profile_url?: string | null; connected_at?: string | null },
): Promise<boolean> {
  const personId = await matchPerson(ctx.db, account, connection);
  if (!personId) return false;
  const at = connection.connected_at ? new Date(connection.connected_at) : ctx.clock.now();
  return markConnected(ctx, account, personId, {
    connectedAt: Number.isNaN(at.getTime()) ? ctx.clock.now() : at,
    providerRef: connection.provider_id || null,
  });
}

/**
 * Withdraws invitations to workspace people pending longer than 21 days (oldest first, two per
 * run, only inside working hours of an active workspace). Invitations OpenOutbound does not
 * track (the owner's own) are left alone. Withdrawals count toward no limit; they are logged.
 * Each one first claims its relation (`invited` to `withdrawn`, compare and set), so two runs
 * never withdraw the same invitation; when the call fails, the claim is released and a later
 * run looks at the live list of pending invitations again (an invitation already gone stays
 * withdrawn).
 */
export async function withdrawStaleInvites(
  ctx: OpContext,
  account: LinkedInAccount,
): Promise<number> {
  if (!account.external_account_id) return 0;
  const provider = await providerFor(ctx, account);
  if (!provider.listPendingInvites || !provider.withdrawInvite) return 0;
  const now = ctx.clock.now();
  const workspace = await loadWorkspace(ctx, account.workspace_id);
  if (workspace.status !== "active") return 0;
  const window = nextWindow(accountSchedule(account, workspace), now);
  if (!window || window.start.getTime() > now.getTime()) return 0;

  const relations = await ctx.db
    .select()
    .from(linkedin_relations)
    .where(
      and(eq(linkedin_relations.account_id, account.id), eq(linkedin_relations.status, "invited")),
    );
  if (relations.length === 0) return 0;
  const byRef = new Map(
    relations.flatMap((row) => (row.provider_ref ? [[row.provider_ref, row] as const] : [])),
  );
  const byPerson = new Map(relations.map((row) => [row.person_id, row] as const));
  const cutoff = now.getTime() - AUTO_WITHDRAW_DAYS * 86_400_000;
  const invites = await provider.listPendingInvites(account.external_account_id);
  const candidates = [];
  for (const invite of invites) {
    const sentAt = invite.sent_at ? Date.parse(invite.sent_at) : Number.NaN;
    if (!Number.isNaN(sentAt) && sentAt >= cutoff) continue;
    let relation = byRef.get(invite.provider_id);
    if (!relation && invite.profile_url) {
      const personId = await matchPerson(ctx.db, account, { profile_url: invite.profile_url });
      relation = personId ? byPerson.get(personId) : undefined;
    }
    if (!relation) continue;
    const at = Number.isNaN(sentAt) ? (relation.invited_at?.getTime() ?? Number.NaN) : sentAt;
    if (Number.isNaN(at) || at >= cutoff) continue;
    candidates.push({ invite, relation, at });
  }
  const stale = candidates.sort((a, b) => a.at - b.at).slice(0, MAX_WITHDRAWALS_PER_RUN);

  const signal = (ctx as Partial<JobContext>).job?.signal;
  let withdrawn = 0;
  for (const item of stale) {
    const relation = and(
      eq(linkedin_relations.account_id, account.id),
      eq(linkedin_relations.person_id, item.relation.person_id),
    );
    const [claimed] = await ctx.db
      .update(linkedin_relations)
      .set({ status: "withdrawn", withdrawn_at: now })
      .where(and(relation, eq(linkedin_relations.status, "invited")))
      .returning({ person_id: linkedin_relations.person_id });
    // Another run withdrew it, or the person connected meanwhile.
    if (!claimed) continue;
    try {
      await provider.withdrawInvite(
        account.external_account_id,
        item.invite.invitation_id,
        signal ? { signal } : undefined,
      );
    } catch (error) {
      // Gone already (accepted or withdrawn on LinkedIn): nothing left to withdraw.
      if (failureOf(error)?.class === "not_found") continue;
      await ctx.db
        .update(linkedin_relations)
        .set({ status: "invited", withdrawn_at: null })
        .where(and(relation, eq(linkedin_relations.status, "withdrawn")));
      throw error;
    }
    withdrawn++;
    ctx.log.info(
      {
        account_id: account.id,
        invitation_id: item.invite.invitation_id,
        person_id: item.relation.person_id,
      },
      "linkedin: withdrew an invitation pending longer than 21 days",
    );
  }
  return withdrawn;
}

// --- Webhook events --------------------------------------------------------------------------

const eventSchema = z.custom<LinkedInEvent>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string",
);

export const webhookEventJob = defineJob({
  name: "linkedin.webhook_event",
  payload: z.object({ account_id: z.string(), event: eventSchema }),
  maxAttempts: 5,
  handler: async (ctx, payload) => {
    const workspaceId = workspaceIdOf(ctx);
    if (!workspaceId) return { skipped: "no_workspace" };
    const account = await findAccount(ctx.db, workspaceId, payload.account_id);
    if (!account) return { skipped: "account_not_found" };
    return processLinkedInEvent(ctx, account, payload.event);
  },
});

/** Stable key per event for de-duplication of webhook deliveries. */
export function eventKey(event: LinkedInEvent): string {
  switch (event.type) {
    case "message_received":
      return `msg:${event.message.id}`;
    case "invite_accepted":
      return `rel:${event.provider_id || event.profile_url || ""}`;
    case "account_status":
      return `status:${event.status}:${event.reason ?? ""}`;
  }
}

/** Applies one provider event (same handlers as the sync). Idempotent. */
export async function processLinkedInEvent(
  ctx: OpContext,
  account: LinkedInAccount,
  event: LinkedInEvent,
): Promise<Record<string, unknown>> {
  switch (event.type) {
    case "invite_accepted": {
      const connected = await acceptConnection(ctx, account, {
        provider_id: event.provider_id,
        profile_url: event.profile_url ?? null,
        connected_at: event.occurred_at,
      });
      return { type: event.type, connected };
    }
    case "message_received": {
      const ingested = await ingestInboundMessage(ctx, account, event.message);
      return { type: event.type, result: ingested.result };
    }
    case "account_status": {
      const reason = event.reason ?? event.status;
      if (event.status === "restricted") {
        const { transitioned } = await restrictAccount(ctx, account, `Provider reported ${reason}`);
        return { type: event.type, status: "restricted", changed: transitioned };
      }
      if (event.status === "disconnected" || event.status === "credentials_needed") {
        const { transitioned } = await disconnectAccount(
          ctx,
          account,
          `Provider reported ${reason}`,
        );
        return { type: event.type, status: "disconnected", changed: transitioned };
      }
      // Healthy again: complete pending connections; never auto-resume restricted accounts.
      if (account.status === "pending" && account.external_account_id) {
        await activate(ctx, account, account.external_account_id);
        return { type: event.type, status: "active", changed: true };
      }
      if (
        account.status === "disconnected" &&
        /RECONNECTED|CREATION_SUCCESS/i.test(event.reason ?? "")
      ) {
        await ctx.db
          .update(linkedin_accounts)
          .set({ status: "active", status_reason: null })
          .where(eq(linkedin_accounts.id, account.id));
        const requeued = await requeueApproved(ctx, account.workspace_id, account.id);
        await resolveAccountDown(ctx, account, "LinkedIn reported it reconnected.");
        return { type: event.type, status: "active", changed: true, requeued };
      }
      return { type: event.type, status: account.status, changed: false };
    }
  }
}
