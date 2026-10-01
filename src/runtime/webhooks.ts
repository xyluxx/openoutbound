/**
 * Outgoing webhooks (spec 9.4): signed POSTs of events to subscribed endpoints, delivered by
 * the `webhooks.deliver` job with the retry schedule 1m, 5m, 30m, 2h, 6h, 12h, 24h (8 attempts).
 *
 * Signature header: `OpenOutbound-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, arrayOverlaps, eq } from "drizzle-orm";
import { z } from "zod";
import type { JobQueue, OpContext } from "../core/context.js";
import { JobWaitError, OpenOutboundError, toOpenOutboundError } from "../core/errors.js";
import { defineJob } from "../core/operation.js";
import { events, webhook_deliveries, webhook_endpoints } from "../db/schema/index.js";
import type { Kernel } from "./kernel.js";

export const WEBHOOK_SIGNATURE_HEADER = "OpenOutbound-Signature";
/** Delay before retry n (after the n-th failed attempt). */
export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  24 * 3_600_000,
] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
const DELIVERY_TIMEOUT_MS = 10_000;

/** A new signing secret (`whsec_` + 32 base64url chars). */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export function signWebhookPayload(secret: string, body: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

/**
 * Verifies an `OpenOutbound-Signature` header (for receivers and tests): recomputes the HMAC,
 * compares in constant time and rejects timestamps outside the tolerance (default 5 minutes).
 */
export function verifyWebhookSignature(
  secret: string,
  header: string | null | undefined,
  body: string,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {},
): boolean {
  if (!header) return false;
  const parts = new Map<string, string[]>();
  for (const piece of header.split(",")) {
    const [key, value] = piece.trim().split("=", 2);
    if (!key || value === undefined) continue;
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }
  const timestamp = Number(parts.get("t")?.[0]);
  if (!Number.isInteger(timestamp)) return false;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"),
    "utf8",
  );
  return (parts.get("v1") ?? []).some((candidate) => {
    const given = Buffer.from(candidate, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface PostResult {
  ok: boolean;
  status: number | null;
  duration_ms: number;
  error: string | null;
  retry_after_seconds?: number;
}

/** POSTs a JSON body signed with `secret` through safe fetch. Never throws. */
export async function postSigned(
  ctx: Pick<OpContext, "fetch" | "clock">,
  input: { url: string; secret: string; body: string; headers?: Record<string, string> },
): Promise<PostResult> {
  const started = Date.now();
  const timestamp = Math.floor(ctx.clock.now().getTime() / 1000);
  try {
    const response = await ctx.fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(input.secret, input.body, timestamp),
        ...input.headers,
      },
      body: input.body,
      redirect: "manual",
      timeoutMs: DELIVERY_TIMEOUT_MS,
      maxBytes: 256 * 1024,
    });
    await response.body?.cancel().catch(() => {});
    const ok = response.status >= 200 && response.status < 300;
    return {
      ok,
      status: response.status,
      duration_ms: Date.now() - started,
      error: ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    const failure = toOpenOutboundError(error);
    const result: PostResult = {
      ok: false,
      status: null,
      duration_ms: Date.now() - started,
      error: failure.code === "internal" ? (error as Error).message : failure.message,
    };
    if (failure.retryAfterSeconds !== undefined)
      result.retry_after_seconds = failure.retryAfterSeconds;
    return result;
  }
}

/** The JSON body of an event delivery. */
export function eventDeliveryBody(event: typeof events.$inferSelect): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    occurred_at: event.occurred_at.toISOString(),
    workspace_id: event.workspace_id,
    subject:
      event.subject_type && event.subject_id
        ? { type: event.subject_type, id: event.subject_id }
        : null,
    data: event.data,
  });
}

