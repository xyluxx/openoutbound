import { and, eq } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { type Mailbox, type MailboxOAuth, mailboxes } from "../../db/schema/index.js";
import { sendingStatus } from "./capacity.js";
import { assertSendableAddress, insertMailbox, prepareMailbox } from "./mailbox-create.js";
import {
  clearAccessTokenCache,
  exchangeCode,
  idTokenClaims,
  type OAuthState,
  primeAccessToken,
  refreshSecretName,
} from "./oauth.js";
import { PRESET_SERVERS } from "./presets.js";
import { mailboxActiveKey } from "./queue.js";
import { resolveMailboxDown } from "./send-problems.js";
import { closeSmtpPools } from "./smtp-transport.js";
import { localDate } from "./timezone.js";

export interface OAuthConnectResult {
  mailbox: Mailbox;
  created: boolean;
}

/**
 * Finishes an OAuth connection: exchanges the code (PKCE), checks the address, stores the refresh
 * token in the vault and creates the mailbox (or reconnects an existing one with the same
 * address). `ctx` must act in the workspace the signed state names.
 */
export async function completeOAuth(
  ctx: OpContext,
  state: OAuthState,
  code: string,
): Promise<OAuthConnectResult> {
  const workspace = requireWorkspace(ctx);
  if (workspace.id !== state.ws) {
    throw new OpenOutboundError("forbidden", "The OAuth state belongs to another workspace.", {
      hint: "Start again with manage_mailboxes action oauth_start in the right workspace.",
    });
  }
  const tokens = await exchangeCode(ctx, state, code);
  const claims = idTokenClaims(tokens.idToken);
  const drafted = state.d.email?.trim().toLowerCase() || null;
  const email = claims.email ?? drafted;
  if (!email) {
    throw new OpenOutboundError(
      "provider_error",
      "The provider did not say which mailbox signed in.",
      {
        hint: "Run manage_mailboxes action oauth_start again with the email field set.",
        details: { reason: "oauth_no_email" },
      },
    );
  }
  if (drafted && drafted !== email) {
    throw new OpenOutboundError(
      "validation_failed",
      `You signed in as ${email}, but the connection was started for ${drafted}.`,
      {
        hint: `Run manage_mailboxes action oauth_start again and sign in as ${drafted}, or start it without email to connect ${email}.`,
      },
    );
  }
  assertSendableAddress(email);
  if (!tokens.refreshToken) {
    throw new OpenOutboundError("provider_error", "The provider returned no refresh token.", {
      hint:
        state.p === "google"
          ? "Remove the app's access in the Google account security settings, then run manage_mailboxes action oauth_start again so the consent screen is shown."
          : "Make sure the app registration grants offline_access, then run manage_mailboxes action oauth_start again.",
      details: { reason: "oauth_no_refresh_token" },
    });
  }
  const secretId = await ctx.vault.putSecret(
    workspace.id,
    refreshSecretName(email),
    tokens.refreshToken,
  );
  const oauth: MailboxOAuth = {
    provider: state.p,
    refresh_token_secret_id: secretId,
    access_token_expires_at: tokens.expiresAt.toISOString(),
  };
  if (state.t) oauth.tenant = state.t;
  const authType = state.p === "google" ? "oauth_google" : "oauth_microsoft";

  const [existing] = await ctx.db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspace_id, workspace.id), eq(mailboxes.email, email)));
  let mailbox: Mailbox;
  let created = false;
  if (existing) {
    const servers = PRESET_SERVERS[state.p];
    const reconnect = existing.status === "error" || existing.status === "disconnected";
    const [row] = await ctx.db
      .update(mailboxes)
      .set({
        auth_type: authType,
        provider_label: state.p,
        oauth,
        secret_id: null,
        smtp: { ...servers.smtp, user: email },
        imap: { ...servers.imap, user: email },
        ...(reconnect
          ? {
              status: sendingStatus(
                existing.daily_limit,
                existing.ramp,
                localDate(existing.created_at, workspace.timezone),
                localDate(ctx.clock.now(), workspace.timezone),
              ),
              status_reason: null,
            }
          : {}),
        ...(state.d.from_name ? { from_name: state.d.from_name } : {}),
      })
      .where(eq(mailboxes.id, existing.id))
      .returning();
    if (!row) throw new OpenOutboundError("internal", "Mailbox update returned no row.");
    if (existing.secret_id) await ctx.vault.deleteSecret(existing.secret_id);
    if (reconnect) {
      await resolveMailboxDown(ctx, row, "Reconnected with OAuth; it sends again.");
      // Emails held on it while it could not send go out now.
      await ctx.jobs.wake(mailboxActiveKey(row.id));
    }
    mailbox = row;
  } else {
    const prepared = prepareMailbox(
      {
        email,
        from_name: state.d.from_name ?? claims.name,
        preset: state.p,
        daily_limit: state.d.daily_limit,
        signature: state.d.signature,
        auth: authType,
      },
      { workspace, today: localDate(ctx.clock.now(), workspace.timezone) },
    );
    mailbox = await insertMailbox(ctx, { ...prepared, values: { ...prepared.values, oauth } });
    created = true;
  }
  clearAccessTokenCache(mailbox.id);
  closeSmtpPools(mailbox.id);
  primeAccessToken(mailbox.id, tokens, secretId);
  await ctx.audit.record({
    operation: "mailboxes.oauth_callback",
    effect: "write",
    status: "ok",
    target: { type: "mailbox", id: mailbox.id },
    summary: `${created ? "Connected" : "Reconnected"} ${email} with ${state.p} OAuth`,
    workspaceId: workspace.id,
  });
  return { mailbox, created };
}
