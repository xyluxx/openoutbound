/**
 * Public Unipile routes:
 * - POST /hooks/unipile: messaging, users and account_status webhooks. Authenticated by the
 *   `X-OpenOutbound-Secret` header, which must equal UNIPILE_WEBHOOK_SECRET (register the
 *   webhook in Unipile with that custom header). Events are queued as `linkedin.webhook_event`
 *   jobs with a singleton key per event, and the handlers are idempotent.
 * - POST /hooks/unipile/auth?state=...: hosted-auth notify callback. Authenticated by the
 *   encrypted, expiring state created by `linkedin.accounts.connect`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { OpContext } from "../../core/context.js";
import type { HttpRouteRegistrar } from "../../core/operation.js";
import { type LinkedInAccount, linkedin_accounts } from "../../db/schema/index.js";
import { providerFor } from "./accounts.js";
import { completeHostedAuth, decodeAuthState } from "./hosted-auth.js";
import { eventKey } from "./sync.js";

export const WEBHOOK_SECRET_HEADER = "x-openoutbound-secret";
export const WEBHOOK_SECRET_ENV = "UNIPILE_WEBHOOK_SECRET";

function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Unipile account id of a webhook body (message/relation events or AccountStatus). */
export function webhookAccountId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.account_id === "string") return record.account_id;
  const status = record.AccountStatus;
  if (typeof status === "object" && status !== null) {
    const id = (status as Record<string, unknown>).account_id;
    if (typeof id === "string") return id;
  }
  return null;
}

/**
 * The one account row a webhook belongs to. A LinkedIn account is used in one workspace only
 * (`linkedElsewhere`), so an event never fans out across workspaces: should two rows carry the
 * same provider account anyway (a race, or data from before that rule), the oldest row that is
 * not disconnected owns it, else the oldest. Null for none.
 */
export function webhookOwner(accounts: readonly LinkedInAccount[]): LinkedInAccount | null {
  const byAge = [...accounts].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : 1),
  );
  return byAge.find((account) => account.status !== "disconnected") ?? byAge[0] ?? null;
}

/** Parses a verified webhook for one account and queues its events. Returns the count. */
export async function queueWebhookEvents(
  ctx: OpContext,
  account: LinkedInAccount,
  body: unknown,
  headers: Record<string, string>,
): Promise<number> {
  const provider = await providerFor(ctx, account);
  if (!provider.parseWebhook) return 0;
  const events = await provider.parseWebhook(body, headers);
  for (const event of events) {
    await ctx.jobs.enqueue(
      "linkedin.webhook_event",
      { account_id: account.id, event },
      {
        workspaceId: account.workspace_id,
        singletonKey: `linkedin.webhook:${account.id}:${eventKey(event)}`,
      },
    );
  }
  await ctx.db
    .update(linkedin_accounts)
    .set({
      sync_state: { ...account.sync_state, last_webhook_at: ctx.clock.now().toISOString() },
    })
    .where(eq(linkedin_accounts.id, account.id));
  return events.length;
}

export const unipileRoutes: HttpRouteRegistrar = (app, { engine }) => {
  app.post("/hooks/unipile", async (c) => {
    const expected = engine.config.env[WEBHOOK_SECRET_ENV];
    if (!expected) {
      return c.json(
        {
          error: "webhook_not_configured",
          message: `Set ${WEBHOOK_SECRET_ENV} and send it in the ${WEBHOOK_SECRET_HEADER} header.`,
        },
        503,
      );
    }
    if (!sameSecret(c.req.header(WEBHOOK_SECRET_HEADER) ?? "", expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const externalId = webhookAccountId(body);
    if (!externalId) return c.json({ received: 0, ignored: "no_account_id" });
    const accounts = await engine.db
      .select()
      .from(linkedin_accounts)
      .where(
        and(
          eq(linkedin_accounts.provider, "unipile"),
          eq(linkedin_accounts.external_account_id, externalId),
        ),
      );
    const owner = webhookOwner(accounts);
    if (!owner) return c.json({ received: 0, ignored: "unknown_account" });
    if (accounts.length > 1) {
      engine.log.warn(
        {
          account_id: owner.id,
          workspace_id: owner.workspace_id,
          ignored: accounts.filter((account) => account.id !== owner.id).map((row) => row.id),
        },
        "unipile webhook: the LinkedIn account is connected in more than one workspace; events go to the oldest connection only",
      );
    }
    const headers = Object.fromEntries(c.req.raw.headers.entries());
    delete headers[WEBHOOK_SECRET_HEADER];
    const ctx = await engine.systemContext(owner.workspace_id);
    // Public routes leave an archived workspace alone; answered 200 so Unipile keeps the hook.
    if (ctx.workspace?.status === "archived") {
      return c.json({ received: 0, ignored: "workspace_archived" });
    }
    return c.json({ received: await queueWebhookEvents(ctx, owner, body, headers) });
  });

  app.post("/hooks/unipile/auth", async (c) => {
    const token = c.req.query("state") ?? "";
    const system = await engine.systemContext(null);
    const state = decodeAuthState(system.vault, token, system.clock.now());
    if (!state) return c.json({ error: "invalid_state" }, 400);
    let body: Record<string, unknown> = {};
    try {
      const parsed = await c.req.json();
      if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const externalId = typeof body.account_id === "string" ? body.account_id : null;
    if (!externalId) return c.json({ error: "missing_account_id" }, 400);
    if (typeof body.name === "string" && body.name !== state.acc) {
      return c.json({ error: "state_mismatch" }, 400);
    }
    const ctx = await engine.systemContext(state.ws);
    const result = await completeHostedAuth(ctx, {
      workspaceId: state.ws,
      accountId: state.acc,
      externalAccountId: externalId,
      status: typeof body.status === "string" ? body.status : null,
    });
    if (result.ok && !result.already) {
      await ctx.audit.record({
        operation: "linkedin.accounts.hosted_auth",
        effect: "write",
        status: "ok",
        target: { type: "linkedin_account", id: result.account_id },
        summary: "Connected the LinkedIn account through the Unipile hosted login",
      });
    }
    return c.json(result, result.ok ? 200 : 409);
  });
};
