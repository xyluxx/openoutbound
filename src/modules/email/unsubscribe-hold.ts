/**
 * The hold for real email that would go out without a working unsubscribe link (the base URL
 * is not a public https address). The send gate holds it: it stays `scheduled` and is checked
 * again every 30 minutes. The send job opens one `sending_blocked` problem per workspace with
 * the fix, and resolves it once such an email goes out with its link again. Replies to people
 * who wrote to us and sandbox email are never held (sending-checks.ts).
 */
import type { OpContext } from "../../core/context.js";
import type { Mailbox, Message, Workspace } from "../../db/schema/index.js";
import { openProblem, resolveProblemsFor } from "../problems/service.js";
import { PUBLIC_BASE_URL_FIX } from "./sending-checks.js";
import { usesSandboxTransport } from "./transport.js";

/** Blocker code of the hold (its words are in relationships/blockers.ts). */
export const UNSUBSCRIBE_LINK_MISSING = "unsubscribe_link_missing";

/** How long a held email waits before it is checked again. */
export const UNSUBSCRIBE_RECHECK_MS = 30 * 60_000;

/** One problem per workspace for this reason. */
const DEDUPE_KEY = "sending_blocked:base_url";

/** The key a held send job waits on. */
export function unsubscribeLinkKey(workspaceId: string): string {
  return `unsubscribe_link:${workspaceId}`;
}

/** Opens (or refreshes) the workspace's `sending_blocked` problem for the missing base URL. */
export async function openUnsubscribeHoldProblem(ctx: OpContext): Promise<void> {
  const baseUrl = ctx.config.baseUrl;
  await openProblem(ctx, {
    kind: "sending_blocked",
    severity: "high",
    owner: "person",
    title: "Emails are held: no public address for their unsubscribe link",
    reason: `OPENOUTBOUND_BASE_URL is ${baseUrl}, which recipients cannot reach, so campaign emails would go out without a working unsubscribe link. They stay scheduled and are checked again every 30 minutes. Replies to people who wrote to you still go out.`,
    remedy: `${PUBLIC_BASE_URL_FIX} Held emails go out at their next check, within 30 minutes.`,
    data: { base_url: baseUrl },
    dedupeKey: DEDUPE_KEY,
  });
}

/**
 * After the gate let an email through: when it needed its unsubscribe link (not a reply, not
 * sandbox email), the link works again, so the hold's problem is over.
 */
export async function resolveUnsubscribeHoldProblem(
  ctx: OpContext,
  workspace: Workspace,
  mailbox: Mailbox,
  message: Pick<Message, "action">,
): Promise<void> {
  if (message.action === "reply" || usesSandboxTransport(workspace, mailbox)) return;
  await resolveProblemsFor(
    ctx,
    { dedupeKey: DEDUPE_KEY },
    "Emails carry a working unsubscribe link again: OPENOUTBOUND_BASE_URL is a public https address.",
  );
}
