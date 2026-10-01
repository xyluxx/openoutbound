import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { type JobContext, requireWorkspace } from "../../core/context.js";
import { defineJob } from "../../core/operation.js";
import { parseWorkspaceSettings } from "../../core/settings.js";
import {
  type Mailbox,
  type MailboxSyncState,
  mailboxes,
  type StuckMessage,
} from "../../db/schema/index.js";
import { openProblem } from "../problems/service.js";
import { isAuthFailure, mailAuth } from "./credentials.js";
import {
  createImapClient,
  FIRST_SYNC_LOOKBACK_MS,
  foldersToSync,
  isImapAuthError,
  MAX_PER_FOLDER,
  MAX_SOURCE_BYTES,
} from "./imap.js";
import { ingestInboundEmail } from "./inbound/ingest.js";
import { parseRawEmail } from "./inbound/parse.js";
import type { IngestResult } from "./inbound/types.js";
import { mailboxReadDownKey, recordSyncError, recordSyncSuccess } from "./mailbox-state.js";
import { type SentCursor, type SentSyncSummary, syncSentFolder } from "./sent-folder.js";
import { usesSandboxTransport } from "./transport.js";

export const SYNC_ALL_JOB = "email.sync_all";
export const SYNC_MAILBOX_JOB = "email.sync_mailbox";

/** Syncs in a row stopped at the same message after which the read problem opens. */
export const STUCK_SYNCS_PROBLEM = 3;

/**
 * Every mailbox with IMAP keeps syncing unless it is disconnected (removed ones are gone): a
 * paused mailbox or one whose SMTP login fails (`error`) still receives replies, bounces and
 * unsubscribe replies that must be read.
 */
function isSyncable(mailbox: Pick<Mailbox, "status" | "imap">): boolean {
  return mailbox.status !== "disconnected" && Boolean(mailbox.imap?.host);
}

export function syncJobKey(mailboxId: string): string {
  return `${SYNC_MAILBOX_JOB}:${mailboxId}`;
}

/** Fans out one `email.sync_mailbox` job per syncable mailbox (every 5 minutes, per workspace). */
export const syncAllJob = defineJob({
  name: SYNC_ALL_JOB,
  maxAttempts: 1,
  handler: async (ctx) => {
    const workspace = requireWorkspace(ctx);
    const rows = await ctx.db
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.workspace_id, workspace.id),
          ne(mailboxes.status, "disconnected"),
          isNotNull(mailboxes.imap),
        ),
      );
    let enqueued = 0;
    for (const mailbox of rows) {
      if (!isSyncable(mailbox) || usesSandboxTransport(workspace, mailbox)) continue;
      await ctx.jobs.enqueue(
        SYNC_MAILBOX_JOB,
        { mailbox_id: mailbox.id },
        { workspaceId: workspace.id, singletonKey: syncJobKey(mailbox.id) },
      );
      enqueued += 1;
    }
    return { enqueued };
  },
});

export const syncMailboxJob = defineJob({
  name: SYNC_MAILBOX_JOB,
  payload: z.object({ mailbox_id: z.string() }),
  maxAttempts: 1,
  timeoutMs: 4 * 60_000,
  handler: (ctx, payload) => syncMailbox(ctx, payload.mailbox_id),
});

export interface SyncSummary {
  mailbox_id: string;
  status: "synced" | "skipped" | "error";
  folders: number;
  fetched: number;
  kinds: Partial<Record<IngestResult["kind"], number>>;
  errors: number;
  error?: string;
  /** The Sent folder pass (when `inbox.read_sent_folder` is on). */
  sent?: SentSyncSummary;
  /** The message this sync could not store: its folder waits at it. */
  stuck?: Pick<StuckMessage, "folder" | "uid" | "error" | "syncs">;
}

/**
 * IMAP sync for one mailbox: INBOX plus spam/junk folders, read-only, UID tracking per folder
 * (a UIDVALIDITY change resets the folder), new mail since the last UID (first sync: the last 3
 * days), every message through `ingestInboundEmail`. Problems, a refused login included, are
 * recorded in `health.last_sync_error` without changing the sending status. With
 * `inbox.read_sent_folder` on, the Sent folder is read too (sent-folder.ts), on its own cursor.
 *
 * A message that cannot be stored is never skipped (it may be an unsubscribe): its folder waits
 * at it and the next sync tries it first. Such a sync is not clean: it is an error with the
 * folder, the UID and the error (`health.stuck_message`, `last_sync_error`), and after
 * STUCK_SYNCS_PROBLEM syncs in a row at the same message the mailbox's `mailbox_down` problem
 * for reading opens. A sync that gets past it closes the problem.
 */
