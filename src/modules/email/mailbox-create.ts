import { isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { OpContext } from "../../core/context.js";
import type { MailboxAuthType, MailboxProviderLabel } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import {
  type Mailbox,
  type MailServerConfig,
  mailboxes,
  type NewMailbox,
  type RampConfig,
  type Workspace,
} from "../../db/schema/index.js";
import {
  DEFAULT_DAILY_LIMIT,
  DEFAULT_RAMP,
  SAFE_DAILY_LIMIT,
  sendingStatus,
  WARMED_UP_RAMP,
} from "./capacity.js";
import { storePasswords } from "./credentials.js";
import {
  defaultSecure,
  isMicrosoftHost,
  isOnMicrosoftAddress,
  MAILBOX_PRESETS,
  type MailboxPreset,
  PRESET_NOTES,
  PRESET_SERVERS,
  presetForHost,
} from "./presets.js";

export const securitySchema = z
  .enum(["tls", "starttls"])
  .describe("tls = implicit TLS (465/993); starttls = upgrade on 587/143");

export const rampInput = z
  .object({
    enabled: z.boolean().default(true),
    start: z.number().int().min(0).max(500).default(DEFAULT_RAMP.start),
    increment: z.number().int().min(0).max(100).default(DEFAULT_RAMP.increment),
    every_days: z.number().int().min(1).max(30).default(DEFAULT_RAMP.every_days),
    delay_days: z
      .number()
      .int()
      .min(0)
      .max(60)
      .optional()
      .describe("Days with no cold email first (new mailboxes default to 14)"),
  })
  .describe(
    "Gradual volume: nothing for `delay_days`, then `start` a day, plus `increment` every `every_days`, up to daily_limit. Default: 2 quiet weeks, then 5 a day, +5 a week, 30 from week 8",
  );

/** Mailbox settings shared by add, CSV import and OAuth connect. */
export interface MailboxInput {
  email: string;
  from_name?: string | null | undefined;
  preset?: MailboxPreset | undefined;
  smtp_host?: string | undefined;
  smtp_port?: number | undefined;
  smtp_security?: "tls" | "starttls" | undefined;
  smtp_username?: string | undefined;
  imap_host?: string | undefined;
  imap_port?: number | undefined;
  imap_security?: "tls" | "starttls" | undefined;
  imap_username?: string | undefined;
  password?: string | null | undefined;
  imap_password?: string | null | undefined;
  daily_limit?: number | undefined;
  min_gap_seconds?: number | undefined;
  max_gap_seconds?: number | undefined;
  ramp?: z.output<typeof rampInput> | null | undefined;
  warmed_up?: boolean | undefined;
  signature?: string | null | undefined;
  warmup_patterns?: string[] | undefined;
  /** OAuth mailboxes (set by the OAuth callback). */
  auth?: "oauth_google" | "oauth_microsoft" | undefined;
}

export interface PreparedMailbox {
  values: Omit<NewMailbox, "secret_id">;
  passwords: { smtp: string; imap: string } | null;
  warnings: string[];
}

/** Warning for a daily limit above the safe level (add and update give the same one). */
export function dailyLimitWarning(dailyLimit: number): string | null {
  return dailyLimit > SAFE_DAILY_LIMIT
    ? `daily_limit ${dailyLimit} is high for cold email; ${DEFAULT_DAILY_LIMIT} a mailbox is the safe default.`
    : null;
}

export const NO_RAMP_WARNING = "No ramp: the mailbox sends up to daily_limit from day one.";

function invalid(
  message: string,
  hint: string,
  details?: Record<string, unknown>,
): OpenOutboundError {
  return new OpenOutboundError(
    "validation_failed",
    message,
    details ? { hint, details } : { hint },
  );
}

function isPrivateAddress(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a = 0, b = 0] = h.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (kind === 6) return h === "::1" || h === "::" || /^(fc|fd|fe[89ab])/.test(h);
  return false;
}

/**
 * Refuses local and private server addresses unless OPENOUTBOUND_ALLOW_PRIVATE_NETWORK is on
 * (a local relay), so mailbox settings cannot be used to probe the engine's network.
 */
