import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { MAILBOX_STATUSES } from "../../../core/enums.js";
import { defineOperation } from "../../../core/operation.js";
import { mailboxes, type RampConfig } from "../../../db/schema/index.js";
import { restartedRamp, sendingStatus } from "../capacity.js";
import { holdUntilResumed, pauseMailbox } from "../mailbox-state.js";
import { mailboxSummarySchema, summarizeMailboxes } from "../mailbox-summary.js";
import { testAndRecord } from "../mailbox-test.js";
import { mailboxActiveKey } from "../queue.js";
import { resolveMailboxDown } from "../send-problems.js";
import { localDate } from "../timezone.js";
import { mailboxTestSchema } from "./add.js";
import { loadMailbox, mailboxIdInput } from "./shared.js";
import { queuedCount } from "./update.js";

export const pauseMailboxOperation = defineOperation({
  id: "mailboxes.pause",
  summary: "Pause sending from a mailbox (replies keep syncing)",
  description:
    "Stops new sends from a mailbox; IMAP sync keeps reading replies, bounces and unsubscribes. Scheduled emails move to the campaign's other mailboxes when they come due, or wait for the resume. The reason (the common reason field) is stored and shown in action list. Use it after a deliverability warning or while fixing DNS; resume with action resume.",
  effect: "write",
  input: z.object({ mailbox_id: mailboxIdInput }),
  output: z.object({
    mailbox_id: z.string(),
    email: z.string(),
    status: z.enum(MAILBOX_STATUSES),
    status_reason: z.string().nullable(),
    scheduled_messages: z.number().int(),
  }),
  http: { method: "POST", path: "/v1/mailboxes/:mailbox_id/pause" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Pause a mailbox", input: { mailbox_id: "mbx_01jabcdefghjkmnpqrstvwxyz0" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const mailbox = await loadMailbox(ctx, workspace.id, input.mailbox_id);
    const reason = ctx.request.reason?.trim() || `Paused by ${ctx.principal.name}`;
    await pauseMailbox(ctx, mailbox, reason, { notify: false });
    // A person's pause holds until someone resumes it, even over a timed (48-hour) auto-pause.
    await holdUntilResumed(ctx, mailbox);
    const current = await loadMailbox(ctx, workspace.id, mailbox.id);
    return {
      mailbox_id: current.id,
      email: current.email,
      status: current.status,
      status_reason: current.status_reason,
      scheduled_messages: await queuedCount(ctx, current),
    };
  },
});

export const resumeMailboxOperation = defineOperation({
  id: "mailboxes.resume",
  summary: "Resume sending from a paused or failed mailbox",
  description:
    "Sets a mailbox back to sending (active, or warming while its ramp runs), clears its failure streak, provider throttle and auto-pause, and wakes emails that waited for it. The bounce-rate check then counts only sends from the resume on. After a bounce-rate or provider-block pause fix the cause first and pass restart_ramp: true so volume restarts at the ramp start (5 a day by default, +5 a week). A domain block pauses every mailbox on the domain: resume each one. If the mailbox was in error, run action test first: sends fail again while the login is broken.",
  effect: "write",
  input: z.object({
    mailbox_id: mailboxIdInput,
    restart_ramp: z
      .boolean()
      .default(false)
      .describe("Restart the ramp today at its start volume (5 a day by default)"),
  }),
  output: z.object({ mailbox: mailboxSummarySchema, warnings: z.array(z.string()) }),
  http: { method: "POST", path: "/v1/mailboxes/:mailbox_id/resume" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Resume after a bounce pause",
      input: { mailbox_id: "mbx_01jabcdefghjkmnpqrstvwxyz0", restart_ramp: true },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const mailbox = await loadMailbox(ctx, workspace.id, input.mailbox_id);
    const warnings: string[] = [];
    if (mailbox.status === "error") {
      warnings.push(
        `The mailbox was in error (${mailbox.status_reason ?? "login failed"}). Run action test to confirm the login works.`,
      );
    }
    const now = ctx.clock.now();
    const pause = mailbox.status === "paused" ? mailbox.health?.auto_pause : null;
    const until = pause?.until ? new Date(pause.until) : null;
    if (until && until > now) {
      warnings.push(
        `This mailbox was paused until ${until.toISOString()} after a provider block (${pause?.status ?? "x.7.28"}) on ${pause?.domain ?? "its domain"}. Resuming early risks a longer block; the other mailboxes on the domain stay paused until their own resume.`,
      );
    }
    const today = localDate(now, workspace.timezone);
    const ramp: RampConfig | null = input.restart_ramp
      ? restartedRamp(mailbox.ramp, today)
      : mailbox.ramp;
    // The bounce-rate check counts from here: bounces before the resume cannot pause it again.
    const reset = {
      consecutive_failures: 0,
      throttled_until: null,
      auto_pause: null,
      resumed_at: now.toISOString(),
    };
    const [row] = await ctx.db
      .update(mailboxes)
      .set({
        status: sendingStatus(
          mailbox.daily_limit,
          ramp,
          localDate(mailbox.created_at, workspace.timezone),
          today,
        ),
        status_reason: null,
        ramp,
        health: sql`${mailboxes.health} || ${JSON.stringify(reset)}::jsonb`,
      })
      .where(eq(mailboxes.id, mailbox.id))
      .returning();
    await ctx.jobs.wake(mailboxActiveKey(mailbox.id));
    await resolveMailboxDown(ctx, mailbox, `Resumed by ${ctx.principal.name}.`);
    const [summary] = await summarizeMailboxes(ctx, workspace, [row ?? mailbox]);
    if (!summary) throw new Error("mailboxes.resume: summary missing");
    return { mailbox: summary, warnings };
  },
});

export const testMailboxOperation = defineOperation({
  id: "mailboxes.test",
  summary: "Test a mailbox's SMTP and IMAP login without sending",
  description:
    "Connects to the mailbox's SMTP server (TLS verified) and IMAP server and logs in, without sending anything. A refused SMTP login sets the mailbox to error and a clean one brings an error mailbox back; IMAP problems are recorded in last_sync_error and last_sync_failure (replies are not read) without stopping sends, and a refused IMAP login opens a mailbox_down problem for reading that a clean test closes. Use it after adding a mailbox, changing a password or when sends or reply sync fail with auth errors. Sandbox mailboxes always pass.",
  effect: "write",
  input: z.object({ mailbox_id: mailboxIdInput }),
  output: mailboxTestSchema.extend({
    mailbox_id: z.string(),
    email: z.string(),
    status: z.enum(MAILBOX_STATUSES),
    hint: z.string().nullable(),
  }),
  http: { method: "POST", path: "/v1/mailboxes/:mailbox_id/test" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Test a login", input: { mailbox_id: "mbx_01jabcdefghjkmnpqrstvwxyz0" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const mailbox = await loadMailbox(ctx, workspace.id, input.mailbox_id);
    const { result, mailbox: current } = await testAndRecord(ctx, workspace, mailbox);
    let hint: string | null = null;
    if (result.auth_failed) {
      hint =
        current.auth_type === "password"
          ? `Check the password or app password and set it with manage_mailboxes action update (mailbox_id ${current.id}, password_env).`
          : `Reconnect with manage_mailboxes action oauth_start (email ${current.email}).`;
    } else if (result.error) {
      hint = "Check host, port and security (TLS on 465/993, STARTTLS on 587) with action update.";
    }
    return {
      ...result,
      mailbox_id: current.id,
      email: current.email,
      status: current.status,
      hint,
    };
  },
});
