/**
 * One reply per request (docs/concepts/delivery-guarantees.md, scenario S7): a caller that asks
 * `threads.send_reply` for the same text again, such as an agent retrying after a timeout, gets
 * the reply it already asked for instead of a second outbound message.
 */
import { and, desc, eq, gte, inArray, isNull, notInArray } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import type { MessageStatus } from "../../core/enums.js";
import { type Message, messages } from "../../db/schema/index.js";

/** How long the same text asked again counts as a repeat of the same request. */
export const REPLY_REPEAT_WINDOW_MS = 24 * 60 * 60_000;

/** Replies that did not and will not go out: the same text asked again starts a new one. */
const NOT_REUSED: MessageStatus[] = ["cancelled", "failed", "skipped"];

/** Reply text as it is compared: trimmed, every run of whitespace one space. */
export function normalizedReplyText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The thread's reply with the same text that the engine created in the last 24 hours and that
 * is still on its way or went out (not cancelled, failed or skipped), newest first; null when
 * there is none. Campaign steps in the thread are not replies and never match.
 */
export async function findRepeatedReply(
  ctx: OpContext,
  threadId: string,
  text: string,
): Promise<Message | null> {
  const wanted = normalizedReplyText(text);
  if (!wanted) return null;
  const workspace = requireWorkspace(ctx);
  const since = new Date(ctx.clock.now().getTime() - REPLY_REPEAT_WINDOW_MS);
  const rows = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        eq(messages.thread_id, threadId),
        eq(messages.direction, "outbound"),
        eq(messages.origin, "engine"),
        isNull(messages.step_id),
        inArray(messages.action, ["reply", "message"]),
        notInArray(messages.status, NOT_REUSED),
        gte(messages.created_at, since),
      ),
    )
    .orderBy(desc(messages.created_at))
    .limit(20);
  return rows.find((row) => normalizedReplyText(row.body_text) === wanted) ?? null;
}

/** The note returned with a reused reply. */
export const REUSED_REPLY_NOTE =
  "The same reply was already asked for in this thread in the last 24 hours: that one is returned, nothing new was created.";
