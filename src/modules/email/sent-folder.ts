/**
 * Sent folder reading (setting `inbox.read_sent_folder`, on by default). Each mailbox sync also
 * reads new mail in the Sent folder (special-use `\Sent`, else a common name) with its own
 * cursor in `sync_state.sent`, the same 3-day first-sync lookback and the same caps:
 * - our own emails confirm an `unknown` send (or one queued again after an unknown outcome,
 *   which drops that resend) and prove that the mailbox's server keeps sent copies
 *   (`sent_copies_seen_at`, see unknown-sends.ts)
 * - a person's own email to a lead is stored (origin `external`) and takes its thread over
 * - everything else is ignored (see inbound/sent.ts)
 * Only headers are fetched first; the full source only for mail that will be stored.
 */
import type { ImapFlow, ListResponse } from "imapflow";
import type { JobContext } from "../../core/context.js";
import type { Mailbox, MailboxSyncState } from "../../db/schema/index.js";
import {
  FIRST_SYNC_LOOKBACK_MS,
  findSentFolder,
  MAX_PER_FOLDER,
  MAX_SOURCE_BYTES,
} from "./imap.js";
import { parseRawEmail } from "./inbound/parse.js";
import { judgeSentEmail, storeSentEmail } from "./inbound/sent.js";
import { confirmEmailSent, learnSavesSentCopies } from "./send-job.js";
import { isQueuedResend } from "./unknown-sends.js";

export type SentCursor = NonNullable<MailboxSyncState["sent"]>;

/** What one Sent folder pass did. Counts only: no addresses or content. */
export interface SentSyncSummary {
  /** The folder read, null when the mailbox has none. */
  folder: string | null;
  /** Messages looked at. */
  seen: number;
  /** Unknown sends confirmed by their copy. */
  confirmed: number;
  /** A person's own emails stored (thread replies and new emails to leads). */
  stored: number;
  ignored: number;
  errors: number;
}

function validDate(value: Date | string | undefined, fallback: Date): Date {
  const date = value ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/**
 * Reads new Sent folder mail on a connected client (see module doc) and returns the new cursor
 * (null when there is no Sent folder). A message that fails keeps the cursor before it, so the
 * next sync tries it again.
 */
export async function syncSentFolder(
  ctx: JobContext,
  input: { client: ImapFlow; mailbox: Mailbox; list: ListResponse[]; now: Date },
): Promise<{ summary: SentSyncSummary; cursor: SentCursor | null }> {
  const { client, mailbox, now } = input;
  const path = findSentFolder(input.list);
  const summary: SentSyncSummary = {
    folder: path,
    seen: 0,
    confirmed: 0,
    stored: 0,
    ignored: 0,
    errors: 0,
  };
  if (!path) return { summary, cursor: null };

  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const box = client.mailbox;
    const previous = mailbox.sync_state?.sent ?? null;
    if (!box) return { summary, cursor: previous };
    const uidValidity = Number(box.uidValidity);
    const fresh = !previous || previous.path !== path || previous.uidvalidity !== uidValidity;
    let lastUid = fresh ? 0 : previous.last_uid;
    const found = fresh
      ? await client.search(
          { since: new Date(now.getTime() - FIRST_SYNC_LOOKBACK_MS) },
          { uid: true },
        )
      : box.uidNext - 1 > lastUid
        ? await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })
        : [];
    const uids = (Array.isArray(found) ? found : [])
      .filter((uid) => uid > lastUid)
      .sort((a, b) => a - b)
      .slice(0, MAX_PER_FOLDER);
    if (uids.length === 0) {
      if (fresh) lastUid = Math.max(0, box.uidNext - 1);
      return { summary, cursor: { path, uidvalidity: uidValidity, last_uid: lastUid } };
    }

    const heads = await client.fetchAll(
      uids,
      { uid: true, internalDate: true, headers: true },
      { uid: true },
    );
    heads.sort((a, b) => a.uid - b.uid);
    for (const head of heads) {
      summary.seen += 1;
      try {
        const outcome = await handleSentMessage(ctx, {
          client,
          mailbox,
          uid: head.uid,
          headers: head.headers,
          internalDate: validDate(head.internalDate, now),
        });
        summary[outcome] += 1;
        lastUid = head.uid;
      } catch (error) {
        // Keep the UID so the next sync tries this message again.
        summary.errors += 1;
        ctx.log.error(
          { mailbox_id: mailbox.id, uid: head.uid, err: String(error) },
          "email: a Sent folder message could not be read",
        );
        break;
      }
    }
    return { summary, cursor: { path, uidvalidity: uidValidity, last_uid: lastUid } };
  } finally {
    lock.release();
  }
}

async function handleSentMessage(
  ctx: JobContext,
  input: {
    client: ImapFlow;
    mailbox: Mailbox;
    uid: number;
    headers: Buffer | undefined;
    internalDate: Date;
  },
): Promise<"confirmed" | "stored" | "ignored"> {
  const { client, mailbox } = input;
  if (!input.headers?.length) return "ignored";
  const head = await parseRawEmail(
    Buffer.concat([input.headers, Buffer.from("\r\n")]),
    mailbox.id,
    input.internalDate,
  );
  const verdict = await judgeSentEmail(ctx, mailbox, head);
  if (verdict.kind === "ignored") return "ignored";
  if (verdict.kind === "ours") {
    const { message } = verdict;
    if (message.mailbox_id !== mailbox.id) return "ignored";
    // A copy of our own email: the proof that this server keeps sent copies.
    await learnSavesSentCopies(ctx, mailbox.id);
    if (message.status !== "unknown" && !isQueuedResend(message)) return "ignored";
    const confirmed = await confirmEmailSent(ctx, message.id, {
      sentAt: message.dispatch_started_at ?? input.internalDate,
      resolution: `Found in the Sent folder of ${mailbox.email}.`,
      learnedCopy: true,
    });
    return confirmed ? "confirmed" : "ignored";
  }

  const [full] = await client.fetchAll(
    [input.uid],
    { uid: true, internalDate: true, source: { maxLength: MAX_SOURCE_BYTES } },
    { uid: true },
  );
  if (!full?.source) return "ignored";
  const email = await parseRawEmail(full.source, mailbox.id, input.internalDate);
  const stored = await storeSentEmail(ctx, mailbox, email, verdict);
  return stored ? "stored" : "ignored";
}
