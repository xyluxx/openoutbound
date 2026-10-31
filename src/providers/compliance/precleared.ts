/**
 * Precleared cold email check (https://precleared.dev/docs/integrate). `POST /api/v1/check`
 * with the recipient address, the sender's country and how the address was obtained answers
 * whether a cold or marketing email may go to that person under UK PECR and GDPR, US CAN-SPAM,
 * Canada's CASL, Germany's UWG, France's CPCE, Australia's Spam Act, Ireland's ePrivacy
 * Regulations and the Dutch Telecommunicatiewet, looking the recipient up live (Companies House,
 * the domain, the company's website). Every 200 answer uses one check of the allowance (10 a day
 * without a key, more with a free key), so a lost answer is not repeated automatically.
 *
 * Documented errors: 400 (a bad field: fixed here, no check used), 401 (the key was rejected),
 * 402 `payment_required` (the key has no checks left today; the answer carries where to buy
 * more), 429 `daily_limit` (the keyless allowance is used up for today; a free key gives this
 * instance its own) and 429 `rate_limited` (wait `retry_after` seconds and try once more, which
 * this provider does for short waits). The key travels in the Authorization header only.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { failureOf, retryAfterOf } from "../../core/failures.js";
import { USER_AGENT } from "../../core/version.js";
import {
  asNumber,
  asRecord,
  asString,
  malformed,
  requestJson,
  statusFailure,
} from "../lead-source/http.js";
import {
  type ComplianceProvider,
  defineProvider,
  EMAIL_CHECK_VERDICTS,
  type EmailCheckInput,
  type EmailCheckResult,
  type EmailCheckVerdict,
} from "../types.js";

export const preclearedConfigSchema = z.object({
  base_url: z.url({ protocol: /^https?$/ }).default("https://precleared.dev"),
  /**
   * Precleared answers within about 25 seconds (with `unknown` when a register lookup is slow);
   * the request timeout covers connecting (about 10 s) and the answer (30 s).
   */
  timeout_seconds: z.number().int().min(5).max(120).default(40),
});
export type PreclearedConfig = z.output<typeof preclearedConfigSchema>;

const PROVIDER = { provider: "Precleared", slot: "compliance", providerId: "precleared" } as const;
/** The `?src=` tag and the agent name Precleared sees, so it can tell which tool is calling. */
export const SOURCE_TAG = "openoutbound";
export const GET_KEY_URL = "https://precleared.dev/get-key";
const BUY_URL = "https://precleared.dev/buy";
/** Hosts a 402 answer's checkout link may point at; anything else falls back to BUY_URL. */
const BUY_HOSTS = ["precleared.dev", "checkout.stripe.com"];
/** Precleared's limits for the names sent with a check; longer values would be refused. */
const MAX_COMPANY_NAME = 160;
const MAX_RECIPIENT_NAME = 120;
const MAX_PITCH = 200;
/** A `rate_limited` answer asking for a longer wait is not retried inside the call. */
export const MAX_RATE_LIMIT_WAIT_S = 15;

export interface PreclearedOptions {
  /** Empty for the keyless allowance. */
  apiKey: string;
  config: PreclearedConfig;
  fetch: typeof fetch;
  /** Waits before the one retry of a rate-limited call (tests pass a fake). */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The one-line names Precleared accepts: runs of whitespace made single spaces, cut to the limit. */
function cut(value: string | null | undefined, limit: number): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit).trim();
  return text || null;
}