/** Creates delivery rows (and jobs) for every enabled endpoint subscribed to the event type. */
export async function queueWebhookDeliveries(
  kernel: Pick<Kernel, "db" | "clock">,
  jobs: JobQueue,
  event: { id: string; workspaceId: string; type: string },
): Promise<number> {
  const endpoints = await kernel.db
    .select({ id: webhook_endpoints.id })
    .from(webhook_endpoints)
    .where(
      and(
        eq(webhook_endpoints.workspace_id, event.workspaceId),
        eq(webhook_endpoints.enabled, true),
        arrayOverlaps(webhook_endpoints.events, [event.type, "*"]),
      ),
    );
  for (const endpoint of endpoints) {
    const [delivery] = await kernel.db
      .insert(webhook_deliveries)
      .values({
        endpoint_id: endpoint.id,
        event_id: event.id,
        status: "pending",
        next_attempt_at: kernel.clock.now(),
        created_at: kernel.clock.now(),
      })
      .returning({ id: webhook_deliveries.id });
    if (!delivery) continue;
    await jobs.enqueue(
      "webhooks.deliver",
      { delivery_id: delivery.id },
      { workspaceId: event.workspaceId, singletonKey: `webhook_delivery:${delivery.id}` },
    );
  }
  return endpoints.length;
}

export const deliverWebhookJob = defineJob({
  name: "webhooks.deliver",
  payload: z.object({ delivery_id: z.string() }),
  handler: async (ctx, payload) => {
    const [row] = await ctx.db
      .select({ delivery: webhook_deliveries, endpoint: webhook_endpoints, event: events })
      .from(webhook_deliveries)
      .innerJoin(webhook_endpoints, eq(webhook_endpoints.id, webhook_deliveries.endpoint_id))
      .innerJoin(events, eq(events.id, webhook_deliveries.event_id))
      .where(eq(webhook_deliveries.id, payload.delivery_id))
      .limit(1);
    if (!row) return { skipped: "missing" };
    const { delivery, endpoint, event } = row;
    if (delivery.status !== "pending") return { skipped: delivery.status };
    const now = ctx.clock.now();
    const fail = async (reason: string) => {
      await ctx.db
        .update(webhook_deliveries)
        .set({ status: "failed", last_error: reason, next_attempt_at: null })
        .where(eq(webhook_deliveries.id, delivery.id));
      return { delivered: false, error: reason };
    };
    if (!endpoint.enabled) return fail("Endpoint disabled.");
    const secret = endpoint.secret_id
      ? await ctx.vault.getSecret(endpoint.secret_id, endpoint.workspace_id)
      : null;
    if (!secret) return fail("Signing secret missing; recreate the webhook.");

    const result = await postSigned(ctx, {
      url: endpoint.url,
      secret,
      body: eventDeliveryBody(event),
      headers: { "OpenOutbound-Event": event.type, "OpenOutbound-Delivery": delivery.id },
    });
    const attempts = delivery.attempts + 1;
    if (result.ok) {
      await ctx.db
        .update(webhook_deliveries)
        .set({
          status: "delivered",
          attempts,
          response_status: result.status,
          last_error: null,
          delivered_at: now,
          next_attempt_at: null,
        })
        .where(eq(webhook_deliveries.id, delivery.id));
      return { delivered: true, status: result.status, attempts };
    }
    if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
      await ctx.db
        .update(webhook_deliveries)
        .set({ attempts, response_status: result.status })
        .where(eq(webhook_deliveries.id, delivery.id));
      return fail(result.error ?? "Delivery failed.");
    }
    const delay = Math.max(
      WEBHOOK_RETRY_DELAYS_MS[attempts - 1] ?? WEBHOOK_RETRY_DELAYS_MS[0],
      (result.retry_after_seconds ?? 0) * 1000,
    );
    const next = new Date(now.getTime() + delay);
    await ctx.db
      .update(webhook_deliveries)
      .set({
        attempts,
        response_status: result.status,
        last_error: result.error,
        next_attempt_at: next,
      })
      .where(eq(webhook_deliveries.id, delivery.id));
    // Park the job (attempts are not consumed) until the next slot of the retry schedule.
    throw new JobWaitError(`webhook_delivery:${delivery.id}`, next);
  },
});

/** Error for URLs that cannot receive webhooks. */
export function invalidWebhookUrl(url: string, reason: string): OpenOutboundError {
  return new OpenOutboundError("validation_failed", `Invalid webhook URL "${url}": ${reason}`, {
    hint: "Use an https:// URL your server receives POSTs on.",
    details: { field: "url" },
  });
}
