import { isIP } from "node:net";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { type OpContext, requireWorkspace } from "../../core/context.js";
import { notFound, OpenOutboundError } from "../../core/errors.js";
import { EVENT_TYPES } from "../../core/events.js";
import { idSchema, newId } from "../../core/ids.js";
import { defineOperation, isoDateTime, paginated, paginationInput } from "../../core/operation.js";
import { decodeCursor, toPage } from "../../core/pagination.js";
import {
  type WebhookEndpoint,
  webhook_deliveries,
  webhook_endpoints,
} from "../../db/schema/index.js";
import { isPrivateAddress } from "../../runtime/ip-policy.js";
import { generateSigningSecret, invalidWebhookUrl, postSigned } from "../../runtime/webhooks.js";

const EVENT_FILTER_VALUES = [...EVENT_TYPES, "*"] as const;
const eventFilter = z
  .array(z.enum(EVENT_FILTER_VALUES))
  .min(1)
  .max(EVENT_FILTER_VALUES.length)
  .describe('Event types to deliver, or ["*"] for all');

/** Throws unless the URL can receive webhooks (https; http only for private networks when allowed). */
export function assertDeliverableUrl(ctx: Pick<OpContext, "config">, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidWebhookUrl(value, "not a URL");
  }
  const allowPrivate = ctx.config.allowPrivateNetwork;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowPrivate)) {
    throw invalidWebhookUrl(value, "only https:// URLs are allowed");
  }
  if (url.username || url.password)
    throw invalidWebhookUrl(value, "credentials in URLs are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    (isIP(host) !== 0 && isPrivateAddress(host));
  if (local && !allowPrivate) {
    throw invalidWebhookUrl(
      value,
      "private and local addresses are blocked (OPENOUTBOUND_ALLOW_PRIVATE_NETWORK)",
    );
  }
  return url;
}

const webhookOutput = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(z.string()),
  enabled: z.boolean(),
  created_at: isoDateTime(),
  deliveries: z
    .object({ pending: z.number(), delivered: z.number(), failed: z.number() })
    .optional()
    .describe("Last 30 days"),
});

function toWebhookView(row: WebhookEndpoint): z.input<typeof webhookOutput> {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    enabled: row.enabled,
    created_at: row.created_at,
  };
}

export const createWebhook = defineOperation({
  id: "webhooks.create",
  summary: "Subscribe a URL to engine events",
  description:
    'Registers an https endpoint that receives signed POSTs for the chosen event types (or all with "*"): body { id, type, occurred_at, workspace_id, subject, data }, header OpenOutbound-Signature t=<unix>,v1=<hmac-sha256 of t.body>. Use it to connect CRMs, Zapier-style tools or your own systems. The signing secret is returned once; failed deliveries retry for about 2 days. Payloads hold ids, never message bodies.',
  effect: "admin",
  input: z.object({
    url: z.string().url().describe("https:// endpoint that accepts POST"),
    events: eventFilter,
    description: z.string().max(200).optional(),
  }),
  output: webhookOutput.extend({
    secret: z.string().describe("Signing secret (shown once)"),
    note: z.string(),
  }),
  http: { method: "POST", path: "/v1/webhooks" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    {
      title: "Replies and meetings to a CRM",
      input: {
        url: "https://hooks.example.com/openoutbound",
        events: ["reply.classified", "opportunity.updated"],
      },
    },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    assertDeliverableUrl(ctx, input.url);
    const id = newId("whk");
    const secret = generateSigningSecret();
    const secretId = await ctx.vault.putSecret(workspace.id, `webhook:${id}`, secret);
    const events = input.events.includes("*") ? ["*"] : [...new Set(input.events)];
    const [row] = await ctx.db
      .insert(webhook_endpoints)
      .values({
        id,
        workspace_id: workspace.id,
        url: input.url,
        description: input.description ?? null,
        events,
        secret_id: secretId,
        created_at: ctx.clock.now(),
      })
      .returning();
    if (!row) throw new OpenOutboundError("internal", "Failed to create the webhook.");
    return {
      ...toWebhookView(row),
      secret,
      note: "Store the secret now; verify each delivery's OpenOutbound-Signature with it.",
    };
  },
});

