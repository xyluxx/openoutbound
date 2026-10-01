/**
 * Human notifications to the workspace's channels (Slack incoming webhook, signed webhook,
 * email through the email module's `sendSystemEmail`).
 *
 * Routing, designed so nobody gets the same thing twice:
 * - `notify(ctx, input)` (curated messages from modules) goes to channels without an event
 *   filter, or exactly to `input.channelIds` when given.
 * - Channels that subscribe to event types (or "*") get one compact message per matching event
 *   when it is emitted.
 * Deliveries run as `notifications.deliver` jobs (retried), so `notify` never blocks or throws.
 */
import { isIP } from "node:net";
import { and, arrayOverlaps, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { callFailure } from "../core/call-failure.js";
import type { JobQueue, OpContext } from "../core/context.js";
import type { EventSubject, EventType } from "../core/events.js";
import {
  classifyHttpStatus,
  type Failure,
  type FailureClass,
  isRetryableClass,
  providerFailure,
  scopeOfClass,
} from "../core/failures.js";
import { defineJob } from "../core/operation.js";
import { type NotificationChannel, notification_channels } from "../db/schema/index.js";
import { recordChannelFailure, recordChannelSuccess } from "./channel-health.js";
import { isPrivateAddress } from "./ip-policy.js";
import type { Kernel } from "./kernel.js";
import { postSigned } from "./webhooks.js";

export interface NotifyInput {
  /** One line, e.g. "Hot reply from Dana Reyes (Harbor Dental)". */
  title: string;
  /** Short detail lines. */
  lines?: string[];
  /** Link to the item (absolute, or a path under the engine base URL). Shown when the base URL is public. */
  url?: string | null;
  severity?: "info" | "warning" | "critical";
  /** The event this notification is about (recorded on the message). */
  event?: EventType;
  /**
   * Exact routing: deliver only to these channels of the workspace (enabled ones), whatever
   * their event filters. Used for user-picked channels (e.g. scheduled reports).
   */
  channelIds?: string[];
}

/** A rendered notification as stored in the delivery job payload. */
export interface NotificationMessage {
  title: string;
  lines: string[];
  url: string | null;
  severity: "info" | "warning" | "critical";
  event: string | null;
}

const messageSchema = z.object({
  title: z.string(),
  lines: z.array(z.string()),
  url: z.string().nullable(),
  severity: z.enum(["info", "warning", "critical"]),
  event: z.string().nullable(),
});

/** True when links to this URL would work for people outside this machine. */
export function isPublicUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) return !isPrivateAddress(host);
  const local =
    host === "localhost" ||
    !host.includes(".") ||
    [".localhost", ".local", ".internal", ".lan", ".home.arpa"].some((suffix) =>
      host.endsWith(suffix),
    );
  return !local;
}

/** Absolute link for the message, or null when the engine has no public base URL. */
export function publicLink(baseUrl: string, url: string | null | undefined): string | null {
  if (!url) return null;
  const absolute = url.startsWith("/") ? `${baseUrl}${url}` : url;
  return isPublicUrl(absolute) ? absolute : null;
}

function toMessage(input: NotifyInput): NotificationMessage {
  return {
    title: input.title.slice(0, 300),
    lines: (input.lines ?? []).map((line) => line.slice(0, 500)).slice(0, 20),
    url: input.url ?? null,
    severity: input.severity ?? "info",
    event: input.event ?? null,
  };
}

/**
 * Sends a notification to the workspace channels without an event filter (or to
 * `input.channelIds`). Never throws on delivery problems (they are logged and retried by the
 * delivery job).
 */
export async function notify(ctx: OpContext, input: NotifyInput): Promise<void> {
  const workspaceId = ctx.workspace?.id;
  if (!workspaceId) {
    ctx.log.warn({ title: input.title }, "notify called without a workspace; skipped");
    return;
  }
  try {
    const routing =
      input.channelIds !== undefined
        ? inArray(notification_channels.id, input.channelIds.length > 0 ? input.channelIds : [""])
        : sql`cardinality(${notification_channels.events}) = 0`;
    const channels = await ctx.db
      .select({ id: notification_channels.id })
      .from(notification_channels)
      .where(
        and(
          eq(notification_channels.workspace_id, workspaceId),
          eq(notification_channels.enabled, true),
          routing,
        ),
      );
    const message = toMessage(input);
    for (const channel of channels) {
      await ctx.jobs.enqueue(
        "notifications.deliver",
        { channel_id: channel.id, message },
        { workspaceId },
      );
    }
  } catch (error) {
    ctx.log.error({ err: error, title: input.title }, "notify failed");
  }
}

