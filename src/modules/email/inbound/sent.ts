/**
 * The Sent folder side of the inbound path: what a message found in a mailbox's Sent folder is
 * (reading the folder is sent-folder.ts).
 * - ours: its Message-ID is an email the engine sent; nothing new is stored
 * - related: a person wrote it themselves, into a known thread (In-Reply-To/References, to one
 *   of the leads) or to a known lead (a To address matches `people.email`); it is stored as an
 *   outbound message with origin `external` and the thread is taken over
 * - ignored: anything else (warmup, automatic replies, bulk mail, internal mail, mail to people
 *   who are not leads): never stored and never logged with its content
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import {
  type Mailbox,
  type Message,
  messages,
  type NewMessage,
  type Person,
  people,
  type Thread,
  threads,
} from "../../../db/schema/index.js";
import { takeOverThread } from "../../inbox/takeover.js";
import { detectAutoReply, isBulkMail } from "./auto-reply.js";
import { extractMessageIds, normalizeHeaders, normalizeMessageId } from "./headers.js";
import type { InboundEmail } from "./types.js";
import { isWarmupEmail } from "./warmup.js";

const MAX_TEXT = 100_000;
const STORED_HEADERS = ["date", "message-id", "in-reply-to", "references", "to", "cc"];

export type SentVerdict =
  | { kind: "ours"; message: Message }
  | { kind: "related"; thread: Thread | null; person: Person }
  | { kind: "ignored"; reason: string };

const ignored = (reason: string): SentVerdict => ({ kind: "ignored", reason });

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => (value ?? "").trim().toLowerCase()).filter(Boolean))];
}

/** Leads of the workspace with one of these addresses, in the order of the addresses. */
async function peopleByEmail(ctx: OpContext, addresses: string[]): Promise<Person[]> {
  const workspace = requireWorkspace(ctx);
  // Emails are stored lowercase: compare the column itself, so its unique index serves this.
  const wanted = unique(addresses);
  if (wanted.length === 0) return [];
  const rows = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.workspace_id, workspace.id), inArray(people.email, wanted)));
  return wanted
    .map((address) => rows.find((row) => row.email?.toLowerCase() === address))
    .filter((row): row is Person => row !== undefined);
}

/** The thread a reply continues, by In-Reply-To then References (newest first). */
async function threadByHeaders(
  ctx: OpContext,
  email: InboundEmail,
  headers: Record<string, string>,
): Promise<Thread | null> {
  const workspace = requireWorkspace(ctx);
  const inReplyTo = normalizeMessageId(email.inReplyTo ?? headers["in-reply-to"]);
  const references = email.references?.length
    ? email.references.flatMap((value) => extractMessageIds(value))
    : extractMessageIds(headers.references);
  const ids = [...new Set([inReplyTo, ...[...references].reverse()].filter(Boolean) as string[])];
  if (ids.length === 0) return null;
  const rows = await ctx.db
    .select({ id: messages.message_id_header, thread_id: messages.thread_id })
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, workspace.id),
        inArray(messages.message_id_header, ids),
        isNotNull(messages.thread_id),
      ),
    );
  const parent = ids.map((id) => rows.find((row) => row.id === id)).find(Boolean);
  if (!parent?.thread_id) return null;
  const [thread] = await ctx.db
    .select()
    .from(threads)
    .where(and(eq(threads.id, parent.thread_id), eq(threads.workspace_id, workspace.id)))
    .limit(1);
  return thread ?? null;
}

/**
 * What a Sent folder message is (see module doc), from its headers alone, so the body is only
 * downloaded for mail that will be stored.
 */
export async function judgeSentEmail(
  ctx: OpContext,
  mailbox: Mailbox,
  email: InboundEmail,
): Promise<SentVerdict> {
  const workspace = requireWorkspace(ctx);
  const headers = normalizeHeaders(email.headers);
  const messageId = normalizeMessageId(email.messageIdHeader ?? headers["message-id"]);
  if (!messageId) return ignored("no_message_id");
  const [existing] = await ctx.db
    .select()
    .from(messages)
    .where(and(eq(messages.workspace_id, workspace.id), eq(messages.message_id_header, messageId)))
    .limit(1);
  if (existing) {
    const ours = existing.direction === "outbound" && existing.origin === "engine";
    return ours ? { kind: "ours", message: existing } : ignored("already_stored");
  }
  const subject = email.subject ?? "";
  const text = email.text ?? "";
  if (isWarmupEmail({ subject, text, headers }, mailbox.warmup_patterns)) return ignored("warmup");
  if (detectAutoReply({ subject, text, headers, receivedAt: email.receivedAt })) {
    return ignored("automatic_reply");
  }
  if (isBulkMail(headers)) return ignored("bulk");

  const own = mailbox.email.toLowerCase();
  const to = unique(email.to).filter((address) => address !== own);
  const recipients = unique([...to, ...(email.cc ?? [])]).filter((address) => address !== own);
  const thread = await threadByHeaders(ctx, email, headers);
  if (thread) {
    // Only when a lead is among the recipients: an internal forward is not a reply.
    const leads = await peopleByEmail(ctx, recipients);
    const person = leads.find((lead) => lead.id === thread.person_id) ?? leads[0];
    return person ? { kind: "related", thread, person } : ignored("not_to_a_lead");
  }
  const [person] = await peopleByEmail(ctx, to);
  return person ? { kind: "related", thread: null, person } : ignored("not_to_a_lead");
}

