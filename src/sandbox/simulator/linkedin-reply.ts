/**
 * LinkedIn side of the prospect simulator. There is no real linkedin module inbound path yet
 * (`src/modules/linkedin/service.ts` is still a stub), so this produces the same *events* a real
 * sync would (`linkedin.connected`, `reply.received`) and writes the minimal rows a future
 * inbox/linkedin handler needs (the relation status, the inbound message), rather than calling
 * an exported handler that does not exist.
 */
import { and, eq } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import { linkedin_relations, messages, people, threads } from "../../db/schema/index.js";
import { buildLinkedInReplyText } from "./content.js";
import { decideLinkedInAccept, decideLinkedInMessageReply } from "./decide.js";

/** Every `invited` relation in this workspace: candidates for acceptance simulation. */
export async function findPendingLinkedInAccepts(
  ctx: Pick<OpContext, "db">,
  workspaceId: string,
): Promise<Array<{ accountId: string; personId: string }>> {
  const rows = await ctx.db
    .select({ accountId: linkedin_relations.account_id, personId: linkedin_relations.person_id })
    .from(linkedin_relations)
    .where(
      and(
        eq(linkedin_relations.workspace_id, workspaceId),
        eq(linkedin_relations.status, "invited"),
      ),
    );
  return rows;
}

/**
 * Decides whether one pending invite is accepted, and if so flips the relation to `connected`
 * and emits `linkedin.connected` (the event the real sync would emit). Idempotent: a relation
 * already resolved (anything but `invited`) is left alone.
 */
export async function processLinkedInAccept(
  ctx: OpContext,
  accountId: string,
  personId: string,
): Promise<{ connected: boolean }> {
  const [relation] = await ctx.db
    .select()
    .from(linkedin_relations)
    .where(
      and(eq(linkedin_relations.account_id, accountId), eq(linkedin_relations.person_id, personId)),
    );
  if (relation?.status !== "invited") return { connected: false };

  if (!decideLinkedInAccept(personId)) return { connected: false };

  const now = ctx.clock.now();
  await ctx.db
    .update(linkedin_relations)
    .set({ status: "connected", connected_at: now })
    .where(
      and(eq(linkedin_relations.account_id, accountId), eq(linkedin_relations.person_id, personId)),
    );

  await ctx.events.emit("linkedin.connected", {
    workspaceId: relation.workspace_id,
    subject: { type: "person", id: personId },
    data: { account_id: accountId, person_id: personId, connected_at: now.toISOString() },
  });
  return { connected: true };
}

/** True when `threadId` already has an inbound message. */
async function threadHasInbound(
  ctx: Pick<OpContext, "db">,
  threadId: string | null,
): Promise<boolean> {
  if (!threadId) return false;
  const rows = await ctx.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.thread_id, threadId), eq(messages.direction, "inbound")));
  return rows.length > 0;
}

/**
 * Message ids of the latest still-unanswered outbound LinkedIn message per thread in this
 * workspace (candidates for the "accepted connections reply later" simulation).
 */
export async function findPendingLinkedInMessageReplies(
  ctx: Pick<OpContext, "db">,
  workspaceId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({
      id: messages.id,
      threadId: messages.thread_id,
      direction: messages.direction,
      action: messages.action,
      status: messages.status,
      createdAt: messages.created_at,
    })
    .from(messages)
    .where(and(eq(messages.workspace_id, workspaceId), eq(messages.channel, "linkedin")));

  const byThread = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.threadId ?? row.id;
    const list = byThread.get(key) ?? [];
    list.push(row);
    byThread.set(key, list);
  }

  const candidates: string[] = [];
  for (const rowsInThread of byThread.values()) {
    const inbound = rowsInThread.some((r) => r.direction === "inbound");
    if (inbound) continue;
    const outboundSent = rowsInThread
      .filter((r) => r.action === "message" && r.direction === "outbound" && r.status === "sent")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const latest = outboundSent[0];
    if (latest) candidates.push(latest.id);
  }
  return candidates;
}

/**
 * Decides and (when applicable) delivers a reply to one outbound LinkedIn message: inserts the
 * inbound message row and emits `reply.received` (there is no `ingestInboundEmail` equivalent
 * for LinkedIn yet, so this is the documented-event fallback the brief calls for). Leaves
 * thread classification and `needs_attention` to the future inbox handler that subscribes to
 * `reply.received`, the same boundary `ingestInboundEmail` will use for email.
 */
export async function processLinkedInMessage(
  ctx: OpContext,
  messageId: string,
): Promise<{ delivered: boolean }> {
  const [message] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (message?.direction !== "outbound" || message.status !== "sent") {
    return { delivered: false };
  }
  if (await threadHasInbound(ctx, message.thread_id)) return { delivered: false };
  if (!message.person_id) return { delivered: false };

  const [person] = await ctx.db.select().from(people).where(eq(people.id, message.person_id));
  if (!person) return { delivered: false };
  if (!decideLinkedInMessageReply(person.id, message.id)) return { delivered: false };

  const now = ctx.clock.now();
  const [inbound] = await ctx.db
    .insert(messages)
    .values({
      workspace_id: message.workspace_id,
      thread_id: message.thread_id,
      person_id: message.person_id,
      company_id: message.company_id,
      campaign_id: message.campaign_id,
      channel: "linkedin",
      action: "message",
      direction: "inbound",
      status: "received",
      body_text: buildLinkedInReplyText(),
      linkedin_account_id: message.linkedin_account_id,
      received_at: now,
    })
    .returning();
  if (!inbound) return { delivered: false };

  if (message.thread_id) {
    await ctx.db
      .update(threads)
      .set({ last_message_at: now, last_inbound_at: now })
      .where(eq(threads.id, message.thread_id));
  }

  await ctx.events.emit("reply.received", {
    workspaceId: message.workspace_id,
    subject: { type: "message", id: inbound.id },
    data: {
      message_id: inbound.id,
      thread_id: message.thread_id ?? "",
      person_id: message.person_id,
      campaign_id: message.campaign_id,
      channel: "linkedin",
    },
  });
  return { delivered: true };
}
