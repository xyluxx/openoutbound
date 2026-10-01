/**
 * Hosted-auth account connection (Unipile): the human opens the provider's link and logs in
 * there; the provider's notify callback (`/hooks/unipile/auth`) or a poll completes the
 * pending account. LinkedIn passwords never pass through OpenOutbound.
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { OpContext, Vault } from "../../core/context.js";
import { type LinkedInAccount, linkedin_accounts } from "../../db/schema/index.js";
import { findAccount, providerFor } from "./accounts.js";
import { resolveAccountDown } from "./send-problems.js";
import { dayKey } from "./time.js";

const STATE_AAD = "linkedin:hosted_auth";
export const AUTH_LINK_TTL_MS = 24 * 60 * 60_000;

interface AuthState {
  ws: string;
  acc: string;
  exp: number;
}

/** Encrypted, expiring state for the notify URL (the vault key protects it). */
export function encodeAuthState(vault: Vault, state: AuthState): string {
  const sealed = vault.encrypt(JSON.stringify(state), STATE_AAD);
  return Buffer.from(JSON.stringify(sealed), "utf8").toString("base64url");
}

/** Decodes and checks the state; null when it was tampered with or expired. */
export function decodeAuthState(vault: Vault, token: string, now: Date): AuthState | null {
  try {
    const sealed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    const state = JSON.parse(vault.decrypt(sealed, STATE_AAD)) as AuthState;
    if (typeof state.ws !== "string" || typeof state.acc !== "string") return null;
    if (typeof state.exp !== "number" || state.exp < now.getTime()) return null;
    return state;
  } catch {
    return null;
  }
}

const SUCCESS_STATUSES = new Set(["CREATION_SUCCESS", "RECONNECTED", "SYNC_SUCCESS", "OK"]);

export const LINKED_ELSEWHERE_REASON =
  "This LinkedIn account is connected in another workspace. Remove it there first: one LinkedIn account can only be used in one workspace, so its daily limits hold.";

/**
 * True when another workspace already uses this provider account. Limits are per LinkedIn
 * account, so two workspaces on one account would double its volume. Sandbox ids are
 * workspace-local and never collide in a meaningful way.
 */
export async function linkedElsewhere(
  ctx: OpContext,
  account: Pick<LinkedInAccount, "id" | "workspace_id" | "provider">,
  externalAccountId: string,
): Promise<boolean> {
  if (account.provider === "sandbox") return false;
  const [other] = await ctx.db
    .select({ id: linkedin_accounts.id })
    .from(linkedin_accounts)
    .where(
      and(
        eq(linkedin_accounts.provider, account.provider),
        eq(linkedin_accounts.external_account_id, externalAccountId),
        ne(linkedin_accounts.workspace_id, account.workspace_id),
      ),
    )
    .limit(1);
  return other !== undefined;
}

export type CompleteResult =
  | { ok: true; account_id: string; status: "active"; already?: boolean }
  | { ok: false; account_id: string; reason: string };

/** Activates a pending account with the provider's account id (idempotent). */
export async function completeHostedAuth(
  ctx: OpContext,
  input: {
    workspaceId: string;
    accountId: string;
    externalAccountId: string;
    status?: string | null;
  },
): Promise<CompleteResult> {
  const account = await findAccount(ctx.db, input.workspaceId, input.accountId);
  if (!account) return { ok: false, account_id: input.accountId, reason: "not_found" };
  const status = (input.status ?? "CREATION_SUCCESS").toUpperCase();
  if (!SUCCESS_STATUSES.has(status)) {
    if (account.status === "pending") {
      await ctx.db
        .update(linkedin_accounts)
        .set({ status_reason: `Connection did not complete (${status}). Run connect again.` })
        .where(eq(linkedin_accounts.id, account.id));
    }
    return { ok: false, account_id: account.id, reason: `provider_status_${status.toLowerCase()}` };
  }
  if (account.status !== "pending") {
    return account.external_account_id === input.externalAccountId
      ? { ok: true, account_id: account.id, status: "active", already: true }
      : { ok: false, account_id: account.id, reason: "not_pending" };
  }
  const [duplicate] = await ctx.db
    .select({ id: linkedin_accounts.id })
    .from(linkedin_accounts)
    .where(
      and(
        eq(linkedin_accounts.workspace_id, account.workspace_id),
        eq(linkedin_accounts.provider, account.provider),
        eq(linkedin_accounts.external_account_id, input.externalAccountId),
        ne(linkedin_accounts.id, account.id),
      ),
    );
  if (duplicate) {
    await ctx.db
      .update(linkedin_accounts)
      .set({
        status: "disconnected",
        status_reason: `This LinkedIn account is already connected as ${duplicate.id}.`,
        sync_state: { ...account.sync_state, pending_auth: null },
      })
      .where(eq(linkedin_accounts.id, account.id));
    return { ok: false, account_id: account.id, reason: `duplicate_of_${duplicate.id}` };
  }
  if (await linkedElsewhere(ctx, account, input.externalAccountId)) {
    await ctx.db
      .update(linkedin_accounts)
      .set({
        status: "disconnected",
        status_reason: LINKED_ELSEWHERE_REASON,
        sync_state: { ...account.sync_state, pending_auth: null },
      })
      .where(eq(linkedin_accounts.id, account.id));
    return { ok: false, account_id: account.id, reason: "connected_in_another_workspace" };
  }
  await activate(ctx, account, input.externalAccountId);
  return { ok: true, account_id: account.id, status: "active" };
}