/** The send time from the Date header, else the server's time; never in the future. */
function sentTime(dateHeader: string | undefined, fallback: Date, now: Date): Date {
  const parsed = dateHeader ? new Date(dateHeader) : null;
  const at = parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback;
  return at.getTime() > now.getTime() ? now : at;
}

export interface StoredSentEmail {
  messageId: string;
  threadId: string;
  /** A reply in a known thread, or a new email that started a thread. */
  kind: "reply" | "new_thread";
}

/**
 * Stores a related Sent folder email (full source parsed) as an outbound message with origin
 * `external` (status sent, sent_at from the Date header, no campaign) and takes its thread over;
 * a new email to a lead starts a thread the person owns. Returns null when the body shows it
 * is warmup mail or it was stored meanwhile.
 */
export async function storeSentEmail(
  ctx: OpContext,
  mailbox: Mailbox,
  email: InboundEmail,
  verdict: Extract<SentVerdict, { kind: "related" }>,
): Promise<StoredSentEmail | null> {
  const workspace = requireWorkspace(ctx);
  const headers = normalizeHeaders(email.headers);
  const subject = (email.subject ?? "").slice(0, 998);
  const text = (email.text ?? "").slice(0, MAX_TEXT);
  if (isWarmupEmail({ subject, text, headers }, mailbox.warmup_patterns)) return null;
  const messageId = normalizeMessageId(email.messageIdHeader ?? headers["message-id"]);
  if (!messageId) return null;
  const now = ctx.clock.now();
  const sentAt = sentTime(headers.date, email.receivedAt, now);
  const { person } = verdict;

  let thread = verdict.thread;
  if (!thread) {
    const [created] = await ctx.db
      .insert(threads)
      .values({
        workspace_id: workspace.id,
        person_id: person.id,
        company_id: person.company_id,
        channel: "email",
        subject: subject || null,
        mailbox_id: mailbox.id,
        external_ref: messageId,
        status: "waiting",
        owner: "person",
        owner_changed_at: now,
        last_message_at: sentAt,
      })
      .returning();
    if (!created) throw new Error("storeSentEmail: thread insert returned no row");
    thread = created;
  }

  const stored: Record<string, string> = {};
  for (const name of STORED_HEADERS) {
    const value = headers[name];
    if (value !== undefined) stored[name] = value.slice(0, 2000);
  }
  const inReplyTo = normalizeMessageId(email.inReplyTo ?? headers["in-reply-to"]);
  const values: NewMessage = {
    workspace_id: workspace.id,
    thread_id: thread.id,
    person_id: person.id,
    company_id: thread.company_id ?? person.company_id,
    channel: "email",
    action: verdict.thread ? "reply" : "email",
    direction: "outbound",
    status: "sent",
    origin: "external",
    subject: subject || null,
    body_text: text,
    from_address: mailbox.email,
    to_address: person.email?.toLowerCase() ?? unique(email.to)[0] ?? null,
    mailbox_id: mailbox.id,
    sent_at: sentAt,
    message_id_header: messageId,
    in_reply_to: inReplyTo,
    references: email.references?.length
      ? email.references.flatMap((value) => extractMessageIds(value))
      : extractMessageIds(headers.references),
    headers: stored,
  };
  const [row] = await ctx.db.insert(messages).values(values).onConflictDoNothing().returning();
  if (!row) return null;

  const answered = !thread.last_inbound_at || sentAt >= thread.last_inbound_at;
  await ctx.db
    .update(threads)
    .set({
      last_message_at:
        thread.last_message_at && thread.last_message_at > sentAt ? thread.last_message_at : sentAt,
      ...(answered ? { needs_attention: false, status: "waiting" as const } : {}),
    })
    .where(eq(threads.id, thread.id));
  await ctx.db
    .update(people)
    .set({
      last_contacted_at: sql`greatest(coalesce(${people.last_contacted_at}, ${sentAt.toISOString()}::timestamptz), ${sentAt.toISOString()}::timestamptz)`,
    })
    .where(and(eq(people.id, person.id), eq(people.workspace_id, workspace.id)));
  await takeOverThread(ctx, thread.id, { messageId: row.id, reason: "sent_folder" });
  return { messageId: row.id, threadId: thread.id, kind: verdict.thread ? "reply" : "new_thread" };
}
