import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { OpContext } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { type Mailbox, mailboxes } from "../../../db/schema/index.js";
import { securitySchema } from "../mailbox-create.js";

export const mailboxIdInput = z
  .string()
  .min(1)
  .describe("Mailbox id (mbx_...), from manage_mailboxes action list");

/**
 * Only `MAILBOX_*` variables can be read: an agent must never be able to route an unrelated
 * secret (API keys) into a mailbox login on a server it chose.
 */
const ENV_NAME = /^MAILBOX_[A-Z0-9_]{1,120}$/;

/** SMTP/IMAP overrides shared by add and update. */
export const serverFields = {
  smtp_host: z.string().min(3).max(253).optional().describe("SMTP server (custom or override)"),
  smtp_port: z.number().int().min(1).max(65_535).optional().describe("465 (TLS) or 587 (STARTTLS)"),
  smtp_security: securitySchema.optional(),
  smtp_username: z
    .string()
    .max(320)
    .optional()
    .describe("SMTP login when it differs from the address"),
  imap_host: z.string().min(3).max(253).optional().describe("IMAP server for replies and bounces"),
  imap_port: z.number().int().min(1).max(65_535).optional().describe("Usually 993"),
  imap_security: securitySchema.optional(),
  imap_username: z.string().max(320).optional().describe("IMAP login when it differs"),
};

/** Password inputs: a value (CLI/REST) or the name of an environment variable (agents). */
export const credentialFields = {
  password: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Password or app password. Stored encrypted in the vault and never returned. Agents should pass password_env instead so the secret stays out of the conversation.",
    ),
  password_env: z
    .string()
    .regex(ENV_NAME)
    .optional()
    .describe(
      "Name of an environment variable on the engine host that holds the password; must start with MAILBOX_ (e.g. MAILBOX_SAM_PASSWORD)",
    ),
  imap_password: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe("Only when the IMAP password differs from the SMTP one"),
  imap_password_env: z
    .string()
    .regex(ENV_NAME)
    .optional()
    .describe("Like password_env, for a different IMAP password"),
};

/** The secret from a direct value or an environment variable name (never both). */
export function resolveSecret(
  ctx: OpContext,
  value: string | undefined,
  envName: string | undefined,
  field: string,
): string | undefined {
  if (value !== undefined && envName !== undefined) {
    throw new OpenOutboundError("validation_failed", `Pass ${field} or ${field}_env, not both.`, {
      hint: `Keep ${field}_env (the variable name) and drop ${field}.`,
    });
  }
  if (envName === undefined) return value;
  const secret = ctx.config.env[envName];
  if (!secret?.trim()) {
    throw new OpenOutboundError(
      "validation_failed",
      `Environment variable ${envName} is not set on the engine host.`,
      {
        hint: `Add ${envName}=... to the engine's .env (or environment), restart the engine, then retry.`,
        details: { field: `${field}_env` },
      },
    );
  }
  return secret;
}

/** The workspace mailbox, or `not_found` with a hint. */
export async function loadMailbox(
  ctx: OpContext,
  workspaceId: string,
  mailboxId: string,
): Promise<Mailbox> {
  const [row] = await ctx.db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.workspace_id, workspaceId), eq(mailboxes.id, mailboxId)));
  if (!row) {
    throw new OpenOutboundError("not_found", `Mailbox ${mailboxId} not found in this workspace.`, {
      hint: "List mailboxes with manage_mailboxes action list and use one of their ids.",
      details: { what: "Mailbox", id: mailboxId },
    });
  }
  return row;
}
