import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { type OpContext, requireWorkspace } from "../../../core/context.js";
import { notFound } from "../../../core/errors.js";
import type { EventData } from "../../../core/events.js";
import {
  type Mailbox,
  type Message,
  mailboxes,
  messages,
  type NewMessage,
  type Person,
  people,
  type ReplyClassification,
  type Thread,
  threads,
} from "../../../db/schema/index.js";
import { detectPrivacyRequest } from "../../inbox/privacy-phrases.js";
import { setPersonStatus } from "../../leads/service.js";
import { applyBounce, applySenderRejection } from "../bounce.js";
import { processUnsubscribe } from "../unsubscribe.js";
import { detectAutoReply, isBulkMail } from "./auto-reply.js";
import { isBounce, parseBounce } from "./dsn.js";
import {
  extractMessageIds,
  type HeaderMap,
  normalizeHeaders,
  normalizeMessageId,
  parseAddress,
} from "./headers.js";
import { isUnsubscribeRequest, stripQuotedReply } from "./reply-text.js";
import type { InboundEmail, IngestResult } from "./types.js";
import { isWarmupEmail } from "./warmup.js";

/** Stored with inbound messages so a repeated ingest returns the same kind. */
export const INBOUND_KIND_HEADER = "x-openoutbound-kind";
const STORED_HEADERS = [
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "auto-submitted",
  "x-autoreply",
  "x-autorespond",
  "precedence",
  "content-type",
  "list-id",
  "x-auto-response-suppress",
];
const MAX_TEXT = 100_000;
const MAX_HTML = 200_000;
const BOUNCE_MATCH_WINDOW_MS = 45 * 86_400_000;

type Kind = IngestResult["kind"];
const NOTHING = (kind: Kind): IngestResult => ({ messageId: "", threadId: null, kind });

interface Parsed {
  input: InboundEmail;
  headers: HeaderMap;
  from: string;
  subject: string;
  text: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
}

/**
 * The single inbound path (IMAP sync, sandbox simulator, tests). In order: duplicates,
 * warmup mail (ignored), bounces (DSN: message `bounced`, hard bounces invalidate and suppress;
 * rejections of our sender go to the mailbox's health only, see `applySenderRejection`),
 * automatic replies (stored on the thread, `reply.received` with `auto_reply: true` and the
 * return date), unsubscribe requests (suppression), replies (threaded by In-Reply-To/References,
 * then by sender + mailbox; `reply.received`), and mail from known people outside any thread
 * (`unmatched`, new thread). Everything else is ignored.
 */
