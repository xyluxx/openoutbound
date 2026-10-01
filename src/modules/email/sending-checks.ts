/**
 * Sending rules shared by the campaign launch checklist, workspace readiness
 * (workspaces.readiness and the `sending` block of get_status) and the send job, so every view
 * says what the sender does.
 */
import type { EngineConfig } from "../../core/config.js";
import type { MessageAction } from "../../core/enums.js";
import type { Mailbox, Workspace } from "../../db/schema/index.js";
import { usesSandboxTransport } from "./transport.js";
import { unsubscribeReadiness } from "./unsubscribe-token.js";

/** How to give the engine an address recipients can reach (checklist fix, problem remedy). */
export const PUBLIC_BASE_URL_FIX =
  "Set OPENOUTBOUND_BASE_URL in the engine's .env to its public https address (for example https://outbound.example.com), then restart `openoutbound serve`.";

/** True when the engine's base URL is a public https address, so unsubscribe links work. */
export function hasPublicBaseUrl(config: Pick<EngineConfig, "baseUrl">): boolean {
  return unsubscribeReadiness(config).one_click;
}

/**
 * Whether an email must wait for a public https base URL before it goes out. Campaign email to
 * real people needs a working unsubscribe link, so without one it is held instead of being sent
 * without it. Sandbox email keeps its simulated link, and a reply to someone who wrote to us
 * (action `reply`) is never held: they can always answer "unsubscribe".
 */
export function holdsForUnsubscribeLink(
  config: Pick<EngineConfig, "baseUrl">,
  workspace: Workspace,
  mailbox: Mailbox | null,
  action: MessageAction,
): boolean {
  if (action === "reply" || workspace.is_sandbox) return false;
  if (mailbox && usesSandboxTransport(workspace, mailbox)) return false;
  return !hasPublicBaseUrl(config);
}

/** Replies, bounces and unsubscribes by reply reach the engine: IMAP, or the sandbox simulator. */
export function readsReplies(workspace: Workspace, mailbox: Mailbox): boolean {
  return usesSandboxTransport(workspace, mailbox) || Boolean(mailbox.imap?.host);
}
