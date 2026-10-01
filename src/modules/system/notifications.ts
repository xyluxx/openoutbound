import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { NOTIFICATION_CHANNEL_TYPES } from "../../core/enums.js";
import { invalid, notFound, OpenOutboundError } from "../../core/errors.js";
import { EVENT_TYPES } from "../../core/events.js";
import { failureSchema } from "../../core/failures.js";
import { idSchema, newId } from "../../core/ids.js";
import { defineOperation, isoDateTime, paginated, paginationInput } from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import { type NotificationChannel, notification_channels } from "../../db/schema/index.js";
import {
  FAILING_AFTER,
  recordChannelFailure,
  recordChannelSuccess,
  resolveFailing,
} from "../../runtime/channel-health.js";
import { sendToChannel } from "../../runtime/notify.js";
import { generateSigningSecret } from "../../runtime/webhooks.js";
import { assertDeliverableUrl } from "./webhooks.js";

const EVENT_FILTER_VALUES = [...EVENT_TYPES, "*"] as const;

const channelOutput = z.object({
  id: z.string(),
  type: z.enum(NOTIFICATION_CHANNEL_TYPES),
  name: z.string(),
  events: z
    .array(z.string())
    .describe(
      "Empty = curated notifications (hot replies, pauses, reports); otherwise these event types",
    ),
  enabled: z.boolean(),
  config: z
    .record(z.string(), z.unknown())
    .describe("Non-secret settings (email recipients, webhook URL)"),
  failing: z
    .boolean()
    .describe(
      `True after ${FAILING_AFTER} failed deliveries in a row (a problem is open); a delivery or test that works clears it`,
    ),
  consecutive_failures: z
    .number()
    .int()
    .describe("Failed deliveries in a row, retries and tests included (0 after one that worked)"),
  failing_since: isoDateTime().nullable(),
  last_error: z.string().nullable().describe("What the last failed delivery answered"),
  last_failure: failureSchema
    .nullable()
    .describe("Class of the last failure; retryable false means sending again cannot work"),
  created_at: isoDateTime(),
});

function toChannelView(row: NotificationChannel): z.input<typeof channelOutput> {
  const health = row.health;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    events: row.events,
    enabled: row.enabled,
    config: row.config,
    failing: Boolean(health?.failing_since),
    consecutive_failures: health?.consecutive_failures ?? 0,
    failing_since: health?.failing_since ?? null,
    last_error: health?.last_error ?? null,
    last_failure: health?.last_failure ?? null,
    created_at: row.created_at,
  };
}

const emailAddress = z.string().email().max(254);

export const createNotificationChannel = defineOperation({
  id: "notifications.create",
  summary: "Add a notification channel (Slack, email, webhook)",
  description:
    "Adds a place where humans get notified: slack_webhook (Slack incoming-webhook URL), email (recipients, sent through a connected mailbox) or webhook (signed JSON POST; the signing secret is returned once). Without `events` the channel receives curated notifications (hot replies, meetings, paused senders, reports); with event types it receives one short message per matching event instead. Use notifications.test to check it. Slack webhook URLs are stored encrypted.",
  effect: "admin",
  input: z.object({
    type: z.enum(NOTIFICATION_CHANNEL_TYPES),
    name: z.string().min(1).max(100),
    url: z
      .string()
      .url()
      .optional()
      .describe("slack_webhook and webhook: the https URL to POST to"),
    to: z.array(emailAddress).min(1).max(20).optional().describe("email: recipient addresses"),
    mailbox_id: idSchema("mbx")
      .optional()
      .describe("email: send from this mailbox (default: any active one)"),
    events: z
      .array(z.enum(EVENT_FILTER_VALUES))
      .max(EVENT_FILTER_VALUES.length)
      .optional()
      .describe("Event types to forward one by one; omit for curated notifications"),
  }),
  output: channelOutput.extend({
    secret: z.string().nullable().describe("webhook: signing secret, shown once"),
  }),
  http: { method: "POST", path: "/v1/notifications/channels" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Slack channel for the team",
      input: {
        type: "slack_webhook",
        name: "Sales alerts",
        url: "https://hooks.slack.com/services/T000/B000/XXXX",
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const id = newId("ntf");
    let config: Record<string, unknown> = {};
    let secretId: string | null = null;
    let secret: string | null = null;
    if (input.type === "email") {
      if (!input.to?.length) throw invalid("Email channels need `to` recipients.", { field: "to" });
      config = {
        to: input.to.map((address) => address.toLowerCase()),
        mailbox_id: input.mailbox_id ?? null,
      };
    } else {
      if (!input.url) throw invalid(`${input.type} channels need a \`url\`.`, { field: "url" });
      assertDeliverableUrl(ctx, input.url);
      if (input.type === "slack_webhook") {
        secretId = await ctx.vault.putSecret(workspace.id, `notification:${id}`, input.url);
        config = { url_host: new URL(input.url).host };
      } else {
        secret = generateSigningSecret();
        secretId = await ctx.vault.putSecret(workspace.id, `notification:${id}`, secret);
        config = { url: input.url };
      }
    }
    const events = input.events?.includes("*") ? ["*"] : [...new Set(input.events ?? [])];
    const [row] = await ctx.db
      .insert(notification_channels)
      .values({
        id,
        workspace_id: workspace.id,
        type: input.type,
        name: input.name,
        config,
        secret_id: secretId,
        events,
        created_at: ctx.clock.now(),
      })
      .returning();
    if (!row) throw new OpenOutboundError("internal", "Failed to create the channel.");
    return { ...toChannelView(row), secret };
  },
});

export const listNotificationChannels = defineOperation({
  id: "notifications.list",
  summary: "List notification channels",
  description:
    "Lists the workspace's notification channels (Slack, email, webhook) with their event filters and health. A channel whose last 5 deliveries failed shows failing true with the last error and its class, and a problem is open for it; it stays enabled so it recovers by itself once fixed. Secrets such as Slack webhook URLs are never shown (only their host). Check a channel with notifications.test.",
  effect: "read",
  scopes: ["admin"],
  input: paginationInput,
  output: paginated(channelOutput),
  http: { method: "GET", path: "/v1/notifications/channels" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "All channels", input: {} }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [eq(notification_channels.workspace_id, workspace.id)];
    if (input.cursor) {
      const cursor = decodeCursor<{ id: string }>(input.cursor);
      conditions.push(lt(notification_channels.id, String(cursor.id)));
    }
    const rows = await ctx.db
      .select()
      .from(notification_channels)
      .where(and(...conditions))
      .orderBy(desc(notification_channels.id))
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({ id: row.id }), toChannelView);
  },
});