export async function ingestInboundEmail(
  ctx: OpContext,
  input: InboundEmail,
): Promise<IngestResult> {
  const workspace = requireWorkspace(ctx);
  const [mailbox] = await ctx.db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.workspace_id, workspace.id)))
    .limit(1);
  if (!mailbox) throw notFound("Mailbox", input.mailboxId);

  const headers = normalizeHeaders(input.headers);
  const parsed: Parsed = {
    input,
    headers,
    from: parseAddress(input.from) || parseAddress(headers.from),
    subject: (input.subject ?? "").slice(0, 998),
    text: (input.text ?? "").slice(0, MAX_TEXT),
    messageIdHeader: normalizeMessageId(input.messageIdHeader ?? headers["message-id"]),
    inReplyTo: normalizeMessageId(input.inReplyTo ?? headers["in-reply-to"]),
    references: input.references?.length
      ? input.references.flatMap((value) => extractMessageIds(value))
      : extractMessageIds(headers.references),
  };

  if (parsed.messageIdHeader) {
    const [existing] = await ctx.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, workspace.id),
          eq(messages.message_id_header, parsed.messageIdHeader),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.direction === "outbound") return NOTHING("unmatched");
      return {
        messageId: existing.id,
        threadId: existing.thread_id,
        kind: (existing.headers?.[INBOUND_KIND_HEADER] as Kind | undefined) ?? "reply",
      };
    }
  }
  if (parsed.from && parsed.from === mailbox.email) return NOTHING("unmatched");

  if (
    isWarmupEmail({ subject: parsed.subject, text: parsed.text, headers }, mailbox.warmup_patterns)
  ) {
    return NOTHING("warmup");
  }

  if (
    isBounce({
      from: input.from,
      subject: parsed.subject,
      headers,
      text: parsed.text,
      raw: input.raw,
    })
  ) {
    return handleBounce(ctx, mailbox, parsed);
  }

  const match = await matchThread(ctx, mailbox, parsed);
  const person = await findPerson(ctx, workspace.id, match?.thread.person_id ?? null, parsed.from);

  const auto = detectAutoReply({
    subject: parsed.subject,
    text: parsed.text,
    headers,
    receivedAt: input.receivedAt,
  });
  // A reply that asks about the writer's data ("delete my data"). It goes to the reply
  // classifier, whose privacy action does everything an unsubscribe does and opens the privacy
  // request with its deadline. With auto-reply headers too (protective): it is never filed as
  // an ordinary auto-reply, and the privacy problem asks a human to check who wrote it.
  const privacyAsk =
    (match !== null || person !== null) &&
    detectPrivacyRequest(stripQuotedReply(parsed.text)) !== null;
  if (auto && !privacyAsk) {
    if (!match) return NOTHING("auto_reply");
    const classification: ReplyClassification = {
      category: auto.outOfOffice ? "out_of_office" : "auto_reply_other",
      confidence: 0.95,
      return_date: auto.returnDate,
      summary: `Automatic reply (${auto.signal})`,
      model: null,
    };
    const stored = await storeInbound(ctx, mailbox, parsed, {
      thread: match.thread,
      parent: match.parent,
      person,
      kind: "auto_reply",
      classification,
    });
    await touchThread(ctx, match.thread, input.receivedAt, {
      needsAttention: false,
      category: classification.category,
    });
    if (stored.created) {
      await emitReply(ctx, stored.message, match.thread, person, {
        auto_reply: true,
        return_date: auto.returnDate,
        kind: "auto_reply",
      });
    }
    return { messageId: stored.message.id, threadId: match.thread.id, kind: "auto_reply" };
  }

  if (!match && isBulkMail(headers)) return NOTHING("unmatched");

  // A short opt-out that also asks about their data ("unsubscribe me and delete my data") is a
  // privacy request (above), not an unsubscribe.
  if (!privacyAsk && isUnsubscribeRequest(parsed.subject, parsed.text)) {
    let messageId = "";
    if (match) {
      const stored = await storeInbound(ctx, mailbox, parsed, {
        thread: match.thread,
        parent: match.parent,
        person,
        kind: "unsubscribe",
        classification: {
          category: "unsubscribe",
          confidence: 0.99,
          summary: "Asked to unsubscribe",
          model: null,
        },
      });
      messageId = stored.message.id;
      await touchThread(ctx, match.thread, input.receivedAt, {
        needsAttention: false,
        category: "unsubscribe",
      });
    }
    await processUnsubscribe(ctx, {
      email: parsed.from,
      personId: person?.id ?? null,
      messageId: messageId || null,
      source: "reply",
    });
    return { messageId, threadId: match?.thread.id ?? null, kind: "unsubscribe" };
  }

  if (match) {
    const stored = await storeInbound(ctx, mailbox, parsed, {
      thread: match.thread,
      parent: match.parent,
      person,
      kind: "reply",
    });
    await touchThread(ctx, match.thread, input.receivedAt, {
      needsAttention: true,
      category: null,
    });
    if (stored.created) {
      if (person && (person.status === "new" || person.status === "active")) {
        await setPersonStatus(ctx, person.id, "replied");
      }
      await emitReply(ctx, stored.message, match.thread, person, {
        auto_reply: false,
        kind: "reply",
      });
    }
    return { messageId: stored.message.id, threadId: match.thread.id, kind: "reply" };
  }

  if (!person) return NOTHING("unmatched");
  const [thread] = await ctx.db
    .insert(threads)
    .values({
      workspace_id: workspace.id,
      person_id: person.id,
      company_id: person.company_id,
      channel: "email",
      subject: parsed.subject || null,
      mailbox_id: mailbox.id,
      external_ref: parsed.messageIdHeader,
      status: "open",
      needs_attention: true,
      last_message_at: input.receivedAt,
      last_inbound_at: input.receivedAt,
    })
    .returning();
  if (!thread) throw new Error("ingestInboundEmail: thread insert returned no row");
  const stored = await storeInbound(ctx, mailbox, parsed, {
    thread,
    parent: null,
    person,
    kind: "unmatched",
  });
  if (stored.created) {
    await emitReply(ctx, stored.message, thread, person, { auto_reply: false, kind: "unmatched" });
  }
  return { messageId: stored.message.id, threadId: thread.id, kind: "unmatched" };
}