export async function syncMailbox(ctx: JobContext, mailboxId: string): Promise<SyncSummary> {
  const workspace = requireWorkspace(ctx);
  const summary: SyncSummary = {
    mailbox_id: mailboxId,
    status: "synced",
    folders: 0,
    fetched: 0,
    kinds: {},
    errors: 0,
  };
  const [mailbox] = await ctx.db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.workspace_id, workspace.id)))
    .limit(1);
  if (!mailbox?.imap?.host || !isSyncable(mailbox) || usesSandboxTransport(workspace, mailbox)) {
    return { ...summary, status: "skipped" };
  }

  let auth: Awaited<ReturnType<typeof mailAuth>>;
  try {
    auth = await mailAuth(ctx, mailbox, "imap");
  } catch (error) {
    return failSync(ctx, mailbox, summary, error, isAuthFailure(error));
  }
  const client = createImapClient({
    host: mailbox.imap.host,
    port: mailbox.imap.port,
    secure: mailbox.imap.secure,
    auth,
  });
  try {
    await client.connect();
  } catch (error) {
    client.close();
    return failSync(ctx, mailbox, summary, error, isImapAuthError(error));
  }

  const now = ctx.clock.now();
  const state: MailboxSyncState = { folders: { ...(mailbox.sync_state?.folders ?? {}) } };
  const folders = state.folders ?? {};
  const readSent = parseWorkspaceSettings(workspace.settings).inbox.read_sent_folder;
  let sentCursor: SentCursor | null | undefined;
  let syncError: unknown;
  /** The first message this sync could not store. */
  let stuck: { folder: string; uid: number; error: string } | null = null;
  try {
    const list = await client.list();
    for (const folder of foldersToSync(list)) {
      summary.folders += 1;
      const lock = await client.getMailboxLock(folder.path, { readOnly: true });
      try {
        const box = client.mailbox;
        if (!box) continue;
        const uidValidity = Number(box.uidValidity);
        const previous = folders[folder.path];
        const fresh = !previous || previous.uidvalidity !== uidValidity;
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
        if (uids.length > 0) {
          const fetched = await client.fetchAll(
            uids,
            { uid: true, internalDate: true, size: true, source: { maxLength: MAX_SOURCE_BYTES } },
            { uid: true },
          );
          fetched.sort((a, b) => a.uid - b.uid);
          for (const message of fetched) {
            if (!message.source) {
              lastUid = message.uid;
              continue;
            }
            let email: Awaited<ReturnType<typeof parseRawEmail>>;
            try {
              const internal = message.internalDate ? new Date(message.internalDate) : now;
              email = await parseRawEmail(
                message.source,
                mailbox.id,
                Number.isNaN(internal.getTime()) ? now : internal,
              );
            } catch (error) {
              summary.errors += 1;
              ctx.log.warn(
                { mailbox_id: mailbox.id, uid: message.uid, err: String(error) },
                "email: unparseable message skipped",
              );
              lastUid = message.uid;
              continue;
            }
            try {
              const result = await ingestInboundEmail(ctx, email);
              summary.kinds[result.kind] = (summary.kinds[result.kind] ?? 0) + 1;
              summary.fetched += 1;
              lastUid = message.uid;
            } catch (error) {
              // The folder waits at this message (skipping it could lose an unsubscribe): the
              // next run starts at it, also when this was the folder's first sync.
              summary.errors += 1;
              stuck ??= {
                folder: folder.path,
                uid: message.uid,
                error: String((error as Error)?.message ?? error).slice(0, 300),
              };
              lastUid = Math.max(lastUid, message.uid - 1);
              ctx.log.error(
                { mailbox_id: mailbox.id, uid: message.uid, err: String(error) },
                "email: ingest failed",
              );
              break;
            }
          }
        } else if (fresh) {
          lastUid = Math.max(0, box.uidNext - 1);
        }
        folders[folder.path] = { uidvalidity: uidValidity, last_uid: lastUid };
      } finally {
        lock.release();
      }
    }
    if (readSent) {
      try {
        const sent = await syncSentFolder(ctx, { client, mailbox, list, now });
        summary.sent = sent.summary;
        sentCursor = sent.cursor;
      } catch (error) {
        // The Sent folder never holds up reading replies: it is tried again next sync.
        summary.sent = { folder: null, seen: 0, confirmed: 0, stored: 0, ignored: 0, errors: 1 };
        ctx.log.warn(
          { mailbox_id: mailbox.id, err: String((error as Error)?.message ?? error).slice(0, 300) },
          "email: the Sent folder could not be read",
        );
      }
    }
  } catch (error) {
    summary.status = "error";
    summary.error = String((error as Error)?.message ?? error).slice(0, 300);
    summary.errors += 1;
    syncError = error;
  } finally {
    await client.logout().catch(() => client.close());
  }

  // A sync stopped at a message it could not store is not clean; one that got past it is.
  const stuckMessage = stuck ? stuckAgain(mailbox, stuck, now) : null;
  if (stuckMessage) {
    const { folder, uid, error, syncs } = stuckMessage;
    summary.stuck = { folder, uid, error, syncs };
    if (summary.status === "synced") {
      summary.status = "error";
      summary.error = `Could not store message UID ${uid} in ${folder}: ${error}`;
    }
  }
  const stuckChanged = stuckMessage !== null || summary.status === "synced";
  await ctx.db
    .update(mailboxes)
    .set({
      sync_state: {
        ...mailbox.sync_state,
        folders,
        ...(sentCursor !== undefined ? { sent: sentCursor } : {}),
      },
      ...(summary.status === "synced" ? { last_synced_at: now } : {}),
      ...(stuckChanged
        ? {
            health: sql`${mailboxes.health} || ${JSON.stringify({ stuck_message: stuckMessage })}::jsonb`,
          }
        : {}),
    })
    .where(eq(mailboxes.id, mailbox.id));
  if (summary.status === "synced") await recordSyncSuccess(ctx, mailbox);
  else {
    await recordSyncError(ctx, mailbox, summary.error ?? "sync failed", {
      loginFailed: false,
      // The text classifies a message that could not be stored: tried again every sync.
      cause: syncError ?? summary.error,
    });
    if (stuckMessage && stuckMessage.syncs >= STUCK_SYNCS_PROBLEM) {
      await openStuckProblem(ctx, mailbox, stuckMessage);
    }
  }
  return summary;
}