export function assertMailHostAllowed(
  allowPrivate: boolean,
  host: string | null | undefined,
): void {
  if (!host || allowPrivate || !isPrivateAddress(host)) return;
  throw invalid(
    `Mail server ${host} is a local or private address.`,
    "Use the provider's public host name, or set OPENOUTBOUND_ALLOW_PRIVATE_NETWORK=true on the engine to use a local relay.",
    { host },
  );
}

/** Refuses sender addresses that must never send cold email. */
export function assertSendableAddress(email: string): void {
  if (isOnMicrosoftAddress(email)) {
    throw invalid(
      `${email} is an onmicrosoft.com address, which Microsoft caps at 100 external recipients a day.`,
      "Add a custom domain to the Microsoft 365 tenant and connect a mailbox on that domain (manage_mailboxes action oauth_start, provider microsoft).",
      { email },
    );
  }
}

function server(
  preset: MailboxPreset,
  kind: "smtp" | "imap",
  input: MailboxInput,
  user: string,
): MailServerConfig | null {
  const host = (kind === "smtp" ? input.smtp_host : input.imap_host)?.trim().toLowerCase();
  const port = kind === "smtp" ? input.smtp_port : input.imap_port;
  const security = kind === "smtp" ? input.smtp_security : input.imap_security;
  const base = preset === "custom" ? null : PRESET_SERVERS[preset][kind];
  const finalHost = host || base?.host;
  if (!finalHost) return null;
  const finalPort =
    port ?? (host ? (kind === "smtp" ? 587 : 993) : base?.port) ?? (kind === "smtp" ? 587 : 993);
  const secure = security
    ? security === "tls"
    : host && port
      ? defaultSecure(finalPort)
      : (base?.secure ?? defaultSecure(finalPort));
  return { host: finalHost, port: finalPort, secure, user };
}

/**
 * Validates mailbox settings and builds the row: preset servers (host overrides allowed),
 * limits, the playbook ramp for new senders (status `warming` until it is complete), auth
 * type. Microsoft mailboxes need OAuth; Google and Zoho need an app password (or OAuth for
 * Google); sandbox workspaces need no credentials.
 */