/** A two-letter country code, or null. */
function countryCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** The request body for one check (exported for tests and for the cache fingerprint). */
export function checkPayload(input: EmailCheckInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    recipient_email: input.email.trim().toLowerCase(),
    sender_country: input.sender_country,
    address_source: input.address_source,
  };
  const company = cut(input.company_name, MAX_COMPANY_NAME);
  const name = cut(input.recipient_name, MAX_RECIPIENT_NAME);
  const number = cut(input.company_number, 20);
  const pitch = cut(input.pitch, MAX_PITCH);
  const recipientCountry = countryCode(input.recipient_country);
  const defaultCountry = countryCode(input.default_recipient_country);
  if (company) payload.company_name = company;
  if (name) payload.recipient_name = name;
  if (number) payload.company_number = number;
  // Never both: a country the engine is sure of settles it; a guess only fills a gap.
  if (recipientCountry) payload.recipient_country = recipientCountry;
  else if (defaultCountry) payload.default_recipient_country = defaultCountry;
  if (input.existing_customer === true) payload.existing_customer = true;
  if (pitch) payload.pitch = pitch;
  return payload;
}

/**
 * The checkout link of a 402 answer, when it is a plain https link to Precleared or its card
 * checkout; otherwise Precleared's buy page. Never a link an answer could point anywhere.
 */
export function buyUrl(body: unknown): string {
  const raw = asString(asRecord(body)?.buy_url);
  if (!raw || raw.length > 2048 || /\s/.test(raw)) return BUY_URL;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const trusted = BUY_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
    if (url.protocol !== "https:" || !trusted || url.username || url.password) return BUY_URL;
    return url.toString();
  } catch {
    return BUY_URL;
  }
}

/** The words Precleared gives the operator, or null. */
function operatorMessage(body: unknown): string | null {
  const record = asRecord(body);
  return asString(record?.operator_message) ?? asString(record?.next_step);
}

/** The documented error code of an answer (`daily_limit`, `rate_limited`, ...), or null. */
function errorCode(body: unknown): string | null {
  const error = asRecord(body)?.error;
  if (typeof error === "string") return error.trim() || null;
  return asString(asRecord(error)?.code);
}

/** `retry_after` of an answer body, in seconds, or null. */
function bodyRetryAfter(body: unknown): number | null {
  const seconds = asNumber(asRecord(body)?.retry_after);
  return seconds !== null && seconds >= 0 ? Math.ceil(seconds) : null;
}

const keyCommand = `openoutbound providers set --slot compliance --provider precleared --secrets '{"api_key":"pc_live_..."}'`;

/**
 * The classified failure for a documented error answer. 402 and 429 `daily_limit` are
 * `quota_exhausted` (the engine pauses the provider and opens one problem with these words);
 * 429 `rate_limited` is `rate_limited` with its wait; 400 is `bad_request` (the input, not the
 * provider); anything else keeps the meaning of its status.
 */
export function preclearedFailure(status: number, body: unknown, headers: Headers) {
  const words = operatorMessage(body);
  const code = errorCode(body);
  const retryAfter = bodyRetryAfter(body);
  if (status === 402) {
    const url = buyUrl(body);
    return statusFailure(PROVIDER, {
      status,
      headers,
      class: "quota_exhausted",
      message:
        words ?? "Precleared: today's free checks on your key are used and it has no checks left.",
      hint: `Add checks at ${url} (they never expire), or wait for the daily allowance to reset. Checked emails stay held meanwhile.`,
      details: { buy_url: url },
    });
  }
  if (status === 429 && code === "rate_limited") {
    return statusFailure(PROVIDER, {
      status,
      headers,
      class: "rate_limited",
      ...(retryAfter === null ? {} : { retryAfterSeconds: retryAfter }),
    });
  }
  if (status === 429 && code === "daily_limit") {
    return statusFailure(PROVIDER, {
      status,
      headers,
      class: "quota_exhausted",
      message: words ?? "Precleared: the free daily allowance of checks is used up.",
      hint: `Get a free key at ${GET_KEY_URL} (100 checks a day for 14 days, then 25) and store it with \`${keyCommand}\` or PRECLEARED_API_KEY in .env; otherwise checks resume when the allowance resets.`,
      ...(retryAfter === null ? {} : { retryAfterSeconds: retryAfter }),
      details: { get_key_url: GET_KEY_URL },
    });
  }
  if (status === 400) {
    return statusFailure(PROVIDER, {
      status,
      headers,
      class: "bad_request",
      ...(words ? { message: `Precleared rejected the request: ${words}` } : {}),
    });
  }
  return statusFailure(PROVIDER, { status, headers, body });
}

