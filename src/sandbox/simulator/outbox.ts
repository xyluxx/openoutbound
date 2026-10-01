/**
 * What a sandbox workspace has sent so far: the emails and LinkedIn actions that went to the
 * simulator instead of a real person, and what waits to go out. `sandbox.simulate` reports it so
 * a person can see what would have been sent.
 */
import { and, count, eq, inArray } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { messages } from "../../db/schema/index.js";

export interface SandboxOutbox {
  /** Emails sent to the simulator. */
  emails_sent: number;
  /** LinkedIn invitations, messages, comments, likes and visits sent to the simulator. */
  linkedin_sent: number;
  /** Approved or scheduled messages that have not gone out yet (a send window, a cap). */
  waiting: number;
}

export async function countSandboxOutbox(
  ctx: Pick<OpContext, "db">,
  workspaceId: string,
): Promise<SandboxOutbox> {
  const rows = await ctx.db
    .select({ channel: messages.channel, status: messages.status, n: count() })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspaceId),
        eq(messages.direction, "outbound"),
        inArray(messages.status, ["sent", "approved", "scheduled"]),
      ),
    )
    .groupBy(messages.channel, messages.status);
  const outbox: SandboxOutbox = { emails_sent: 0, linkedin_sent: 0, waiting: 0 };
  for (const row of rows) {
    const n = Number(row.n);
    if (row.status !== "sent") outbox.waiting += n;
    else if (row.channel === "email") outbox.emails_sent += n;
    else outbox.linkedin_sent += n;
  }
  return outbox;
}