export function prepareMailbox(
  input: MailboxInput,
  options: { workspace: Workspace; today: string; allowPrivateNetwork?: boolean },
): PreparedMailbox {
  const email = input.email.trim().toLowerCase();
  if (!z.email().safeParse(email).success) {
    throw invalid(
      `"${input.email}" is not a valid email address.`,
      "Pass the full sender address, e.g. sam@brand.example.com.",
    );
  }
  assertSendableAddress(email);
  const warnings: string[] = [];
  const preset: MailboxPreset =
    input.preset ??
    (input.smtp_host ? (presetForHost(input.smtp_host) as MailboxPreset) : "custom");
  if (!(MAILBOX_PRESETS as readonly string[]).includes(preset)) {
    throw invalid(`Unknown preset "${preset}".`, `Use one of: ${MAILBOX_PRESETS.join(", ")}.`);
  }
  const smtpUser = input.smtp_username?.trim() || email;
  const smtp = server(preset, "smtp", input, smtpUser);
  const imap = server(preset, "imap", input, input.imap_username?.trim() || smtpUser);
  assertMailHostAllowed(options.allowPrivateNetwork ?? false, smtp?.host);
  assertMailHostAllowed(options.allowPrivateNetwork ?? false, imap?.host);
  const sandbox = options.workspace.is_sandbox;
  const password = input.password?.trim() ? input.password : null;
  const imapPassword = input.imap_password?.trim() ? input.imap_password : null;

  let authType: MailboxAuthType;
  if (input.auth) authType = input.auth;
  else if (sandbox && !password) authType = "sandbox";
  else authType = "password";

  const microsoft =
    preset === "microsoft" || isMicrosoftHost(smtp?.host) || isMicrosoftHost(imap?.host);
  if (authType === "password") {
    if (microsoft) {
      throw invalid(
        "Microsoft 365 mailboxes cannot use password login.",
        `${PRESET_NOTES.microsoft} Password login stays available for custom (non-Microsoft) hosts only.`,
        { preset },
      );
    }
    if (!smtp) {
      throw invalid(
        "A custom mailbox needs smtp_host (and imap_host to sync replies).",
        PRESET_NOTES.custom,
      );
    }
    if (!password) {
      const hint = preset === "custom" ? PRESET_NOTES.custom : PRESET_NOTES[preset];
      throw invalid(
        `Mailbox ${email} needs a password or app password.`,
        `${hint} Pass it with password_env (the name of an environment variable) or through the CLI; never paste it into a chat.`,
      );
    }
    if (!imap)
      warnings.push(
        "No IMAP server: replies, bounces and unsubscribes sent to this mailbox will not be read.",
      );
  }
  if (preset === "zoho" && !input.smtp_host) warnings.push(PRESET_NOTES.zoho);

  const dailyLimit = input.daily_limit ?? DEFAULT_DAILY_LIMIT;
  const limitWarning = dailyLimitWarning(dailyLimit);
  if (limitWarning) warnings.push(limitWarning);
  const minGap = input.min_gap_seconds ?? 240;
  const maxGap = input.max_gap_seconds ?? 720;
  if (minGap > maxGap) {
    throw invalid(
      "min_gap_seconds is larger than max_gap_seconds.",
      "Pass min_gap_seconds <= max_gap_seconds (defaults 240 and 720).",
    );
  }
  // Sandbox mailboxes have no domain to set up: they skip the two quiet weeks but still ramp.
  const quietDays = sandbox || authType === "sandbox" ? 0 : (DEFAULT_RAMP.delay_days ?? 0);
  let ramp: RampConfig | null = null;
  if (input.ramp === null) ramp = null;
  else if (input.ramp) {
    ramp = {
      ...input.ramp,
      delay_days: input.ramp.delay_days ?? (input.warmed_up ? 0 : quietDays),
      started_at: options.today,
    };
  } else if (input.warmed_up) ramp = { ...WARMED_UP_RAMP, started_at: options.today };
  else ramp = { ...DEFAULT_RAMP, delay_days: quietDays, started_at: options.today };
  if (input.warmed_up && !input.ramp && input.ramp !== null) {
    warnings.push(
      "Pre-warmed: the ramp starts at week 5 (15 a day, +5 a week up to daily_limit). Pass ramp: null only for a mailbox that already sends cold email at full volume.",
    );
  }
  if (ramp === null) warnings.push(NO_RAMP_WARNING);

  const label: MailboxProviderLabel = preset;
  const values: Omit<NewMailbox, "secret_id"> = {
    workspace_id: options.workspace.id,
    email,
    from_name: input.from_name?.trim() || null,
    provider_label: label,
    auth_type: authType,
    smtp,
    imap,
    daily_limit: dailyLimit,
    ramp,
    min_gap_seconds: minGap,
    max_gap_seconds: maxGap,
    signature: input.signature?.trim() || null,
    warmup_patterns: input.warmup_patterns ?? [],
    // Whether the server keeps sent copies is proven later, by a copy of one of the engine's
    // own emails in the Sent folder (`sent_copies_seen_at`); the provider is only a hint.
    // `warming` until the ramp reaches daily_limit (the health job then sets `active`).
    status: sendingStatus(dailyLimit, ramp, options.today, options.today),
  };
  return {
    values,
    passwords:
      authType === "password" && password
        ? { smtp: password, imap: imapPassword ?? password }
        : null,
    warnings,
  };
}

/** Throws `conflict` when the workspace already has this address. */
export async function assertNewMailbox(
  ctx: OpContext,
  workspaceId: string,
  email: string,
): Promise<void> {
  const [existing] = await ctx.db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.workspace_id, workspaceId), eq(mailboxes.email, email)))
    .limit(1);
  if (existing) {
    throw new OpenOutboundError("conflict", `Mailbox ${email} already exists (${existing.id}).`, {
      hint: `Change it with manage_mailboxes action update (mailbox_id ${existing.id}) instead.`,
      details: { mailbox_id: existing.id },
    });
  }
}

/** Stores the password in the vault and inserts the mailbox. */
export async function insertMailbox(ctx: OpContext, prepared: PreparedMailbox): Promise<Mailbox> {
  const { values } = prepared;
  await assertNewMailbox(ctx, values.workspace_id, values.email);
  const secretId = prepared.passwords
    ? await storePasswords(
        ctx,
        values.workspace_id,
        values.email,
        prepared.passwords.smtp,
        prepared.passwords.imap,
      )
    : null;
  const [row] = await ctx.db
    .insert(mailboxes)
    .values({ ...values, secret_id: secretId })
    .returning();
  if (!row) throw new OpenOutboundError("internal", "Mailbox insert returned no row.");
  return row;
}
