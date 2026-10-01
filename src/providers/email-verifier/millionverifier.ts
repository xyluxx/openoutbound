/**
 * MillionVerifier single-email verification (provider API notes section 11).
 * `GET /api/v3/?api=<key>&email=<email>&timeout=<s>`. Only good (`ok`) and bad (`invalid`,
 * `disposable`) outcomes cost a credit; `catch_all` and `unknown` are free. The key travels in
 * the query string, so request URLs are never logged or put in messages.
 */
import { z } from "zod";
import type { FailureClass } from "../../core/failures.js";
import {
  asNumber,
  asRecord,
  asString,
  malformed,
  reportedFailure,
  requestJson,
} from "../lead-source/http.js";
import {
  defineProvider,
  type EmailStatus,
  type EmailVerifierProvider,
  type VerifyEmailResult,
} from "../types.js";
import { documentedErrorClass } from "./shared.js";

export const millionVerifierConfigSchema = z.object({
  base_url: z.url({ protocol: /^https?$/ }).default("https://api.millionverifier.com"),
  timeout_seconds: z.number().int().min(2).max(60).default(20),
});
export type MillionVerifierConfig = z.output<typeof millionVerifierConfigSchema>;

const PROVIDER = {
  provider: "MillionVerifier",
  slot: "email_verifier",
  providerId: "millionverifier",
} as const;
const RESULTS: Record<string, { status: EmailStatus; charged: boolean }> = {
  ok: { status: "valid", charged: true },
  invalid: { status: "invalid", charged: true },
  disposable: { status: "invalid", charged: true },
  catch_all: { status: "catch_all", charged: false },
  unknown: { status: "unknown", charged: false },
};

/**
 * Errors MillionVerifier documents in its `error` field (provider API notes section 11: invalid
 * API key, insufficient credits, IP blocked, internal error, missing parameters).
 */
const ERRORS: Record<string, FailureClass> = {
  invalid_api_key: "auth_invalid",
  api_key_invalid: "auth_invalid",
  insufficient_credits: "quota_exhausted",
  ip_blocked: "forbidden",
  ip_address_blocked: "forbidden",
  internal_error: "unavailable",
  missing: "bad_request",
};

/**
 * Errors come back in an `error` field (often with HTTP 200), read by the documented names.
 * An error the docs do not list counts as `unavailable`: retried a few times, then reported.
 */
function throwForError(message: string): never {
  const failureClass = documentedErrorClass(message, ERRORS) ?? "unavailable";
  throw reportedFailure(PROVIDER, failureClass, {
    ...(failureClass === "unavailable" ? { message: "MillionVerifier failed." } : {}),
    upstream: message.replace(/\s+/g, " ").trim().slice(0, 200),
  });
}

/** Response body -> VerifyEmailResult. */
export function mapMillionVerifier(email: string, body: unknown): VerifyEmailResult {
  const record = asRecord(body);
  if (!record) throw malformed("MillionVerifier", "millionverifier", "empty body");
  const error = asString(record.error);
  if (error) throwForError(error);
  const result = asString(record.result);
  const mapped = result ? RESULTS[result] : undefined;
  if (!mapped) throw malformed("MillionVerifier", "millionverifier", "unknown result");
  const subresult = asString(record.subresult);
  return {
    email,
    status: mapped.status,
    reason: subresult && subresult !== result ? `${result}:${subresult}` : (result ?? undefined),
    creditsUsed: mapped.charged ? 1 : 0,
    raw: { result, subresult, role: record.role === true, free: record.free === true },
  };
}

export interface MillionVerifierOptions {
  apiKey: string;
  config: MillionVerifierConfig;
  fetch: typeof fetch;
}

export interface MillionVerifierInstance extends EmailVerifierProvider {
  credits(): Promise<number | null>;
}

export function createMillionVerifier(options: MillionVerifierOptions): MillionVerifierInstance {
  const base = options.config.base_url.replace(/\/+$/, "");

  return {
    id: "millionverifier",

    async credits() {
      const params = new URLSearchParams({ api: options.apiKey });
      const { body } = await requestJson(options.fetch, {
        ...PROVIDER,
        url: `${base}/api/v3/credits?${params.toString()}`,
        method: "GET",
      });
      const error = asString(asRecord(body)?.error);
      if (error) throwForError(error);
      return asNumber(asRecord(body)?.credits);
    },

    async verify(email: string): Promise<VerifyEmailResult> {
      const params = new URLSearchParams({
        api: options.apiKey,
        email,
        timeout: String(options.config.timeout_seconds),
      });
      const { body } = await requestJson(options.fetch, {
        ...PROVIDER,
        url: `${base}/api/v3/?${params.toString()}`,
        method: "GET",
        timeoutMs: (options.config.timeout_seconds + 10) * 1000,
        // Good and bad results are charged: a lost answer may have cost a credit.
        paid: true,
      });
      return mapMillionVerifier(email, body);
    },
  };
}

export const millionVerifierProvider = defineProvider({
  slot: "email_verifier",
  id: "millionverifier",
  name: "MillionVerifier",
  description:
    "Real-time email verification (valid, invalid, catch-all, unknown). 1 credit per good or bad result; catch-all and unknown results are free.",
  docsUrl: "https://developer.millionverifier.com/",
  configSchema: millionVerifierConfigSchema,
  secrets: [{ key: "api_key", label: "API key", env: "MILLIONVERIFIER_API_KEY", required: true }],
  create: ({ config, secrets, ctx }) =>
    createMillionVerifier({ apiKey: secrets.api_key ?? "", config, fetch: ctx.fetch }),
  test: async (instance) => {
    try {
      const credits = await (instance as MillionVerifierInstance).credits();
      if (credits === 0) {
        return { ok: false, message: "MillionVerifier key works, but no credits are left." };
      }
      return {
        ok: true,
        message:
          credits === null
            ? "MillionVerifier key accepted."
            : `MillionVerifier key works (${credits} credits left).`,
      };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});
