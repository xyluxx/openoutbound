/**
 * Inbound CRM facts webhook `/hooks/crm/:token`: a per-workspace secret URL (only the token's
 * SHA-256 is stored) that a CRM workflow, Zapier or n8n calls with the same JSON as `crm.facts`
 * (`{ crm, facts: [...] }`, plus an optional `dry_run: true`). It acts as the engine itself.
 */
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { actorRef, requireWorkspace } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import { defineOperation, type HttpRouteRegistrar, isoDateTime } from "../../core/operation.js";
import type { Db } from "../../db/client.js";
import { type CrmWebhook, crm_webhooks } from "../../db/schema/index.js";
import { creatorKeyEnded } from "../../runtime/api-keys.js";
import { crmFactsInput, recordCrmFacts } from "./crm-facts.js";

const TOKEN_PATTERN = /^crmh_[A-Za-z0-9_-]{20,64}$/;
/** Room for 500 facts with notes. */
const MAX_BODY_CHARS = 512 * 1024;

export function hashCrmToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateCrmToken(): string {
  return `crmh_${randomBytes(24).toString("base64url")}`;
}

export function crmWebhookUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/hooks/crm/${token}`;
}

/** The webhook row for a URL token, or null (malformed, unknown or rotated). */
export async function findCrmWebhook(db: Db, token: string): Promise<CrmWebhook | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const [row] = await db
    .select()
    .from(crm_webhooks)
    .where(eq(crm_webhooks.token_hash, hashCrmToken(token)))
    .limit(1);
  return row ?? null;
}

export const createCrmWebhook = defineOperation({
  id: "crm.create_webhook",
  summary: "Create (or rotate) the inbound CRM facts webhook URL",
  description:
    "Creates this workspace's secret URL where a CRM workflow, Zapier or n8n can POST the same JSON as manage_crm action record_facts ({ crm, facts }) without an API key: customers, open deals, owners and do-not-contact people then stop outreach at once. The URL is shown only once; call again with rotate: true to replace it (the old URL stops working). Use record_facts directly when you, the agent, read the CRM yourself.",
  effect: "admin",
  input: z.object({
    rotate: z.boolean().default(false).describe("Replace the existing URL"),
  }),
  output: z.object({
    url: z.string().describe("Secret: anyone with it can report CRM facts for this workspace"),
    token_hint: z.string(),
    rotated: z.boolean(),
    created_at: isoDateTime(),
    accepts: z.array(z.string()),
  }),
  http: { method: "POST", path: "/v1/crm/webhook" },
  dryRun: "none",
  idempotent: false,
  workspace: "required",
  examples: [
    { title: "Create the URL", input: {} },
    { title: "Replace a leaked URL", input: { rotate: true } },
  ],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const [existing] = await ctx.db
      .select()
      .from(crm_webhooks)
      .where(eq(crm_webhooks.workspace_id, workspace.id))
      .limit(1);
    if (existing && !input.rotate) {
      throw new OpenOutboundError(
        "conflict",
        `This workspace already has a CRM webhook URL (ending in ${existing.token_hint}).`,
        {
          hint: "Pass rotate: true to issue a new URL; the old one stops working at once.",
          details: { token_hint: existing.token_hint },
        },
      );
    }
    const token = generateCrmToken();
    const now = ctx.clock.now();
    const values = {
      token_hash: hashCrmToken(token),
      token_hint: token.slice(-4),
      created_by: actorRef(ctx.principal),
      last_used_at: null,
      updated_at: now,
    };
    if (existing) {
      await ctx.db.update(crm_webhooks).set(values).where(eq(crm_webhooks.id, existing.id));
    } else {
      await ctx.db.insert(crm_webhooks).values({ ...values, workspace_id: workspace.id });
    }
    return {
      url: crmWebhookUrl(ctx.config.baseUrl, token),
      token_hint: values.token_hint,
      rotated: Boolean(existing),
      created_at: now,
      accepts: [
        'JSON { "crm": "hubspot", "facts": [{ "fact": "customer", "domain": "..." }] }, like manage_crm action record_facts',
        'Optional "dry_run": true to preview without changing anything',
      ],
    };
  },
});

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

function unknownUrl(c: Context) {
  return c.json(
    {
      error: "not_found",
      message: "Unknown CRM webhook URL.",
      hint: "Create a new URL with manage_crm (action webhook).",
    },
    404,
  );
}

/** `POST /hooks/crm/:token` (public route: authenticated by the secret token). */
export const crmWebhookRoute: HttpRouteRegistrar = (app, { engine }) => {
  app.post("/hooks/crm/:token", async (c) => {
    const hook = await findCrmWebhook(engine.db, c.req.param("token"));
    if (!hook) return unknownUrl(c);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_BODY_CHARS) {
      return c.json({ error: "too_large", message: "The body is larger than 512 KB." }, 413);
    }
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_CHARS) {
      return c.json({ error: "too_large", message: "The body is larger than 512 KB." }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_json", message: "The body is not valid JSON." }, 400);
    }
    const dryRun =
      typeof body === "object" && body !== null && (body as { dry_run?: unknown }).dry_run === true;
    const parsed = crmFactsInput.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_body",
          message: summarizeIssues(parsed.error),
          hint: 'Send { "crm": "<name>", "facts": [{ "fact": "customer", "domain": "..." }] } with 1 to 500 facts.',
        },
        400,
      );
    }
    try {
      const ctx = await engine.systemContext(hook.workspace_id);
      // A URL made by a key stops working with that key (revoked or expired).
      if (await creatorKeyEnded(ctx.db, hook.created_by, ctx.clock.now())) return unknownUrl(c);
      // Public routes leave an archived workspace alone (unsubscribes excepted).
      if (ctx.workspace?.status === "archived") {
        return c.json(
          {
            error: "not_found",
            message: "This workspace is archived.",
            hint: "Ask the workspace owner to restore it (openoutbound workspaces update --no-archived) to record CRM facts again.",
          },
          404,
        );
      }
      const result = await recordCrmFacts(ctx, parsed.data, { dryRun });
      if (!dryRun) {
        await engine.db
          .update(crm_webhooks)
          .set({ last_used_at: ctx.clock.now() })
          .where(eq(crm_webhooks.id, hook.id));
        await ctx.audit.record({
          operation: "crm.webhook",
          effect: "write",
          status: "ok",
          target: { type: "crm_webhook", id: hook.id },
          summary: `${result.summary.changed} of ${result.summary.facts} CRM facts from ${result.crm} changed something`,
        });
      }
      return c.json({ ok: true, dry_run: dryRun, ...result }, 200);
    } catch (error) {
      engine.log.error({ err: error, webhook: hook.id }, "CRM webhook failed");
      return c.json(
        { error: "internal", message: "The facts could not be recorded; please retry." },
        500,
      );
    }
  });
};