/** Sets the external id, status active, starts the ramp and fetches display details. */
export async function activate(
  ctx: OpContext,
  account: LinkedInAccount,
  externalAccountId: string,
): Promise<void> {
  const now = ctx.clock.now();
  const ramp = account.ramp?.enabled
    ? {
        ...account.ramp,
        started_at: account.ramp.started_at ?? dayKey(now, account.timezone ?? "UTC"),
      }
    : account.ramp;
  const values: Partial<typeof linkedin_accounts.$inferInsert> = {
    external_account_id: externalAccountId,
    status: "active",
    status_reason: null,
    connected_at: now,
    ramp,
    sync_state: { ...account.sync_state, pending_auth: null },
  };
  try {
    const provider = await providerFor(ctx, account);
    const info = (await provider.listAccounts?.())?.find(
      (item) => item.external_account_id === externalAccountId,
    );
    if (info) {
      if (!account.name) values.name = info.name;
      if (info.profile_url) values.profile_url = info.profile_url;
      if (info.premium !== undefined) values.premium = info.premium || account.premium;
    }
  } catch (error) {
    ctx.log.warn({ err: String(error) }, "linkedin: could not fetch account details");
  }
  await ctx.db.update(linkedin_accounts).set(values).where(eq(linkedin_accounts.id, account.id));
  if (account.status === "disconnected" || account.status === "restricted") {
    await resolveAccountDown(ctx, account, "Connected again.");
  }
  await ctx.jobs.enqueue(
    "linkedin.sync",
    { account_id: account.id },
    { workspaceId: account.workspace_id, singletonKey: `linkedin.sync:${account.id}` },
  );
}

/**
 * Poll completion for a pending account: links the single provider account that appeared
 * after the link was created and is not linked anywhere yet. Ambiguous cases stay pending.
 */
export async function pollPendingAccount(
  ctx: OpContext,
  account: LinkedInAccount,
): Promise<{ status: "active" | "pending" | "expired"; reason?: string }> {
  const pending = account.sync_state.pending_auth;
  const now = ctx.clock.now();
  if (pending?.expires_at && Date.parse(pending.expires_at) < now.getTime()) {
    await ctx.db
      .update(linkedin_accounts)
      .set({ status_reason: "The connection link expired. Run connect again for a new link." })
      .where(eq(linkedin_accounts.id, account.id));
    return { status: "expired" };
  }
  const known = pending?.known_account_ids;
  if (!known) return { status: "pending", reason: "waiting_for_callback" };
  // With another login link open anywhere on this instance, a new provider account could
  // belong to either one: only the signed callback can tell them apart.
  const others = await ctx.db
    .select({ sync_state: linkedin_accounts.sync_state })
    .from(linkedin_accounts)
    .where(
      and(
        eq(linkedin_accounts.provider, account.provider),
        eq(linkedin_accounts.status, "pending"),
        ne(linkedin_accounts.id, account.id),
      ),
    );
  const openUntil = (other: (typeof others)[number]) => {
    const auth = other.sync_state.pending_auth;
    if (auth?.expires_at) return Date.parse(auth.expires_at);
    if (auth?.requested_at) return Date.parse(auth.requested_at) + AUTH_LINK_TTL_MS;
    return 0;
  };
  if (others.some((other) => openUntil(other) >= now.getTime())) {
    return { status: "pending", reason: "concurrent_connections" };
  }
  const provider = await providerFor(ctx, account);
  if (!provider.listAccounts) return { status: "pending", reason: "provider_cannot_list" };
  const accounts = await provider.listAccounts();
  const linked = await ctx.db
    .select({ id: linkedin_accounts.external_account_id })
    .from(linkedin_accounts)
    .where(
      and(
        eq(linkedin_accounts.provider, account.provider),
        isNotNull(linkedin_accounts.external_account_id),
      ),
    );
  const taken = new Set(linked.map((row) => row.id));
  const candidates = accounts.filter(
    (item) => !known.includes(item.external_account_id) && !taken.has(item.external_account_id),
  );
  if (candidates.length !== 1 || !candidates[0]) {
    return {
      status: "pending",
      reason: candidates.length === 0 ? "not_connected_yet" : "ambiguous_new_accounts",
    };
  }
  await activate(ctx, account, candidates[0].external_account_id);
  return { status: "active" };
}
