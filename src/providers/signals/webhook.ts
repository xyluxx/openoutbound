/**
 * Generic inbound signals webhook (`POST /hooks/signals/:token`). Documented body:
 *
 *   { "signals": [{ "key": "funding_round",
 *                   "company": { "domain": "acme.example.com", "name": "Acme" },
 *                   "person": { "email": "...", "linkedin_url": "..." },
 *                   "title": "Raised a Series A", "summary": "...",
 *                   "evidence_url": "https://...", "evidence_excerpt": "...",
 *                   "occurred_at": "2026-09-01T00:00:00Z", "strength": 0.8,
 *                   "dedupe_key": "optional stable id" }] }
 *
 * Items are validated one by one so a bad item never rejects the whole batch.
 */
import { z } from "zod";
import type { RawSignal, SignalProvider } from "../types.js";
import { defineProvider } from "../types.js";

export const WEBHOOK_MAX_SIGNALS = 100;

export const webhookSignalSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,63}$/, { message: "key must be a snake_case signal key" }),
  company: z
    .object({
      id: z.string().max(64).optional(),
      domain: z.string().max(253).optional(),
      name: z.string().max(200).optional(),
      linkedin_url: z.string().max(300).optional(),
    })
    .optional(),
  person: z
    .object({
      id: z.string().max(64).optional(),
      email: z.string().max(254).optional(),
      linkedin_url: z.string().max(300).optional(),
      full_name: z.string().max(200).optional(),
    })
    .optional(),
  title: z.string().min(1).max(300),
  summary: z.string().max(2000).optional(),
  evidence_url: z.string().min(1).max(2000),
  evidence_excerpt: z.string().max(2000).optional(),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
  strength: z.number().min(0).max(1).optional(),
  dedupe_key: z.string().min(1).max(200).optional(),
});

export type WebhookSignal = z.infer<typeof webhookSignalSchema>;

export interface ParsedWebhook {
  /** Valid items with their position in the body. */
  signals: Array<{ index: number; signal: RawSignal }>;
  errors: Array<{ index: number; message: string }>;
}

/** Maps one documented item to a RawSignal. */
export function toRawSignal(item: WebhookSignal, source = "webhook"): RawSignal {
  const signal: RawSignal = {
    definition_key: item.key,
    title: item.title,
    summary: item.summary ?? null,
    evidence_url: item.evidence_url,
    evidence_excerpt: item.evidence_excerpt ?? null,
    source,
    occurred_at: item.occurred_at ?? null,
  };
  if (item.strength !== undefined) signal.strength = item.strength;
  if (item.dedupe_key) signal.dedupe_key = `${source}:${item.dedupe_key}`;
  if (item.company) {
    signal.company = {
      ...(item.company.id ? { id: item.company.id } : {}),
      ...(item.company.name ? { name: item.company.name } : {}),
      domain: item.company.domain ?? null,
      linkedin_url: item.company.linkedin_url ?? null,
    };
  }
  if (item.person) {
    signal.person = {
      ...(item.person.id ? { id: item.person.id } : {}),
      email: item.person.email ?? null,
      linkedin_url: item.person.linkedin_url ?? null,
      full_name: item.person.full_name ?? null,
    };
  }
  return signal;
}

/** Validates a webhook body; throws only when the envelope itself is wrong. */
export function parseWebhookBody(body: unknown): ParsedWebhook {
  const envelope = z
    .object({ signals: z.array(z.unknown()).min(1).max(WEBHOOK_MAX_SIGNALS) })
    .safeParse(body);
  if (!envelope.success) {
    throw new Error(`Expected { "signals": [...] } with 1 to ${WEBHOOK_MAX_SIGNALS} items.`);
  }
  const result: ParsedWebhook = { signals: [], errors: [] };
  envelope.data.signals.forEach((raw, index) => {
    const parsed = webhookSignalSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      result.errors.push({
        index,
        message: issue ? `${issue.path.join(".") || "item"}: ${issue.message}` : "invalid item",
      });
      return;
    }
    result.signals.push({ index, signal: toRawSignal(parsed.data) });
  });
  return result;
}

export function createWebhookSignals(): SignalProvider {
  return {
    id: "webhook",
    // Any key the workspace defines; the webhook never collects on its own.
    supportedSignals: [],
    creditsPerCall: 0,
    collect: async () => [],
    parseWebhook: async (body) => parseWebhookBody(body).signals.map((item) => item.signal),
  };
}

export const webhookSignalsProvider = defineProvider({
  slot: "signals",
  id: "webhook",
  name: "Inbound webhook",
  description:
    "Accepts signals from any system at /hooks/signals/<token> in a documented JSON shape (create a token with signals.webhook_tokens.create).",
  secrets: [],
  // It only receives: no outside service to pause.
  health: false,
  create: () => createWebhookSignals(),
  test: async () => ({
    ok: true,
    message: "Inbound webhook ready; create a token to receive signals.",
  }),
});