async function handleBounce(
  ctx: OpContext,
  mailbox: Mailbox,
  parsed: Parsed,
): Promise<IngestResult> {
  const report = parseBounce({
    from: parsed.input.from,
    subject: parsed.subject,
    headers: parsed.headers,
    text: parsed.text,
    raw: parsed.input.raw,
  });
  if (report.action === "delayed" || report.action === "delivered" || report.action === "relayed") {
    return NOTHING("bounce");
  }
  const original = await findBouncedMessage(
    ctx,
    mailbox,
    report.originalMessageId,
    report.recipient,
  );
  const email = report.recipient ?? original?.to_address ?? "";
  if (!original && !email) return NOTHING("bounce");
  const reason = [report.status, report.diagnostic].filter(Boolean).join(" ") || null;

  if (report.senderRejection) {
    // The server refused our sender (authentication, reputation, policy, rate), not the
    // address: only the mailbox's health changes, the recipient's record stays clean.
    await applySenderRejection(ctx, {
      mailbox,
      message: original,
      kind: report.senderRejection,
      status: report.status,
      reason,
    });
  } else {
    await applyBounce(ctx, { message: original, email, bounceType: report.bounceType, reason });
  }
  return { messageId: original?.id ?? "", threadId: original?.thread_id ?? null, kind: "bounce" };
}

/** The outbound message a bounce refers to: by original Message-ID, else the latest send to the address. */
async function findBouncedMessage(
  ctx: OpContext,
  mailbox: Mailbox,
  originalMessageId: string | null,
  recipient: string | null,
): Promise<Message | null> {
  if (originalMessageId) {
    const [byId] = await ctx.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, mailbox.workspace_id),
          eq(messages.message_id_header, originalMessageId),
          eq(messages.direction, "outbound"),
        ),
      )
      .limit(1);
    if (byId) return byId;
  }
  if (!recipient) return null;
  const [byAddress] = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, mailbox.workspace_id),
        eq(messages.mailbox_id, mailbox.id),
        eq(messages.direction, "outbound"),
        eq(messages.to_address, recipient),
        inArray(messages.status, ["sent", "bounced"]),
      ),
    )
    .orderBy(desc(messages.sent_at))
    .limit(1);
  if (!byAddress?.sent_at) return null;
  const age = ctx.clock.now().getTime() - byAddress.sent_at.getTime();
  return age <= BOUNCE_MATCH_WINDOW_MS ? byAddress : null;
}

interface ThreadMatch {
  thread: Thread;
  /** The message the reply answers, when matched by header. */
  parent: Message | null;
}

/** Thread by In-Reply-To/References, then by sender address + mailbox. */
async function matchThread(
  ctx: OpContext,
  mailbox: Mailbox,
  parsed: Parsed,
): Promise<ThreadMatch | null> {
  const ids = [
    ...new Set([parsed.inReplyTo, ...[...parsed.references].reverse()].filter(Boolean) as string[]),
  ];
  if (ids.length > 0) {
    const rows = await ctx.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.workspace_id, mailbox.workspace_id),
          inArray(messages.message_id_header, ids),
          isNotNull(messages.thread_id),
        ),
      );
    const ordered = ids
      .map((id) => rows.find((row) => row.message_id_header === id))
      .filter((row): row is Message => row !== undefined);
    const parent = ordered[0];
    if (parent?.thread_id) {
      const thread = await loadThread(ctx, mailbox.workspace_id, parent.thread_id);
      if (thread) return { thread, parent };
    }
  }
  if (!parsed.from) return null;
  const [lastSend] = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, mailbox.workspace_id),
        eq(messages.mailbox_id, mailbox.id),
        eq(messages.direction, "outbound"),
        eq(messages.to_address, parsed.from),
        isNotNull(messages.thread_id),
      ),
    )
    .orderBy(desc(messages.created_at))
    .limit(1);
  if (lastSend?.thread_id) {
    const thread = await loadThread(ctx, mailbox.workspace_id, lastSend.thread_id);
    if (thread) return { thread, parent: lastSend };
  }
  const [person] = await ctx.db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.workspace_id, mailbox.workspace_id), eq(people.email, parsed.from)))
    .limit(1);
  if (!person) return null;
  const [thread] = await ctx.db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.workspace_id, mailbox.workspace_id),
        eq(threads.person_id, person.id),
        eq(threads.mailbox_id, mailbox.id),
        eq(threads.channel, "email"),
      ),
    )
    .orderBy(desc(threads.last_message_at))
    .limit(1);
  return thread ? { thread, parent: null } : null;
}

