/**
 * Inbound LinkedIn messages -> threads (channel linkedin, external_ref = chat id) + inbound
 * messages + `reply.received`. Shared by the sync job and the webhook. Idempotent per provider
 * message id, serialized per account. Only people already in the workspace are ingested (no
 * profile scraping).
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import type { Db } from "../../db/client.js";
import {
  type LinkedInAccount,
  linkedin_accounts,
  messages,
  people,
  type Thread,
  threads,
} from "../../db/schema/index.js";
import type { LinkedInInboundMessage } from "../../providers/types.js";
import { matchPerson } from "./relations.js";

export type IngestResult =
  | { result: "created"; messageId: string; threadId: string }
  | { result: "duplicate" | "unmatched" | "outbound" };

function validDate(value: string, fallback: Date): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

async function latestCampaignId(
  db: Db,
  account: LinkedInAccount,
  personId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ campaign_id: messages.campaign_id })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, account.workspace_id),
        eq(messages.person_id, personId),
        eq(messages.channel, "linkedin"),
        eq(messages.direction, "outbound"),
      ),
    )
    .orderBy(desc(messages.created_at))
    .limit(1);
  return row?.campaign_id ?? null;
}

async function findOrCreateThread(
  db: Db,
  account: LinkedInAccount,
  personId: string,
  chatId: string,
  at: Date,
): Promise<Thread> {
  const [byChat] = await db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.workspace_id, account.workspace_id),
        eq(threads.channel, "linkedin"),
        eq(threads.linkedin_account_id, account.id),
        eq(threads.external_ref, chatId),
      ),
    )
    .limit(1);
  if (byChat) return byChat;
  const [open] = await db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.workspace_id, account.workspace_id),
        eq(threads.channel, "linkedin"),
        eq(threads.linkedin_account_id, account.id),
        eq(threads.person_id, personId),
        isNull(threads.external_ref),
      ),
    )
    .orderBy(desc(threads.created_at))
    .limit(1);
  if (open) {
    const [updated] = await db
      .update(threads)
      .set({ external_ref: chatId })
      .where(eq(threads.id, open.id))
      .returning();
    return updated ?? open;
  }
  const [person] = await db
    .select({ company_id: people.company_id })
    .from(people)
    .where(eq(people.id, personId));
  const [created] = await db
    .insert(threads)
    .values({
      workspace_id: account.workspace_id,
      person_id: personId,
      company_id: person?.company_id ?? null,
      campaign_id: await latestCampaignId(db, account, personId),
      channel: "linkedin",
      linkedin_account_id: account.id,
      external_ref: chatId,
      status: "open",
      last_message_at: at,
    })
    .returning();
  if (!created) throw new Error("linkedin: thread insert returned no row");
  return created;
}

type Stored =
  | { result: "created"; messageId: string; thread: Thread; personId: string }
  | { result: "duplicate" | "unmatched" };

/** Stores one inbound LinkedIn message (see module doc). */
export async function ingestInboundMessage(
  ctx: OpContext,
  account: LinkedInAccount,
  message: LinkedInInboundMessage,
): Promise<IngestResult> {
  if (message.is_outbound) return { result: "outbound" };
  if (!message.id || !message.chat_id) return { result: "unmatched" };
  const receivedAt = validDate(message.sent_at, ctx.clock.now());
  const stored = await ctx.db.transaction(async (tx): Promise<Stored> => {
    // The webhook and the sync can see the same message at once: one ingestion per account.
    await tx
      .select({ id: linkedin_accounts.id })
      .from(linkedin_accounts)
      .where(eq(linkedin_accounts.id, account.id))
      .for("update");
    const [known] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, account.workspace_id),
          eq(messages.channel, "linkedin"),
          eq(messages.direction, "inbound"),
          eq(messages.provider_message_id, message.id),
        ),
      )
      .limit(1);
    if (known) return { result: "duplicate" };

    const [chatThread] = await tx
      .select({ person_id: threads.person_id })
      .from(threads)
      .where(
        and(
          eq(threads.workspace_id, account.workspace_id),
          eq(threads.channel, "linkedin"),
          eq(threads.linkedin_account_id, account.id),
          eq(threads.external_ref, message.chat_id),
        ),
      )
      .limit(1);
    const personId =
      chatThread?.person_id ??
      (await matchPerson(tx, account, {
        provider_id: message.sender_provider_id,
        profile_url: message.sender_profile_url ?? null,
      }));
    if (!personId) return { result: "unmatched" };

    const thread = await findOrCreateThread(tx, account, personId, message.chat_id, receivedAt);
    const [row] = await tx
      .insert(messages)
      .values({
        workspace_id: account.workspace_id,
        thread_id: thread.id,
        person_id: personId,
        company_id: thread.company_id,
        campaign_id: thread.campaign_id,
        channel: "linkedin",
        action: "message",
        direction: "inbound",
        status: "received",
        body_text: message.text,
        linkedin_account_id: account.id,
        received_at: receivedAt,
        provider_message_id: message.id,
      })
      .returning({ id: messages.id });
    if (!row) throw new Error("linkedin: message insert returned no row");
    await tx
      .update(threads)
      .set({ last_message_at: receivedAt, last_inbound_at: receivedAt, status: "open" })
      .where(eq(threads.id, thread.id));
    return { result: "created", messageId: row.id, thread, personId };
  });
  if (stored.result !== "created") return { result: stored.result };
  await ctx.events.emit("reply.received", {
    workspaceId: account.workspace_id,
    subject: { type: "message", id: stored.messageId },
    data: {
      message_id: stored.messageId,
      thread_id: stored.thread.id,
      person_id: stored.personId,
      campaign_id: stored.thread.campaign_id,
      channel: "linkedin",
    },
  });
  return { result: "created", messageId: stored.messageId, threadId: stored.thread.id };
}
