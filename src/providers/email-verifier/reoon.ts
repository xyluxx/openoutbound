/**
 * Reoon single-email verification (provider API notes section 11).
 * `GET /api/v1/verify?email=<email>&key=<key>&mode=power`. Power mode does a real SMTP check
 * with catch-all and inbox-full detection (can take up to a minute); quick mode only checks
 * syntax, MX and disposable domains. 1 credit per verification; unknown results are free.
 * The key travels in the query string, so request URLs are never logged or put in messages.
 */
import { z } from "zod";
import { classifyHttpStatus, type FailureClass } from "../../core/failures.js";
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

export const reoonConfigSchema = z.object({
  base_url: z.url({ protocol: /^https?$/ }).default("https://emailverifier.reoon.com/api/v1"),
  mode: z
    .enum(["power", "quick"])
    .default("power")
    .describe("power = SMTP inbox check (recommended); quick = syntax, MX and disposable only"),
});
export type ReoonConfig = z.output<typeof reoonConfigSchema>;

const PROVIDER = { provider: "Reoon", slot: "email_verifier", providerId: "reoon" } as const;
const POWER: Record<string, EmailStatus> = {
  safe: "valid",
  role_account: "valid",
  invalid: "invalid",
  disabled: "invalid",
  disposable: "invalid",
  spamtrap: "invalid",
  inbox_full: "risky",
  catch_all: "catch_all",
  unknown: "unknown",
};

// Quick mode never confirms the inbox, so "valid" there stays "unknown".
const QUICK: Record<string, EmailStatus> = {
  valid: "unknown",
  invalid: "invalid",
  disposable: "invalid",
  spamtrap: "invalid",
};

/** Reoon error reasons (`{ status: "error", reason }`) with a known meaning. */
const ERRORS: Record<string, FailureClass> = {
  invalid_api_key: "auth_invalid",
  api_key_not_found: "auth_invalid",
  not_enough_credits: "quota_exhausted",
  insufficient_credits: "quota_exhausted",
  insufficient_balance: "quota_exhausted",
  you_do_not_have_enough_credits: "quota_exhausted",
};

/**
 * Reoon's error envelope. A reason with a known meaning gives its class; any other reason is
 * classified by the HTTP status it came with (an error inside a 200 counts as `unavailable`).
 */
function throwForError(reason: string, httpStatus: number): never {
  const failureClass =
    documentedErrorClass(reason, ERRORS) ??
    (httpStatus >= 400 ? classifyHttpStatus(httpStatus) : "unavailable");
  throw reportedFailure(PROVIDER, failureClass, {
    ...(failureClass === "unavailable" ? { message: "Reoon failed." } : {}),
    upstream: reason.replace(/\s+/g, " ").trim().slice(0, 200),
    ...(httpStatus >= 400 ? { upstreamStatus: httpStatus } : {}),
  });
}

/** Response body -> VerifyEmailResult. */
export function mapReoon(email: string, body: unknown, httpStatus = 200): VerifyEmailResult {
  const record = asRecord(body);
  if (!record) throw malformed("Reoon", "reoon", "empty body");
  const status = asString(record.status);
  if (status === "error") throwForError(asString(record.reason) ?? "unknown error", httpStatus);
  const table = record.verification_mode === "quick" ? QUICK : POWER;
  const mapped = status ? table[status] : undefined;
  if (!mapped) throw malformed("Reoon", "reoon", "unknown status");
  return {
    email,
    status: mapped,
    reason: status ?? undefined,
    creditsUsed: status === "unknown" ? 0 : 1,
    raw: {
      status,
      mode: asString(record.verification_mode),
      role: record.is_role_account === true || status === "role_account",
      score: asNumber(record.overall_score),
    },
  };
}

export interface ReoonOptions {
  apiKey: string;
  config: ReoonConfig;
  fetch: typeof fetch;
}

export interface ReoonInstance extends EmailVerifierProvider {
  balance(): Promise<{ daily: number | null; instant: number | null }>;
}

export function createReoon(options: ReoonOptions): ReoonInstance {
  const base = options.config.base_url.replace(/\/+$/, "");

  return {
    id: "reoon",

    async balance() {
      const params = new URLSearchParams({ key: options.apiKey });
      const { body } = await requestJson(options.fetch, {
        ...PROVIDER,
        url: `${base}/check-account-balance/?${params.toString()}`,
        method: "GET",
      });
      const record = asRecord(body);
      if (asString(record?.status) === "error") {
        throwForError(asString(record?.reason) ?? "unknown error", 200);
      }
      return {
        daily: asNumber(record?.remaining_daily_credits),
        instant: asNumber(record?.remaining_instant_credits),
      };
    },

    async verify(email: string): Promise<VerifyEmailResult> {
      const params = new URLSearchParams({ email, key: options.apiKey, mode: options.config.mode });
      const { body, status } = await requestJson(options.fetch, {
        ...PROVIDER,
        url: `${base}/verify?${params.toString()}`,
        method: "GET",
        // Power mode can take more than a minute on slow mail servers.
        timeoutMs: options.config.mode === "power" ? 90_000 : 15_000,
        answerStatuses: [400],
        // Each finished verification costs a credit: a lost answer may have been charged.
        paid: true,
      });
      return mapReoon(email, body, status);
    },
  };
}

export const reoonProvider = defineProvider({
  slot: "email_verifier",
  id: "reoon",
  name: "Reoon Email Verifier",
  description:
    "Email verification with a real SMTP check in power mode (valid, invalid, catch-all, inbox full, role account). 1 credit per verification; unknown results are free.",
  docsUrl: "https://www.reoon.com/articles/api-documentation-of-reoon-email-verifier/",
  configSchema: reoonConfigSchema,
  secrets: [{ key: "api_key", label: "API key", env: "REOON_API_KEY", required: true }],
  create: ({ config, secrets, ctx }) =>
    createReoon({ apiKey: secrets.api_key ?? "", config, fetch: ctx.fetch }),
  test: async (instance) => {
    try {
      const balance = await (instance as ReoonInstance).balance();
      const credits = (balance.daily ?? 0) + (balance.instant ?? 0);
      const known = balance.daily !== null && balance.daily !== undefined;
      if (credits === 0 && (known || (balance.instant !== null && balance.instant !== undefined))) {
        return { ok: false, message: "Reoon key works, but no credits are left." };
      }
      return { ok: true, message: `Reoon key works (${credits} credits left).` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});
