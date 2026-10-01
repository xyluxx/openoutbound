/** Tokens for the inbound signals webhook (`POST /hooks/signals/<token>`). */
import { and, desc, eq, isNull, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { actorRef, requireWorkspace } from "../../../core/context.js";
import { notFound } from "../../../core/errors.js";
import { idSchema } from "../../../core/ids.js";
import { defineOperation, paginated, paginationInput } from "../../../core/operation.js";
import { decodeCursor, toPage } from "../../../core/pagination.js";
import { signal_webhook_tokens } from "../../../db/schema/index.js";
import { webhookTokenOutput, webhookTokenView } from "../shapes.js";
import { createWebhookToken, webhookUrl } from "../webhook-tokens.js";

export const webhookTokensCreate = defineOperation({
  id: "signals.webhook_tokens.create",
  summary: "Create a token for the inbound signals webhook",
  description:
    'Creates a secret URL other systems (a CRM, an intent tool, Zapier) can POST signals to: { "signals": [{ "key", "title", "evidence_url", "company": { "domain" }, "person": { "email" } }] }, up to 100 per request and 60 requests a minute. Unknown companies are created from their domain; add ?provider=crustdata to send a provider\'s own webhook format. Use it for continuous pushes; for a one-off batch call signals.ingest instead. The token is shown only in this answer: store it now, and revoke it with signals.webhook_tokens.revoke if it leaks.',
  effect: "admin",
  input: z.object({
    name: z.string().trim().min(1).max(80).describe("Who will use it, e.g. 'HubSpot workflow'"),
  }),
  output: webhookTokenOutput.extend({
    token: z.string().describe("Shown once; only a hash is stored"),
    url: z.string(),
  }),
  http: { method: "POST", path: "/v1/signal-webhook-tokens" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [{ title: "Token for a CRM workflow", input: { name: "CRM workflow" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const { row, token } = await createWebhookToken(ctx.db, {
      workspaceId: workspace.id,
      name: input.name,
      createdBy: actorRef(ctx.principal),
    });
    return { ...webhookTokenView(row), token, url: webhookUrl(ctx.config.baseUrl, token) };
  },
});

export const webhookTokensList = defineOperation({
  id: "signals.webhook_tokens.list",
  summary: "List inbound signals webhook tokens",
  description:
    "Lists the workspace's inbound signals webhook tokens with their prefix and last use, never the tokens themselves. Use it to find a token to revoke or to check that a sender is still posting. To create one use signals.webhook_tokens.create. Revoked tokens are hidden unless include_revoked is true.",
  effect: "read",
  input: paginationInput.extend({
    include_revoked: z.boolean().default(false),
  }),
  output: paginated(webhookTokenOutput),
  http: { method: "GET", path: "/v1/signal-webhook-tokens" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Active tokens", input: {} }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const conditions: SQL[] = [eq(signal_webhook_tokens.workspace_id, workspace.id)];
    if (!input.include_revoked) conditions.push(isNull(signal_webhook_tokens.revoked_at));
    if (input.cursor) {
      conditions.push(
        lt(signal_webhook_tokens.id, String(decodeCursor<{ id: string }>(input.cursor).id)),
      );
    }
    const rows = await ctx.db
      .select()
      .from(signal_webhook_tokens)
      .where(and(...conditions))
      .orderBy(desc(signal_webhook_tokens.id))
      .limit(input.limit + 1);
    return toPage(rows, input.limit, (row) => ({ id: row.id }), webhookTokenView);
  },
});

export const webhookTokensRevoke = defineOperation({
  id: "signals.webhook_tokens.revoke",
  summary: "Revoke an inbound signals webhook token",
  description:
    "Revokes a webhook token: requests with it are refused (401) from now on. Use it when a token leaked or a sender is retired; create a new one with signals.webhook_tokens.create. Revoking twice is harmless. Signals already received stay.",
  effect: "admin",
  input: z.object({ token_id: idSchema("swt").describe("Token id (swt_...), not the token") }),
  output: webhookTokenOutput,
  http: { method: "POST", path: "/v1/signal-webhook-tokens/:token_id/revoke" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Revoke a token", input: { token_id: "swt_01k6a3v0q8x3m2n4p5r6s7t8v9" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const [row] = await ctx.db
      .select()
      .from(signal_webhook_tokens)
      .where(
        and(
          eq(signal_webhook_tokens.workspace_id, workspace.id),
          eq(signal_webhook_tokens.id, input.token_id),
        ),
      );
    if (!row) throw notFound("Webhook token", input.token_id);
    if (row.revoked_at) return webhookTokenView(row);
    const [updated] = await ctx.db
      .update(signal_webhook_tokens)
      .set({ revoked_at: ctx.clock.now() })
      .where(eq(signal_webhook_tokens.id, row.id))
      .returning();
    return webhookTokenView(updated ?? row);
  },
});

export const webhookTokenOperations = [webhookTokensCreate, webhookTokensList, webhookTokensRevoke];