/** The stuck message after this sync: the count goes on while it is the same message. */
function stuckAgain(
  mailbox: Mailbox,
  stuck: { folder: string; uid: number; error: string },
  now: Date,
): StuckMessage {
  const previous = mailbox.health?.stuck_message;
  const same = previous?.folder === stuck.folder && previous.uid === stuck.uid;
  return {
    ...stuck,
    since: same ? previous.since : now.toISOString(),
    syncs: same ? previous.syncs + 1 : 1,
  };
}

/** Opens or refreshes the mailbox's `mailbox_down` problem for reading (never throws). */
async function openStuckProblem(
  ctx: JobContext,
  mailbox: Mailbox,
  stuck: StuckMessage,
): Promise<void> {
  try {
    await openProblem(ctx, {
      kind: "mailbox_down",
      severity: "high",
      owner: "person",
      title: `Mailbox ${mailbox.email} cannot read replies`,
      reason: `Message UID ${stuck.uid} in ${stuck.folder} could not be stored in ${stuck.syncs} syncs in a row (${stuck.error.replace(/\s+/g, " ").slice(0, 200)}). The sync waits at it so that no reply, bounce or unsubscribe reply is skipped, so newer mail in that folder is not read. Sending is not affected.`,
      remedy: `Find the message in ${stuck.folder} (UID ${stuck.uid}) and handle it by hand: answer it if it is a reply, or add the sender with manage_suppressions action add if it asks to unsubscribe. Then move it to a folder the sync does not read, such as an archive folder. The next sync goes on past it and closes this problem.`,
      subject: { type: "mailbox", id: mailbox.id },
      data: {
        mailbox_id: mailbox.id,
        email: mailbox.email,
        folder: stuck.folder,
        uid: stuck.uid,
        syncs: stuck.syncs,
        error: stuck.error,
      },
      dedupeKey: mailboxReadDownKey(mailbox.id),
    });
  } catch (cause) {
    ctx.log.warn({ err: String(cause), mailbox_id: mailbox.id }, "could not open mailbox_down");
  }
}

async function failSync(
  ctx: JobContext,
  mailbox: Mailbox,
  summary: SyncSummary,
  error: unknown,
  authFailure: boolean,
): Promise<SyncSummary> {
  const text = String((error as Error)?.message ?? error).slice(0, 300);
  const message = authFailure ? `IMAP login failed: ${text}` : text;
  await recordSyncError(ctx, mailbox, message, { loginFailed: authFailure, cause: error });
  return { ...summary, status: "error", error: message, errors: summary.errors + 1 };
}
