import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { OpenOutboundError } from "../../../core/errors.js";
import {
  awaitingApproval,
  awaitingApprovalOutput,
  defineOperation,
  dryRun,
  dryRunOutput,
} from "../../../core/operation.js";
import {
  type Mailbox,
  type MailServerConfig,
  mailboxes,
  messages,
  type NewMailbox,
} from "../../../db/schema/index.js";
import { mustRequestApproval } from "../../../runtime/approval-rule.js";
import { SAFE_DAILY_LIMIT } from "../capacity.js";
import { storePasswords } from "../credentials.js";
import { dailyLimitInput, requestLimitsApproval } from "../limits-approval.js";
import { assertMailHostAllowed, rampInput } from "../mailbox-create.js";
import { reviewVolume, type VolumeChange, volumePatch } from "../mailbox-limits.js";
import { resolveReadDown } from "../mailbox-state.js";
import { mailboxSummarySchema, summarizeMailboxes } from "../mailbox-summary.js";
import { clearAccessTokenCache } from "../oauth.js";
import { defaultSecure, isMicrosoftHost, PRESET_NOTES } from "../presets.js";
import { mailboxActiveKey } from "../queue.js";
import { resolveMailboxDown } from "../send-problems.js";
import { closeSmtpPools } from "../smtp-transport.js";
import { localDate } from "../timezone.js";
import {
  credentialFields,
  loadMailbox,
  mailboxIdInput,
  resolveSecret,
  serverFields,
} from "./shared.js";

type ServerInput = {
  host?: string | undefined;
  port?: number | undefined;
  security?: "tls" | "starttls" | undefined;
  username?: string | undefined;
};

function mergeServer(
  current: MailServerConfig | null,
  change: ServerInput,
  email: string,
  defaultPort: number,
): MailServerConfig | null {
  if (!change.host && !change.port && !change.security && !change.username) return current;
  const host = change.host?.trim().toLowerCase() || current?.host;
  if (!host) return null;
  const port = change.port ?? (change.host ? defaultPort : (current?.port ?? defaultPort));
  const secure = change.security
    ? change.security === "tls"
    : change.port || change.host
      ? defaultSecure(port)
      : (current?.secure ?? defaultSecure(port));
  return { host, port, secure, user: change.username?.trim() || current?.user || email };
}

/** Another server or login: what was learned about the old one does not carry over. */
function otherAccount(before: MailServerConfig | null, after: MailServerConfig | null): boolean {
  return before?.host !== after?.host || before?.user !== after?.user;
}