/** Response body -> EmailCheckResult. Only a JSON object with a known verdict is an answer. */
export function mapPreclearedCheck(body: unknown): EmailCheckResult {
  const record = asRecord(body);
  if (!record) throw malformed("Precleared", "precleared", "empty body");
  const verdict = asString(record.verdict);
  if (!verdict || !(EMAIL_CHECK_VERDICTS as readonly string[]).includes(verdict)) {
    throw malformed("Precleared", "precleared", "no known verdict");
  }
  const reasons = Array.isArray(record.reasons) ? record.reasons : [];
  const first = asRecord(reasons[0]);
  const sourceTitle = asString(first?.source_title);
  const sourceUrl = asString(first?.source_url);
  const facts = asRecord(record.facts);
  return {
    verdict: verdict as EmailCheckVerdict,
    confidence: asNumber(record.confidence),
    reason: asString(first?.text) ?? asString(first?.note),
    source: sourceTitle || sourceUrl ? { title: sourceTitle, url: sourceUrl } : null,
    next_step: asString(record.next_step),
    footer_text: asString(record.footer_text),
    receipt_id: asString(asRecord(record.receipt)?.id),
    recipient_country: countryCode(facts?.recipient_country),
    creditsUsed: 1,
    raw: { rule_key: asString(first?.rule_key), usage: record.usage ?? null },
  };
}

export function createPrecleared(options: PreclearedOptions): ComplianceProvider {
  const base = options.config.base_url.replace(/\/+$/, "");
  const url = `${base}/api/v1/check?src=${SOURCE_TAG}`;
  const wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  const call = async (input: EmailCheckInput) => {
    const response = await requestJson(options.fetch, {
      ...PROVIDER,
      url,
      method: "POST",
      headers,
      body: checkPayload(input),
      timeoutMs: options.config.timeout_seconds * 1000,
      // Documented error answers are classified here, with Precleared's own words.
      answerStatuses: [400, 401, 402, 429],
      ...(input.signal ? { signal: input.signal } : {}),
      // A 200 uses one check of the allowance: a lost answer is not repeated by itself.
      paid: true,
    });
    if (response.status !== 200) {
      throw preclearedFailure(response.status, response.body, response.headers);
    }
    return mapPreclearedCheck(response.body);
  };

  return {
    id: "precleared",

    async checkEmail(input: EmailCheckInput): Promise<EmailCheckResult> {
      try {
        return await call(input);
      } catch (error) {
        // A short rate limit is waited out once; a longer one is left to the caller's retry.
        const seconds = retryAfterOf(error);
        if (failureOf(error)?.class !== "rate_limited" || seconds === undefined) throw error;
        if (seconds > MAX_RATE_LIMIT_WAIT_S) throw error;
        try {
          await wait(seconds * 1000, input.signal);
        } catch {
          throw error; // The caller stopped waiting: the rate limit stands as the answer.
        }
        return call(input);
      }
    },
  };
}

export const preclearedProvider = defineProvider({
  slot: "compliance",
  id: "precleared",
  name: "Precleared",
  description:
    "Cold email legality check per recipient (UK PECR and GDPR, US CAN-SPAM, CASL, UWG, CPCE, Spam Act and more) with a live register lookup and a signed receipt. 10 checks a day without a key; a free key gives 100 a day for 14 days, then 25.",
  docsUrl: "https://precleared.dev/docs/integrate",
  configSchema: preclearedConfigSchema,
  secrets: [
    {
      key: "api_key",
      label: "API key",
      env: "PRECLEARED_API_KEY",
      required: false,
      description: `Optional: without one, Precleared allows 10 checks a day per network. Free keys: ${GET_KEY_URL}`,
    },
  ],
  create: ({ config, secrets, ctx }) =>
    createPrecleared({ apiKey: secrets.api_key ?? "", config, fetch: ctx.fetch }),
});
