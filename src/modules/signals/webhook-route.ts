/**
 * `POST /hooks/signals/:token`: inbound signals from other systems. The token (stored hashed)
 * picks the workspace. Body: the documented generic shape (see providers/signals/webhook.ts),
 * or a provider's own webhook payload with `?provider=<id>` (for example crustdata watchers).
 * Rate limited per token; unknown companies are created from their domain.
 */
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isOpenOutboundError } from "../../core/errors.js";
import type { HttpRouteRegistrar } from "../../core/operation.js";
import { signal_webhook_tokens } from "../../db/schema/index.js";
import { parseWebhookBody } from "../../providers/signals/webhook.js";
import { creatorKeyEnded } from "../../runtime/api-keys.js";
import { ingestSignals } from "./ingest.js";
import { createRateLimiter, findActiveToken, type RateLimiter } from "./webhook-tokens.js";

export const WEBHOOK_MAX_BYTES = 512 * 1024;

function problem(
  c: Context,
  status: 400 | 401 | 404 | 413 | 422 | 429 | 500,
  code: string,
  detail: string,
  hint?: string,
) {
  return c.json(
    { type: "about:blank", title: code, status, code, detail, ...(hint ? { hint } : {}) },
    status,
    {
      "content-type": "application/problem+json",
    },
  );
}

function tooLarge(c: Context) {
  return problem(
    c,
    413,
    "validation_failed",
    "The body is larger than 512 KB.",
    "Send at most 100 signals per request.",
  );
}

function unknownToken(c: Context) {
  return problem(
    c,
    401,
    "unauthorized",
    "Unknown or revoked webhook token.",
    "Create a token with signals.webhook_tokens.create and use the URL it returns.",
  );
}

export function signalsWebhookRoute(options: { limiter?: RateLimiter } = {}): HttpRouteRegistrar {
  const limiter = options.limiter ?? createRateLimiter();
  return (app, { engine }) => {
    app.post(
      "/hooks/signals/:token",
      bodyLimit({ maxSize: WEBHOOK_MAX_BYTES, onError: (c) => tooLarge(c) }),
      async (c) => {
        const token = await findActiveToken(engine.db, c.req.param("token"));
        if (!token) return unknownToken(c);
        const allowed = limiter.take(token.id);
        if (!allowed.ok) {
          c.header("retry-after", String(allowed.retryAfterSeconds));
          return problem(
            c,
            429,
            "limit_reached",
            "Too many webhook requests for this token.",
            `Retry after ${allowed.retryAfterSeconds} seconds; batch up to 100 signals per request.`,
          );
        }
        const declared = Number(c.req.header("content-length") ?? 0);
        let text: string | null = null;
        if (declared <= WEBHOOK_MAX_BYTES) {
          try {
            // bodyLimit aborts the read of an oversized streamed body.
            text = await c.req.text();
          } catch {
            text = null;
          }
        }
        if (text === null || text.length > WEBHOOK_MAX_BYTES) {
          return tooLarge(c);
        }
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return problem(c, 400, "validation_failed", "The body is not valid JSON.");
        }

        const ctx = await engine.systemContext(token.workspace_id);
        // A token made by a key stops working with that key (revoked or expired).
        if (await creatorKeyEnded(ctx.db, token.created_by, ctx.clock.now())) {
          return unknownToken(c);
        }
        if (ctx.workspace?.status === "archived") {
          return problem(c, 404, "not_found", "This workspace is archived.");
        }
        const providerId = c.req.query("provider");
        let parsed: ReturnType<typeof parseWebhookBody>;
        if (providerId && providerId !== "webhook") {
          const provider = await ctx.providers.tryGet("signals", { id: providerId });
          if (!provider?.parseWebhook) {
            return problem(
              c,
              404,
              "not_found",
              `No signals provider "${providerId}" with webhook support is configured.`,
              "Configure the provider with manage_providers, or drop the provider query parameter.",
            );
          }
          try {
            const headers = Object.fromEntries(
              Object.entries(c.req.header()).map(([k, v]) => [k.toLowerCase(), v]),
            );
            const signals = await provider.parseWebhook(body, headers);
            parsed = { signals: signals.map((signal, index) => ({ index, signal })), errors: [] };
          } catch (error) {
            return problem(
              c,
              422,
              "validation_failed",
              `The ${providerId} payload could not be read: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else {
          try {
            parsed = parseWebhookBody(body);
          } catch (error) {
            return problem(
              c,
              422,
              "validation_failed",
              error instanceof Error ? error.message : String(error),
              'Send { "signals": [{ "key", "title", "evidence_url", "company": { "domain" } }] }.',
            );
          }
        }

        try {
          const result = await ingestSignals(ctx, {
            items: parsed.signals,
            invalid: parsed.errors,
            createCompanies: true,
          });
          await engine.db
            .update(signal_webhook_tokens)
            .set({ last_used_at: ctx.clock.now() })
            .where(eq(signal_webhook_tokens.id, token.id));
          await ctx.audit.record({
            operation: "signals.webhook",
            effect: "write",
            status: "ok",
            target: { type: "signal_webhook_token", id: token.id },
            summary: `${result.created} new of ${result.received} signals from the webhook (${result.duplicates} duplicates, ${result.skipped} skipped)`,
          });
          return c.json(result, 200);
        } catch (error) {
          const message = isOpenOutboundError(error)
            ? error.message
            : "Unexpected error while storing signals.";
          engine.log.error({ err: error, token: token.id }, "signals webhook failed");
          return problem(c, 500, "internal", message);
        }
      },
    );
  };
}