const EVENT_TITLES: Partial<Record<EventType, string>> = {
  "reply.received": "New reply received",
  "reply.classified": "Reply classified",
  "thread.needs_attention": "A thread needs attention",
  "approval.requested": "Approval requested",
  "approval.decided": "Approval decided",
  "opportunity.updated": "Opportunity updated",
  "mailbox.paused": "Mailbox paused",
  "mailbox.error": "Mailbox error",
  "linkedin.account_restricted": "LinkedIn account restricted",
  "linkedin.connected": "LinkedIn invite accepted",
  "message.bounced": "Email bounced",
  "message.failed": "Message failed",
  "unsubscribe.received": "Unsubscribe received",
  "campaign.launched": "Campaign launched",
  "campaign.paused": "Campaign paused",
  "campaign.completed": "Campaign completed",
  "knowledge.gap_opened": "Knowledge gap opened",
  "report.ready": "Report ready",
  "signal.detected": "Buying signal detected",
};

const WARNING_EVENTS = new Set<string>([
  "mailbox.paused",
  "mailbox.error",
  "message.failed",
  "message.bounced",
  "thread.needs_attention",
]);
const CRITICAL_EVENTS = new Set<string>(["linkedin.account_restricted"]);

/** Compact message for a subscribed event: a title plus up to 8 scalar data fields. */
export function renderEventNotification(type: string, data: unknown): NotificationMessage {
  const lines: string[] = [];
  if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (lines.length >= 8) break;
      if (value === null || value === undefined || typeof value === "object") continue;
      lines.push(`${key}: ${String(value).slice(0, 200)}`);
    }
  }
  return {
    title: EVENT_TITLES[type as EventType] ?? `Event ${type}`,
    lines,
    url: null,
    severity: CRITICAL_EVENTS.has(type)
      ? "critical"
      : WARNING_EVENTS.has(type)
        ? "warning"
        : "info",
    event: type,
  };
}

/** Enqueues deliveries for channels that subscribe to this event type (or "*"). */
export async function queueEventNotifications(
  kernel: Pick<Kernel, "db">,
  jobs: JobQueue,
  event: { workspaceId: string; type: string; data: unknown; subject: EventSubject | null },
): Promise<number> {
  const channels = await kernel.db
    .select({ id: notification_channels.id })
    .from(notification_channels)
    .where(
      and(
        eq(notification_channels.workspace_id, event.workspaceId),
        eq(notification_channels.enabled, true),
        arrayOverlaps(notification_channels.events, [event.type, "*"]),
      ),
    );
  if (channels.length === 0) return 0;
  const message = renderEventNotification(event.type, event.data);
  for (const channel of channels) {
    await jobs.enqueue(
      "notifications.deliver",
      { channel_id: channel.id, message },
      { workspaceId: event.workspaceId },
    );
  }
  return channels.length;
}