async function loadThread(
  ctx: OpContext,
  workspaceId: string,
  threadId: string,
): Promise<Thread | null> {
  const [thread] = await ctx.db
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.workspace_id, workspaceId)))
    .limit(1);
  return thread ?? null;
}

async function findPerson(
  ctx: OpContext,
  workspaceId: string,
  personId: string | null,
  email: string,
): Promise<Person | null> {
  const condition = personId ? eq(people.id, personId) : email ? eq(people.email, email) : null;
  if (!condition) return null;
  const [person] = await ctx.db
    .select()
    .from(people)
    .where(and(eq(people.workspace_id, workspaceId), condition))
    .limit(1);
  return person ?? null;
}

async function storeInbound(
  ctx: OpContext,
  mailbox: Mailbox,
  parsed: Parsed,
  options: {
    thread: Thread;
    parent: Message | null;
    person: Person | null;
    kind: Kind;
    classification?: ReplyClassification;
  },
): Promise<{ message: Message; created: boolean }> {
  const stored: Record<string, string> = { [INBOUND_KIND_HEADER]: options.kind };
  for (const name of STORED_HEADERS) {
    const value = parsed.headers[name];
    if (value !== undefined) stored[name] = value.slice(0, 2000);
  }
  const values: NewMessage = {
    workspace_id: mailbox.workspace_id,
    thread_id: options.thread.id,
    person_id: options.thread.person_id ?? options.person?.id ?? null,
    company_id: options.thread.company_id ?? options.person?.company_id ?? null,
    campaign_id: options.thread.campaign_id ?? options.parent?.campaign_id ?? null,
    enrollment_id: options.parent?.enrollment_id ?? null,
    channel: "email",
    action: "reply",
    direction: "inbound",
    status: "received",
    subject: parsed.subject || null,
    body_text: parsed.text,
    body_html: parsed.input.html ? parsed.input.html.slice(0, MAX_HTML) : null,
    from_address: parsed.from || null,
    to_address: mailbox.email,
    mailbox_id: mailbox.id,
    received_at: parsed.input.receivedAt,
    message_id_header: parsed.messageIdHeader,
    in_reply_to: parsed.inReplyTo,
    references: parsed.references,
    headers: stored,
    classification: options.classification ?? null,
  };
  const [row] = await ctx.db.insert(messages).values(values).onConflictDoNothing().returning();
  if (row) return { message: row, created: true };
  const [existing] = await ctx.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.workspace_id, mailbox.workspace_id),
        eq(messages.message_id_header, parsed.messageIdHeader ?? ""),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("ingestInboundEmail: insert conflicted but no message was found");
  return { message: existing, created: false };
}

async function touchThread(
  ctx: OpContext,
  thread: Thread,
  receivedAt: Date,
  options: { needsAttention: boolean; category: ReplyClassification["category"] | null },
): Promise<void> {
  const patch: Partial<Thread> = {
    // An older reply synced late never moves the latest reply back.
    last_inbound_at:
      thread.last_inbound_at && thread.last_inbound_at > receivedAt
        ? thread.last_inbound_at
        : receivedAt,
    last_message_at:
      thread.last_message_at && thread.last_message_at > receivedAt
        ? thread.last_message_at
        : receivedAt,
    status: "open",
  };
  if (options.needsAttention) patch.needs_attention = true;
  if (options.category) patch.category = options.category;
  await ctx.db.update(threads).set(patch).where(eq(threads.id, thread.id));
}

async function emitReply(
  ctx: OpContext,
  message: Message,
  thread: Thread,
  person: Person | null,
  extra: { auto_reply: boolean; return_date?: string | null; kind: Kind },
): Promise<void> {
  const data: EventData["reply.received"] & {
    auto_reply: boolean;
    return_date: string | null;
    kind: Kind;
  } = {
    message_id: message.id,
    thread_id: thread.id,
    person_id: message.person_id ?? person?.id ?? null,
    campaign_id: message.campaign_id ?? thread.campaign_id ?? null,
    channel: "email",
    auto_reply: extra.auto_reply,
    return_date: extra.return_date ?? null,
    kind: extra.kind,
  };
  await ctx.events.emit("reply.received", { subject: { type: "message", id: message.id }, data });
}