async function loadChannel(ctx: OpContext, id: string): Promise<NotificationChannel> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(notification_channels)
    .where(
      and(eq(notification_channels.id, id), eq(notification_channels.workspace_id, workspace.id)),
    )
    .limit(1);
  if (!row) throw notFound("Notification channel", id);
  return row;
}

export const deleteNotificationChannel = defineOperation({
  id: "notifications.delete",
  summary: "Delete a notification channel",
  description:
    "Deletes a notification channel and its stored secret, and closes its failing problem if one is open. Use it when a Slack channel or recipient list is no longer wanted, or to replace a channel whose URL changed. Notifications already queued for it are dropped. Deleting twice returns deleted false.",
  effect: "admin",
  input: z.object({ channel_id: idSchema("ntf") }),
  output: z.object({ channel_id: z.string(), deleted: z.boolean() }),
  http: { method: "DELETE", path: "/v1/notifications/channels/:channel_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Delete", input: { channel_id: "ntf_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const [row] = await ctx.db
      .delete(notification_channels)
      .where(
        and(
          eq(notification_channels.id, input.channel_id),
          eq(notification_channels.workspace_id, workspace.id),
        ),
      )
      .returning();
    if (row?.secret_id) await ctx.vault.deleteSecret(row.secret_id);
    if (row) await resolveFailing(ctx, row, "The notification channel was removed.");
    return { channel_id: input.channel_id, deleted: Boolean(row) };
  },
});

export const testNotificationChannel = defineOperation({
  id: "notifications.test",
  summary: "Send a test notification now",
  description:
    "Sends a short test message to the channel right away and reports whether it arrived: the HTTP status, or the error with its failure class. Use it after adding a channel and to check a failing one. A test that works clears the channel's failure count and closes its failing problem; a failed test counts as a failed delivery and is not retried. Email channels need a connected mailbox.",
  effect: "admin",
  input: z.object({ channel_id: idSchema("ntf") }),
  output: z.object({
    channel_id: z.string(),
    ok: z.boolean(),
    status: z.number().nullable(),
    error: z.string().nullable(),
    failure: failureSchema
      .nullable()
      .describe("Why it failed; retryable false means sending again cannot work until fixed"),
  }),
  http: { method: "POST", path: "/v1/notifications/channels/:channel_id/test" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Test", input: { channel_id: "ntf_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const channel = await loadChannel(ctx, input.channel_id);
    const result = await sendToChannel(ctx, channel, {
      title: "Test notification from OpenOutbound",
      lines: [`Channel "${channel.name}" is connected.`],
      url: null,
      severity: "info",
      event: null,
    });
    if (result.ok) await recordChannelSuccess(ctx, channel);
    else if (result.failure) {
      await recordChannelFailure(ctx, channel, result.error ?? "unknown error", result.failure);
    }
    return {
      channel_id: channel.id,
      ok: result.ok,
      status: result.status,
      error: result.error,
      failure: result.failure,
    };
  },
});
