import type { OpContext } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import type { Mailbox, Workspace } from "../../db/schema/index.js";
import type { OutgoingEmail } from "./compose.js";
import { mailAuth } from "./credentials.js";
import { sandboxTransport } from "./sandbox-transport.js";
import { smtpTransport } from "./smtp-transport.js";

/** Per-recipient rejection reported by the server. */
export interface RecipientRejection {
  recipient: string | null;
  responseCode: number | null;
  response: string | null;
}

export interface SendResult {
  /** Server queue id or response line, when the server gave one. */
  providerMessageId: string | null;
  accepted: string[];
  rejected: string[];
  rejectedErrors: RecipientRejection[];
  response: string | null;
}

export interface SendOptions {
  /** Fires when the job that sends ended (timeout, shutdown): the send is stopped then. */
  signal?: AbortSignal;
}

/** Delivers rendered emails. Implementations: SMTP (nodemailer pool) and sandbox (outbox). */
export interface EmailTransport {
  readonly kind: "smtp" | "sandbox";
  /** Hands the email over. SMTP stops at its deadline or when `signal` fires (smtp-transport.ts). */
  send(email: OutgoingEmail, options?: SendOptions): Promise<SendResult>;
  /** Connects and logs in without sending (mailbox tests). */
  verify(): Promise<void>;
}

/** Sandbox workspaces and sandbox mailboxes never open sockets. */
export function usesSandboxTransport(workspace: Workspace, mailbox: Mailbox): boolean {
  return (
    workspace.is_sandbox || mailbox.auth_type === "sandbox" || mailbox.provider_label === "sandbox"
  );
}

/** The transport for a mailbox of the context workspace (credentials resolved from the vault). */
export async function transportFor(
  ctx: OpContext,
  workspace: Workspace,
  mailbox: Mailbox,
): Promise<EmailTransport> {
  if (usesSandboxTransport(workspace, mailbox)) {
    return sandboxTransport({ mailboxId: mailbox.id, workspaceId: workspace.id, clock: ctx.clock });
  }
  if (!mailbox.smtp?.host) {
    throw new OpenOutboundError("provider_error", `Mailbox ${mailbox.email} has no SMTP server.`, {
      hint: `Set smtp_host and smtp_port with manage_mailboxes action update (mailbox_id ${mailbox.id}).`,
      details: { reason: "config" },
    });
  }
  const auth = await mailAuth(ctx, mailbox, "smtp");
  return smtpTransport({
    mailboxId: mailbox.id,
    host: mailbox.smtp.host,
    port: mailbox.smtp.port,
    secure: mailbox.smtp.secure,
    auth,
    name: mailbox.email.slice(mailbox.email.lastIndexOf("@") + 1),
  });
}
