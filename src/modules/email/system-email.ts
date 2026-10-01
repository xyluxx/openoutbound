import { and, asc, eq, inArray } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { mailboxes } from "../../db/schema/index.js";
import { newMessageIdHeader } from "./compose.js";
import { parseAddress } from "./inbound/headers.js";
import { classifySendError } from "./send-errors.js";
import { transportFor } from "./transport.js";

/**
 * Sends an operational email (notifications, scheduled reports) from a workspace mailbox:
 * `mailboxId` or the first active mailbox. Plain text, no tracking, no footer, not counted
 * against outreach capacity. Throws `provider_error` when the send fails.
 */
export async function sendSystemEmail(
  ctx: OpContext,
  input: { to: string[]; subject: string; text: string; mailboxId?: string | null },
): Promise<void> {
  const workspace = requireWorkspace(ctx);
  const recipients = [...new Set(input.to.map((address) => parseAddress(address)).filter(Boolean))];
  if (recipients.length === 0) {
    throw new OpenOutboundError("validation_failed", "No valid recipient address.", {
      hint: "Pass at least one email address in `to`.",
    });
  }
  const [mailbox] = await ctx.db
    .select()
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.workspace_id, workspace.id),
        input.mailboxId
          ? eq(mailboxes.id, input.mailboxId)
          : inArray(mailboxes.status, ["active", "warming"]),
      ),
    )
    .orderBy(asc(mailboxes.created_at))
    .limit(1);
  if (!mailbox) {
    throw new OpenOutboundError(
      "provider_not_configured",
      "No mailbox can send notification emails.",
      {
        hint: "Add a mailbox with manage_mailboxes action add, or use a Slack or webhook notification channel.",
      },
    );
  }
  const transport = await transportFor(ctx, workspace, mailbox);
  try {
    await transport.send({
      from: { name: mailbox.from_name ?? "OpenOutbound", address: mailbox.email },
      to: recipients,
      subject: input.subject.replace(/\s+/g, " ").trim().slice(0, 200),
      text: input.text,
      messageId: newMessageIdHeader(mailbox.email, ctx.clock.now()),
      date: ctx.clock.now(),
      headers: { "Auto-Submitted": "auto-generated" },
    });
  } catch (error) {
    const failure = classifySendError(error);
    throw new OpenOutboundError("provider_error", `Notification email failed: ${failure.message}`, {
      hint: `Check mailbox ${mailbox.email} with manage_mailboxes action test.`,
      details: { mailbox_id: mailbox.id, kind: failure.kind },
      cause: error,
    });
  }
}