export const updateMailbox = defineOperation({
  id: "mailboxes.update",
  summary: "Change a mailbox's limits, ramp, gaps, signature, servers or password",
  description: `Updates one mailbox: from name, daily limit, ramp (null turns it off; restart_ramp starts it again today at its start volume, 5 a day by default, without the two setup weeks), gaps between sends, signature, warmup patterns, SMTP/IMAP servers and the password (password_env preferred). Only the fields you pass change; a daily limit above ${SAFE_DAILY_LIMIT} or no ramp returns warnings. Unless the caller is a person holding the approve scope, raising the daily limit above ${SAFE_DAILY_LIMIT} or turning off or shortening the ramp of a mailbox that is still warming needs an approval: that part waits (awaiting_approval) while the other fields change at once. OAuth mailboxes cannot switch to a password here; reconnect them with action oauth_start. To stop sending use action pause instead of setting a tiny limit.`,
  effect: "write",
  input: z.object({
    mailbox_id: mailboxIdInput,
    from_name: z.string().max(100).nullable().optional(),
    daily_limit: dailyLimitInput
      .optional()
      .describe(`Emails a day; above ${SAFE_DAILY_LIMIT} is high for cold email`),
    min_gap_seconds: z.number().int().min(0).max(86_400).optional(),
    max_gap_seconds: z.number().int().min(0).max(86_400).optional(),
    ramp: rampInput.nullable().optional().describe("New ramp settings, or null to turn it off"),
    restart_ramp: z
      .boolean()
      .optional()
      .describe("Start the ramp again today at its start volume (5 a day by default)"),
    signature: z.string().max(2000).nullable().optional(),
    warmup_patterns: z.array(z.string().min(3).max(200)).max(20).optional(),
    ...serverFields,
    ...credentialFields,
  }),
  output: z.union([
    z.object({
      mailbox: mailboxSummarySchema,
      changed: z.array(z.string()),
      warnings: z.array(z.string()),
    }),
    awaitingApprovalOutput,
  ]),
  http: { method: "PATCH", path: "/v1/mailboxes/:mailbox_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Raise the limit and widen the gaps",
      input: {
        mailbox_id: "mbx_01jabcdefghjkmnpqrstvwxyz0",
        daily_limit: 40,
        min_gap_seconds: 300,
        max_gap_seconds: 900,
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const mailbox = await loadMailbox(ctx, workspace.id, input.mailbox_id);
    const today = localDate(ctx.clock.now(), workspace.timezone);
    const patch: Partial<NewMailbox> = {};
    const changed: string[] = [];
    const set = <K extends keyof NewMailbox>(key: K, value: NewMailbox[K]) => {
      patch[key] = value;
      changed.push(key);
    };

    const minGap = input.min_gap_seconds ?? mailbox.min_gap_seconds;
    const maxGap = input.max_gap_seconds ?? mailbox.max_gap_seconds;
    if (minGap > maxGap) {
      throw new OpenOutboundError(
        "validation_failed",
        `min_gap_seconds (${minGap}) is larger than max_gap_seconds (${maxGap}).`,
        { hint: "Pass both min_gap_seconds and max_gap_seconds with min <= max." },
      );
    }

    // Daily limit and ramp warn like mailboxes.add; a risky change waits for a person with
    // approve unless that person is the caller (one approval rule, spec 2).
    const volumeChange: VolumeChange = {
      daily_limit: input.daily_limit,
      ramp: input.ramp,
      restart_ramp: input.restart_ramp,
    };
    const volume = volumePatch(mailbox, volumeChange, workspace.timezone, today);
    const review = reviewVolume(mailbox, volume, workspace.timezone, today);
    const held = mustRequestApproval(ctx.principal) && review.needsApproval.length > 0;

    if (input.from_name !== undefined) set("from_name", input.from_name?.trim() || null);
    if (!held && volume.daily_limit !== undefined) set("daily_limit", volume.daily_limit);
    if (input.min_gap_seconds !== undefined) set("min_gap_seconds", input.min_gap_seconds);
    if (input.max_gap_seconds !== undefined) set("max_gap_seconds", input.max_gap_seconds);
    if (!held && volume.ramp !== undefined) set("ramp", volume.ramp);
    // `warming` while the ramp is below the daily limit, `active` once it is complete.
    if (!held && volume.status !== undefined) patch.status = volume.status;
    if (input.signature !== undefined) set("signature", input.signature?.trim() || null);
    if (input.warmup_patterns !== undefined) set("warmup_patterns", input.warmup_patterns);

    const smtp = mergeServer(
      mailbox.smtp,
      {
        host: input.smtp_host,
        port: input.smtp_port,
        security: input.smtp_security,
        username: input.smtp_username,
      },
      mailbox.email,
      587,
    );
    const imap = mergeServer(
      mailbox.imap,
      {
        host: input.imap_host,
        port: input.imap_port,
        security: input.imap_security,
        username: input.imap_username,
      },
      mailbox.email,
      993,
    );
    const serversChanged = smtp !== mailbox.smtp || imap !== mailbox.imap;
    if (smtp !== mailbox.smtp) set("smtp", smtp);
    if (imap !== mailbox.imap) set("imap", imap);
    // A copy found through another server or account proves nothing about the new one.
    if (otherAccount(mailbox.smtp, smtp) || otherAccount(mailbox.imap, imap)) {
      patch.sent_copies_seen_at = null;
    }
    assertMailHostAllowed(ctx.config.allowPrivateNetwork, input.smtp_host);
    assertMailHostAllowed(ctx.config.allowPrivateNetwork, input.imap_host);

    const password = resolveSecret(ctx, input.password, input.password_env, "password");
    const imapPassword = resolveSecret(
      ctx,
      input.imap_password,
      input.imap_password_env,
      "imap_password",
    );
    const oauth = mailbox.auth_type === "oauth_google" || mailbox.auth_type === "oauth_microsoft";
    if ((password || imapPassword) && oauth) {
      throw new OpenOutboundError(
        "validation_failed",
        `Mailbox ${mailbox.email} signs in with OAuth; it has no password to change.`,
        {
          hint: "Reconnect it with manage_mailboxes action oauth_start, or remove it and add it again with an app password (not possible for Microsoft 365).",
        },
      );
    }
    const passwordAuth = mailbox.auth_type === "password" || Boolean(password);
    const microsoft = isMicrosoftHost(smtp?.host) || isMicrosoftHost(imap?.host);
    if (passwordAuth && microsoft && !oauth) {
      throw new OpenOutboundError(
        "validation_failed",
        "Microsoft 365 servers do not accept password login.",
        { hint: PRESET_NOTES.microsoft },
      );
    }
    let passwordChanged = false;
    if (password || imapPassword) {
      if (!password) {
        throw new OpenOutboundError(
          "validation_failed",
          "Pass password (or password_env) together with imap_password.",
          { hint: "Send both: the SMTP password and the IMAP one." },
        );
      }
      patch.secret_id = await storePasswords(
        ctx,
        workspace.id,
        mailbox.email,
        password,
        imapPassword,
      );
      passwordChanged = true;
      changed.push("password");
      if (mailbox.auth_type !== "password") set("auth_type", "password");
    }

    if (changed.length === 0 && !held) {
      throw new OpenOutboundError("validation_failed", "Nothing to update.", {
        hint: "Pass at least one field to change, e.g. daily_limit or signature.",
      });
    }
    let row: Mailbox = mailbox;
    if (changed.length > 0) {
      const [updated] = await ctx.db
        .update(mailboxes)
        .set(patch)
        .where(eq(mailboxes.id, mailbox.id))
        .returning();
      if (updated) row = updated;
    }
    if (serversChanged || passwordChanged) {
      closeSmtpPools(mailbox.id);
      clearAccessTokenCache(mailbox.id);
    }
    if (held) {
      const approvalId = await requestLimitsApproval(
        ctx,
        mailbox,
        volumeChange,
        review.needsApproval,
      );
      const rest = changed.length > 0 ? `Changed now: ${changed.join(", ")}.` : "";
      return awaitingApproval(
        approvalId,
        `A person with the approve scope must approve the request to ${review.needsApproval.join(" and ")} for ${mailbox.email} (review_items); until then its limit and ramp stay as they are. ${rest}`.trim(),
      );
    }
    const [summary] = await summarizeMailboxes(ctx, workspace, [row]);
    if (!summary) throw new Error("mailboxes.update: summary missing");
    return { mailbox: summary, changed, warnings: review.warnings };
  },
});

async function queuedCount(
  ctx: Parameters<typeof loadMailbox>[0],
  mailbox: Mailbox,
): Promise<number> {
  const [row] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, mailbox.workspace_id),
        eq(messages.mailbox_id, mailbox.id),
        inArray(messages.status, ["scheduled", "sending", "unknown"]),
      ),
    );
  return row?.count ?? 0;
}

