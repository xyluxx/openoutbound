import type { OpContext } from "../../core/context.js";
import type { OpenOutboundError } from "../../core/errors.js";
import { failureOf, providerFailure } from "../../core/failures.js";
import type { Mailbox } from "../../db/schema/index.js";
import { getAccessToken } from "./oauth.js";

/** Login for SMTP or IMAP: a password, or an XOAUTH2 access token. */
export type MailAuth =
  | { kind: "password"; user: string; pass: string }
  | { kind: "oauth2"; user: string; accessToken: string; expiresAt: Date };

export function passwordSecretName(email: string): string {
  return `mailbox:${email}:password`;
}

/**
 * Mailbox passwords are stored as one vault secret: `{"v":1,"smtp":"...","imap":"..."}` so the
 * rare setups with different SMTP and IMAP passwords fit the single `secret_id`. A plain string
 * (not this JSON) is read as the password for both.
 */
export function encodePasswords(smtp: string, imap?: string | null): string {
  return JSON.stringify({ v: 1, smtp, imap: imap ?? smtp });
}

export function decodePasswords(raw: string): { smtp: string; imap: string } {
  try {
    const value = JSON.parse(raw) as { v?: unknown; smtp?: unknown; imap?: unknown };
    if (value && value.v === 1 && typeof value.smtp === "string") {
      return { smtp: value.smtp, imap: typeof value.imap === "string" ? value.imap : value.smtp };
    }
  } catch {
    // plain password
  }
  return { smtp: raw, imap: raw };
}

/** Stores (or replaces) a mailbox password in the vault; returns the secret id. */
export function storePasswords(
  ctx: OpContext,
  workspaceId: string,
  email: string,
  smtp: string,
  imap?: string | null,
): Promise<string> {
  return ctx.vault.putSecret(workspaceId, passwordSecretName(email), encodePasswords(smtp, imap));
}

/** An auth failure the caller should turn into mailbox status `error`. */
export function mailAuthError(message: string, hint: string): OpenOutboundError {
  return providerFailure({
    provider: "mailbox",
    name: "The mailbox",
    class: "auth_invalid",
    scope: "call",
    message,
    hint,
    details: { reason: "auth" },
  });
}

/**
 * True for errors that mean this mailbox cannot log in (bad password, revoked OAuth grant): an
 * `auth_invalid` failure of the mailbox itself. A rejected engine OAuth client (scope account)
 * concerns every mailbox and is not one.
 */
export function isAuthFailure(error: unknown): boolean {
  const failure = failureOf(error);
  return failure?.class === "auth_invalid" && failure.scope === "call";
}

/** Credentials for SMTP or IMAP, refreshing OAuth access tokens as needed. */
export async function mailAuth(
  ctx: OpContext,
  mailbox: Mailbox,
  protocol: "smtp" | "imap",
): Promise<MailAuth> {
  const config = protocol === "smtp" ? mailbox.smtp : mailbox.imap;
  const user = config?.user || mailbox.email;
  if (mailbox.auth_type === "oauth_google" || mailbox.auth_type === "oauth_microsoft") {
    const { token, expiresAt } = await getAccessToken(ctx, mailbox);
    return { kind: "oauth2", user, accessToken: token, expiresAt };
  }
  if (!mailbox.secret_id) {
    throw mailAuthError(
      `Mailbox ${mailbox.email} has no password stored.`,
      `Set one with manage_mailboxes action update (mailbox_id ${mailbox.id}, password_env or password).`,
    );
  }
  const raw = await ctx.vault.getSecret(mailbox.secret_id, mailbox.workspace_id);
  if (raw === null) {
    throw mailAuthError(
      `The password of mailbox ${mailbox.email} is missing from the vault.`,
      `Set it again with manage_mailboxes action update (mailbox_id ${mailbox.id}).`,
    );
  }
  const passwords = decodePasswords(raw);
  return { kind: "password", user, pass: protocol === "smtp" ? passwords.smtp : passwords.imap };
}
