/**
 * `mailbox_limits` approvals: someone who must ask for approval (an agent, a service, a person
 * without approve) asked `mailboxes.update` to raise a daily limit above the safe level, or to
 * turn off or shorten the ramp of a mailbox that is still warming. The change waits for a
 * person; approve (or edit, for example a lower daily_limit) applies it the way the update
 * would have, reject keeps the mailbox as it is.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import type { ApprovalApplyResult, ApprovalResolver } from "../../core/operation.js";
import { type Mailbox, mailboxes } from "../../db/schema/index.js";
import { rampLimit } from "./capacity.js";
import { rampInput } from "./mailbox-create.js";
import { type VolumeChange, volumePatch } from "./mailbox-limits.js";
import { localDate } from "./timezone.js";

export const dailyLimitInput = z.number().int().min(1).max(500);

/** What the approval holds: the requested change, applied to the mailbox as it is on approval. */
const payloadSchema = z.object({
  mailbox_id: z.string(),
  daily_limit: dailyLimitInput.optional(),
  ramp: rampInput.nullable().optional(),
  restart_ramp: z.boolean().optional(),
});

/** Stores the approval for a held volume change. A newer request for the mailbox replaces it. */
export async function requestLimitsApproval(
  ctx: OpContext,
  mailbox: Mailbox,
  change: VolumeChange,
  reasons: readonly string[],
): Promise<string> {
  const payload: Record<string, unknown> = { mailbox_id: mailbox.id, email: mailbox.email };
  if (change.daily_limit !== undefined) payload.daily_limit = change.daily_limit;
  if (change.ramp !== undefined) payload.ramp = change.ramp;
  if (change.restart_ramp) payload.restart_ramp = true;
  payload.current = { daily_limit: mailbox.daily_limit, ramp: mailbox.ramp };
  const { id } = await ctx.approvals.request({
    kind: "mailbox_limits",
    title: `Change the sending volume of ${mailbox.email}`,
    summary: `${ctx.principal.name} asked to ${reasons.join(" and ")}. Approve to apply it (or edit daily_limit first); reject to keep the current limit and ramp.`,
    payload,
    target: { type: "mailbox", id: mailbox.id },
    supersede: true,
  });
  return id;
}

/** "up to 120 a day, no ramp" or "up to 30 a day, ramping (5 today)". */
function describeVolume(mailbox: Mailbox, timezone: string, today: string): string {
  if (!mailbox.ramp?.enabled) return `up to ${mailbox.daily_limit} a day, no ramp`;
  const now = rampLimit(
    mailbox.daily_limit,
    mailbox.ramp,
    localDate(mailbox.created_at, timezone),
    today,
  );
  return now >= mailbox.daily_limit
    ? `up to ${mailbox.daily_limit} a day, ramp complete`
    : `up to ${mailbox.daily_limit} a day, ramping (${now} today)`;
}

export const mailboxLimitsResolver: ApprovalResolver = {
  kind: "mailbox_limits",
  apply: async (ctx, approval, decision): Promise<ApprovalApplyResult> => {
    const mailboxId = String(approval.target_id ?? approval.payload.mailbox_id ?? "");
    const target = { type: "mailbox", id: mailboxId };
    if (decision.decision === "reject") {
      return { message: "Rejected: the mailbox keeps its daily limit and ramp.", target };
    }
    const parsed = payloadSchema.safeParse(approval.payload);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
      throw new OpenOutboundError(
        "validation_failed",
        `The volume change is not valid (${fields.join(", ")}).`,
        {
          hint: "Edit daily_limit to a whole number from 1 to 500 (ramp as manage_mailboxes action update takes it), then decide again with review_items.",
          details: { fields },
        },
      );
    }
    const workspace = requireWorkspace(ctx);
    const [mailbox] = await ctx.db
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.workspace_id, workspace.id), eq(mailboxes.id, mailboxId)))
      .limit(1);
    if (!mailbox) return { message: "The mailbox no longer exists; nothing changed.", target };
    const today = localDate(ctx.clock.now(), workspace.timezone);
    const patch = volumePatch(mailbox, parsed.data, workspace.timezone, today);
    let row = mailbox;
    if (Object.keys(patch).length > 0) {
      const [updated] = await ctx.db
        .update(mailboxes)
        .set(patch)
        .where(eq(mailboxes.id, mailbox.id))
        .returning();
      if (updated) row = updated;
    }
    return {
      message: `${row.email} now sends ${describeVolume(row, workspace.timezone, today)}.`,
      target,
      data: {
        mailbox_id: row.id,
        daily_limit: row.daily_limit,
        ramp: row.ramp,
        status: row.status,
      },
    };
  },
};