function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Slack incoming-webhook payload: a section with the title and lines, plus a link context. */
export function slackPayload(message: NotificationMessage, link: string | null) {
  const icon =
    message.severity === "critical"
      ? ":rotating_light: "
      : message.severity === "warning"
        ? ":warning: "
        : "";
  const body = [`*${escapeSlack(message.title)}*`, ...message.lines.map(escapeSlack)]
    .join("\n")
    .slice(0, 2900);
  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: `${icon}${body}` } },
  ];
  if (link) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${link}|Open in OpenOutbound>` }],
    });
  }
  return { text: `${icon}${message.title}`, blocks };
}

export interface ChannelSendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  /** Why it failed: `retryable: false` means sending again cannot work until the channel is fixed. */
  failure: Failure | null;
  retry_after_seconds?: number;
}

const TIMED_OUT = /timed? ?out/i;
const REFUSED = /private or internal address|robots\.txt/i;

/**
 * The failure of a channel that answered with an HTTP status, or, when the request did not get an
 * answer (the signed webhook path only reports the error text), a timeout, a refused address or
 * a network failure.
 */
function answerFailure(
  provider: string,
  status: number | null,
  error: string | null,
  retryAfterSeconds?: number,
): Failure {
  const failureClass: FailureClass =
    status !== null
      ? classifyHttpStatus(status)
      : retryAfterSeconds !== undefined
        ? "rate_limited"
        : TIMED_OUT.test(error ?? "")
          ? "timeout"
          : REFUSED.test(error ?? "")
            ? "refused"
            : "network";
  return {
    class: failureClass,
    retryable: isRetryableClass(failureClass),
    scope: scopeOfClass(failureClass),
    provider,
    ...(retryAfterSeconds === undefined ? {} : { retry_after_s: retryAfterSeconds }),
    ...(status === null ? {} : { upstream_status: status }),
  };
}

/** Sends one message to one channel. Returns the outcome instead of throwing. */
export async function sendToChannel(
  ctx: OpContext,
  channel: NotificationChannel,
  message: NotificationMessage,
): Promise<ChannelSendResult> {
  const link = publicLink(ctx.config.baseUrl, message.url);
  try {
    if (channel.type === "email") {
      const config = channel.config as { to?: string[]; mailbox_id?: string | null };
      if (!config.to?.length) {
        return {
          ok: false,
          status: null,
          error: "No recipients configured.",
          failure: { class: "bad_request", retryable: false, scope: "call", provider: "email" },
        };
      }
      const { sendSystemEmail } = await import("../modules/email/service.js");
      const text = [...message.lines, ...(link ? ["", link] : [])].join("\n");
      await sendSystemEmail(ctx, {
        to: config.to,
        subject: message.title,
        text: text || message.title,
        mailboxId: config.mailbox_id ?? null,
      });
      return { ok: true, status: null, error: null, failure: null };
    }
    const secret = channel.secret_id
      ? await ctx.vault.getSecret(channel.secret_id, channel.workspace_id)
      : null;
    if (!secret) {
      return {
        ok: false,
        status: null,
        error: "Channel secret missing; recreate the channel.",
        failure: {
          class: "auth_invalid",
          retryable: false,
          scope: "account",
          provider: channel.type,
        },
      };
    }
    if (channel.type === "slack_webhook") {
      const response = await ctx.fetch(secret, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(slackPayload(message, link)),
        redirect: "manual",
        timeoutMs: 10_000,
        maxBytes: 64 * 1024,
      });
      const text = await response.text().catch(() => "");
      if (response.ok) return { ok: true, status: response.status, error: null, failure: null };
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait = response.status === 429 && Number.isFinite(retryAfter) ? retryAfter : undefined;
      const result: ChannelSendResult = {
        ok: false,
        status: response.status,
        error: `Slack answered ${response.status}${text ? ` (${text.slice(0, 100)})` : ""}`,
        failure: answerFailure(channel.type, response.status, null, wait),
      };
      if (wait !== undefined) result.retry_after_seconds = wait;
      return result;
    }
    const url = String((channel.config as { url?: unknown }).url ?? "");
    const result = await postSigned(ctx, {
      url,
      secret,
      body: JSON.stringify({
        type: "notification",
        workspace_id: channel.workspace_id,
        title: message.title,
        lines: message.lines,
        url: link,
        severity: message.severity,
        event: message.event,
        sent_at: ctx.clock.now().toISOString(),
      }),
    });
    const out: ChannelSendResult = {
      ok: result.ok,
      status: result.status,
      error: result.error,
      failure: result.ok
        ? null
        : answerFailure(channel.type, result.status, result.error, result.retry_after_seconds),
    };
    if (result.retry_after_seconds !== undefined)
      out.retry_after_seconds = result.retry_after_seconds;
    return out;
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: (error as Error).message,
      failure: callFailure(error, channel.type),
    };
  }
}

export const deliverNotificationJob = defineJob({
  name: "notifications.deliver",
  payload: z.object({ channel_id: z.string(), message: messageSchema }),
  maxAttempts: 4,
  backoff: { type: "exponential", baseMs: 60_000, maxMs: 30 * 60_000 },
  handler: async (ctx, payload) => {
    const [channel] = await ctx.db
      .select()
      .from(notification_channels)
      .where(eq(notification_channels.id, payload.channel_id))
      .limit(1);
    if (!channel?.enabled) return { skipped: channel ? "disabled" : "missing" };
    if (ctx.workspace && channel.workspace_id !== ctx.workspace.id) return { skipped: "foreign" };
    const result = await sendToChannel(ctx, channel, payload.message);
    if (!result.ok) {
      const error = result.error ?? "unknown error";
      const failure = result.failure ?? answerFailure(channel.type, result.status, error);
      await recordChannelFailure(ctx, channel, error, failure);
      const check = `manage_notifications action test (channel_id ${channel.id})`;
      throw providerFailure({
        provider: channel.type,
        class: failure.class,
        message: `Notification to "${channel.name}" failed: ${error}`,
        hint: failure.retryable
          ? `It is retried by itself. To check the channel now, use ${check}.`
          : `Sending again cannot work until the channel is fixed. Check it with ${check}; if its URL or recipients changed, add it again with action create and remove this one with action delete.`,
        retryable: failure.retryable,
        scope: failure.scope,
        ...(failure.upstream_status === undefined
          ? {}
          : { upstreamStatus: failure.upstream_status }),
        ...(failure.retry_after_s === undefined
          ? {}
          : { retryAfterSeconds: failure.retry_after_s }),
        details: { channel_id: channel.id, status: result.status },
      });
    }
    await recordChannelSuccess(ctx, channel);
    return { delivered: true, channel: channel.type };
  },
});