const removePreview = z.object({
  mailbox_id: z.string(),
  email: z.string(),
  scheduled_messages: z.number().int(),
});

export const removeMailbox = defineOperation({
  id: "mailboxes.remove",
  summary: "Remove a mailbox and delete its stored credentials",
  description:
    "Deletes a mailbox and its password or OAuth token from the vault; sent history, threads and replies stay. Emails already scheduled on it move to the campaign's other mailboxes when they come due, or fail if there are none, so check scheduled_messages with dry_run first. To stop sending for a while use action pause instead.",
  effect: "destructive",
  input: z.object({ mailbox_id: mailboxIdInput }),
  output: z.union([
    removePreview.extend({ removed: z.literal(true) }),
    dryRunOutput(removePreview),
  ]),
  http: { method: "DELETE", path: "/v1/mailboxes/:mailbox_id" },
  dryRun: "supported",
  idempotent: false,
  workspace: "required",
  examples: [
    { title: "Remove a mailbox", input: { mailbox_id: "mbx_01jabcdefghjkmnpqrstvwxyz0" } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const mailbox = await loadMailbox(ctx, workspace.id, input.mailbox_id);
    const scheduled = await queuedCount(ctx, mailbox);
    const result = { mailbox_id: mailbox.id, email: mailbox.email, scheduled_messages: scheduled };
    if (ctx.request.dryRun) {
      const warnings = scheduled
        ? [
            `${scheduled} scheduled email(s) will move to other campaign mailboxes when due, or fail if there are none.`,
          ]
        : [];
      return dryRun(result, { warnings });
    }
    await ctx.db.delete(mailboxes).where(eq(mailboxes.id, mailbox.id));
    await resolveMailboxDown(ctx, mailbox, "The mailbox was removed.");
    await resolveReadDown(ctx, mailbox, "The mailbox was removed.");
    // Emails held on it while it could not send move or fail now instead of at their next look.
    await ctx.jobs.wake(mailboxActiveKey(mailbox.id));
    for (const secretId of [mailbox.secret_id, mailbox.oauth?.refresh_token_secret_id]) {
      if (secretId) await ctx.vault.deleteSecret(secretId);
    }
    closeSmtpPools(mailbox.id);
    clearAccessTokenCache(mailbox.id);
    return { ...result, removed: true as const };
  },
});

export { queuedCount };
