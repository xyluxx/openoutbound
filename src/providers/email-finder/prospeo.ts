/**
 * Prospeo email finder (provider API notes section 10). `POST /enrich-person` with a LinkedIn
 * URL, or a name plus company website or name. Asks for verified emails only and never for
 * mobiles (10 credits each). 1 credit per verified email, free on a miss or when Prospeo
 * enriched the same record in the last 90 days. Error codes come back as HTTP 400 with
 * `{ error: true, error_code }`.
 */
import { z } from "zod";
import { classifyHttpStatus } from "../../core/failures.js";
import {
  asRecord,
  asString,
  malformed,
  reportedFailure,
  requestJson,
} from "../lead-source/http.js";
import {
  defineProvider,
  type EmailFinderProvider,
  type FindEmailInput,
  type FindEmailResult,
} from "../types.js";
import { cleanEmail, inputDomain, nameParts, noMatch } from "./shared.js";

export const prospeoConfigSchema = z.object({
  base_url: z.url({ protocol: /^https?$/ }).default("https://api.prospeo.io"),
});
export type ProspeoConfig = z.output<typeof prospeoConfigSchema>;

const PROVIDER = { provider: "Prospeo", slot: "email_finder", providerId: "prospeo" } as const;

/** Documented error codes that mean "no email for this input": free misses. */
const MISSES: Record<string, string> = {
  NO_MATCH: "not_found",
  INVALID_DATAPOINTS: "missing_input",
};

/**
 * Throws for a Prospeo error code that is not a plain miss (documented codes by name, any
 * other code by its HTTP status). Returns the miss reason otherwise.
 */
export function prospeoError(code: string, status = 400): string {
  const miss = MISSES[code];
  if (miss) return miss;
  const details = { error_code: code.slice(0, 60) };
  if (code === "INVALID_API_KEY") throw reportedFailure(PROVIDER, "auth_invalid", { details });
  if (code === "INSUFFICIENT_CREDITS") {
    throw reportedFailure(PROVIDER, "quota_exhausted", {
      hint: "Top up Prospeo credits, or change the finder order in settings.data.enrichment.finders.",
      details,
    });
  }
  if (code === "RATE_LIMITED" || code === "TOO_MANY_REQUESTS") {
    throw reportedFailure(PROVIDER, "rate_limited", { details });
  }
  if (code === "INVALID_REQUEST") {
    throw reportedFailure(PROVIDER, "bad_request", {
      message: "Prospeo rejected the request (INVALID_REQUEST).",
      details,
    });
  }
  if (code === "INTERNAL_ERROR") {
    throw reportedFailure(PROVIDER, "unavailable", {
      message: "Prospeo had an internal error.",
      details,
    });
  }
  // A code the docs do not list: classify by the status it came with, never as a miss.
  const failureClass = status === 200 ? "malformed" : classifyHttpStatus(status);
  throw reportedFailure(PROVIDER, failureClass, {
    message: `Prospeo answered with error code ${details.error_code}.`,
    upstreamStatus: status,
    details,
  });
}

export interface ProspeoOptions {
  apiKey: string;
  config: ProspeoConfig;
  fetch: typeof fetch;
}

export interface ProspeoInstance extends EmailFinderProvider {
  checkKey(): Promise<void>;
}

export function createProspeo(options: ProspeoOptions): ProspeoInstance {
  const base = options.config.base_url.replace(/\/+$/, "");
  const headers = { "X-KEY": options.apiKey };

  return {
    id: "prospeo",

    async checkKey() {
      const { status, body } = await requestJson(options.fetch, {
        ...PROVIDER,
        url: `${base}/account-information`,
        method: "GET",
        headers,
        answerStatuses: [400],
      });
      if (status === 400) prospeoError(asString(asRecord(body)?.error_code) ?? "UNKNOWN", 400);
    },

    async findEmail(input: FindEmailInput): Promise<FindEmailResult> {
      const names = nameParts(input);
      const domain = inputDomain(input);
      const data: Record<string, string> = {};
      if (input.linkedin_url) data.linkedin_url = input.linkedin_url;
      if (names.first && names.last) {
        data.first_name = names.first;
        data.last_name = names.last;
      } else if (names.full) {
        data.full_name = names.full;
      }
      if (domain) data.company_website = domain;
      else if (input.company?.trim()) data.company_name = input.company.trim();
      const hasName = Boolean(data.first_name || data.full_name);
      const hasCompany = Boolean(data.company_website || data.company_name);
      if (!data.linkedin_url && !(hasName && hasCompany)) return noMatch("missing_input");
      const response = await requestJson(options.fetch, {
        ...PROVIDER,
        url: `${base}/enrich-person`,
        method: "POST",
        headers,
        body: { only_verified_email: true, enrich_mobile: false, data },
        answerStatuses: [400, 404],
      });
      const record = asRecord(response.body);
      if (!record) throw malformed("Prospeo", "prospeo", "empty body");
      if (record.error === true || response.status !== 200) {
        const code = asString(record.error_code) ?? `HTTP_${response.status}`;
        return noMatch(prospeoError(code, response.status));
      }
      // A success is `{ error: false, person }`; anything else is not Prospeo's answer.
      const person = asRecord(record.person);
      if (record.error !== false || !person) {
        throw malformed("Prospeo", "prospeo", "no person in the answer");
      }
      const emailInfo = asRecord(person.email);
      const email = emailInfo?.revealed === false ? null : cleanEmail(emailInfo?.email);
      if (!email) return noMatch("not_found");
      const verified = emailInfo?.status === "VERIFIED";
      return {
        email,
        status: verified ? "valid" : "unknown",
        confidence: verified ? 0.95 : 0.5,
        creditsUsed: record.free_enrichment === true ? 0 : 1,
      };
    },
  };
}

export const prospeoProvider = defineProvider({
  slot: "email_finder",
  id: "prospeo",
  name: "Prospeo",
  description:
    "Email finder by LinkedIn URL, or by name and company website. Only verified emails are requested; 1 credit per found email, free on a miss or a repeat within 90 days.",
  docsUrl: "https://prospeo.io/api-docs/enrich-person",
  configSchema: prospeoConfigSchema,
  secrets: [{ key: "api_key", label: "API key", env: "PROSPEO_API_KEY", required: true }],
  create: ({ config, secrets, ctx }) =>
    createProspeo({ apiKey: secrets.api_key ?? "", config, fetch: ctx.fetch }),
  test: async (instance) => {
    try {
      await (instance as ProspeoInstance).checkKey();
      return { ok: true, message: "Prospeo key accepted." };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});