export const listWebhooks = defineOperation({
  id: "webhooks.list",
  summary: "List webhook endpoints",
  description:
    "Lists the workspace's webhook endpoints with their event filters and, with response_format detailed, delivery counts for the last 30 days. Use it to check what receives events and whether deliveries fail. Secrets are never shown. Test an endpoint with webhooks.test.",
  effect: "read",
  scopes: ["admin"],
  input: paginationInput,
  output: paginated(webhookOutput),
  http: { method: "GET", path: "/v1/webhooks" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "All endpoints", input: {} }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions = [eq(webhook_endpoints.workspace_id, workspace.id)];
    if (input.cursor) {
      const cursor = decodeCursor<{ id: string }>(input.cursor);
      conditions.push(lt(webhook_endpoints.id, String(cursor.id)));
    }
    const rows = await ctx.db
      .select()
      .from(webhook_endpoints)
      .where(and(...conditions))
      .orderBy(desc(webhook_endpoints.id))
      .limit(input.limit + 1);
    const page = toPage(rows, input.limit, (row) => ({ id: row.id }), toWebhookView);
    if (ctx.request.responseFormat === "detailed") {
      const since = new Date(ctx.clock.now().getTime() - 30 * 24 * 60 * 60 * 1000);
      for (const item of page.items) {
        const counts = await ctx.db
          .select({
            status: webhook_deliveries.status,
            count: sql<number>`count(*)`.mapWith(Number),
          })
          .from(webhook_deliveries)
          .where(
            and(
              eq(webhook_deliveries.endpoint_id, item.id),
              sql`${webhook_deliveries.created_at} >= ${since}`,
            ),
          )
          .groupBy(webhook_deliveries.status);
        const byStatus = Object.fromEntries(counts.map((entry) => [entry.status, entry.count]));
        item.deliveries = {
          pending: byStatus.pending ?? 0,
          delivered: byStatus.delivered ?? 0,
          failed: byStatus.failed ?? 0,
        };
      }
    }
    return page;
  },
});

async function loadWebhook(ctx: OpContext, id: string): Promise<WebhookEndpoint> {
  const workspace = requireWorkspace(ctx);
  const [row] = await ctx.db
    .select()
    .from(webhook_endpoints)
    .where(and(eq(webhook_endpoints.id, id), eq(webhook_endpoints.workspace_id, workspace.id)))
    .limit(1);
  if (!row) throw notFound("Webhook", id);
  return row;
}

export const deleteWebhook = defineOperation({
  id: "webhooks.delete",
  summary: "Delete a webhook endpoint",
  description:
    "Deletes a webhook endpoint, its signing secret and its pending deliveries. Use it when the receiving system is gone. To pause deliveries instead, there is no toggle yet: delete and recreate later (the new endpoint gets a new secret). Deleting twice returns deleted false.",
  effect: "admin",
  input: z.object({ webhook_id: idSchema("whk") }),
  output: z.object({ webhook_id: z.string(), deleted: z.boolean() }),
  http: { method: "DELETE", path: "/v1/webhooks/:webhook_id" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Delete", input: { webhook_id: "whk_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const [row] = await ctx.db
      .delete(webhook_endpoints)
      .where(
        and(
          eq(webhook_endpoints.id, input.webhook_id),
          eq(webhook_endpoints.workspace_id, workspace.id),
        ),
      )
      .returning();
    if (row?.secret_id) await ctx.vault.deleteSecret(row.secret_id);
    return { webhook_id: input.webhook_id, deleted: Boolean(row) };
  },
});

export const testWebhook = defineOperation({
  id: "webhooks.test",
  summary: "Send a signed test delivery now",
  description:
    "Sends one signed test event (type webhook.test) to the endpoint right away and reports the HTTP status, latency and error. Use it after creating an endpoint or when deliveries fail. It does not create a delivery record and is not retried. The receiver should answer 2xx within 10 seconds.",
  effect: "admin",
  input: z.object({ webhook_id: idSchema("whk") }),
  output: z.object({
    webhook_id: z.string(),
    ok: z.boolean(),
    status: z.number().nullable(),
    duration_ms: z.number(),
    error: z.string().nullable(),
  }),
  http: { method: "POST", path: "/v1/webhooks/:webhook_id/test" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Test", input: { webhook_id: "whk_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const endpoint = await loadWebhook(ctx, input.webhook_id);
    const secret = endpoint.secret_id
      ? await ctx.vault.getSecret(endpoint.secret_id, endpoint.workspace_id)
      : null;
    if (!secret) {
      throw new OpenOutboundError("conflict", "This webhook has no signing secret.", {
        hint: "Delete it and create it again.",
      });
    }
    const body = JSON.stringify({
      id: newId("evt"),
      type: "webhook.test",
      occurred_at: ctx.clock.now().toISOString(),
      workspace_id: endpoint.workspace_id,
      subject: null,
      data: { message: "Test delivery from OpenOutbound." },
    });
    const result = await postSigned(ctx, {
      url: endpoint.url,
      secret,
      body,
      headers: { "OpenOutbound-Event": "webhook.test" },
    });
    return {
      webhook_id: endpoint.id,
      ok: result.ok,
      status: result.status,
      duration_ms: result.duration_ms,
      error: result.error,
    };
  },
});
