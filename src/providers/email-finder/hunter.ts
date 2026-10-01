/**
 * Hunter email finder (provider API notes section 10). `GET /v2/email-finder` with a domain or
 * company plus a name, or a LinkedIn handle. 1 credit per found email, free on a miss, so a
 * search whose answer was lost is not repeated automatically. The key goes in the X-API-KEY
 * header (never the query string, so it stays out of logs). Hunter documents 403 as its rate
 * limit and 429 as the plan's usage limit, so they map to `rate_limited` and `quota_exhausted`.
 */
import { z } from "zod";
import { normalizeLinkedinUrl } from "../../lib/web/extract.js";
import { asNumber, asRecord, asString, malformed, requestJson } from "../lead-source/http.js";
import {
  defineProvider,
  type EmailFinderProvider,
  type EmailStatus,
  type FindEmailInput,
  type FindEmailResult,
} from "../types.js";
import { cleanEmail, inputDomain, nameParts, noMatch } from "./shared.js";

export const hunterConfigSchema = z.object({
  base_url: z.url({ protocol: /^https?$/ }).default("https://api.hunter.io/v2"),
  max_duration_seconds: z.number().int().min(3).max(20).default(10),
});
export type HunterConfig = z.output<typeof hunterConfigSchema>;

const PROVIDER = { provider: "Hunter", slot: "email_finder", providerId: "hunter" } as const;

/** Hunter's documented meaning of 403 and 429 (they differ from the usual one). */
export function hunterErrorAnswer(
  status: number,
): { class: "rate_limited" | "quota_exhausted"; hint?: string } | undefined {
  if (status === 403) return { class: "rate_limited" };
  if (status === 429) {
    return {
      class: "quota_exhausted",
      hint: "The Hunter plan's monthly searches are used up. Upgrade the plan, or change the finder order in settings.data.enrichment.finders.",
    };
  }
  return undefined;
}

/** Hunter verification.status -> EmailStatus. */
export function hunterStatus(value: unknown): EmailStatus {
  switch (value) {
    case "valid":
      return "valid";
    case "invalid":
    case "disposable":
      return "invalid";
    case "accept_all":
      return "catch_all";
    case "webmail":
      return "risky";
    default:
      return "unknown";
  }
}

function linkedinHandle(url: string | null | undefined): string | null {
  const normalized = url ? normalizeLinkedinUrl(url) : null;
  const match = normalized?.match(/\/in\/([^/?#]+)/);
  return match?.[1] ?? null;
}

export interface HunterOptions {
  apiKey: string;
  config: HunterConfig;
  fetch: typeof fetch;
}

export interface HunterInstance extends EmailFinderProvider {
  account(): Promise<{ plan: string | null; searchesLeft: number | null }>;
}

export function createHunter(options: HunterOptions): HunterInstance {
  const base = options.config.base_url.replace(/\/+$/, "");
  const headers = { "X-API-KEY": options.apiKey };

  return {
    id: "hunter",

    async account() {
      const { body } = await requestJson(options.fetch, {
        ...PROVIDER,
        url: `${base}/account`,
        method: "GET",
        headers,
        classify: hunterErrorAnswer,
      });
      const data = asRecord(asRecord(body)?.data);
      const searches = asRecord(asRecord(data?.requests)?.searches);
      const used = asNumber(searches?.used);
      const available = asNumber(searches?.available);
      return {
        plan: asString(data?.plan_name),
        searchesLeft: used !== null && available !== null ? Math.max(0, available - used) : null,
      };
    },

    async findEmail(input: FindEmailInput): Promise<FindEmailResult> {
      const names = nameParts(input);
      const domain = inputDomain(input);
      const handle = linkedinHandle(input.linkedin_url);
      const params = new URLSearchParams();
      if (domain) params.set("domain", domain);
      else if (input.company?.trim()) params.set("company", input.company.trim());
      if (names.first && names.last) {
        params.set("first_name", names.first);
        params.set("last_name", names.last);
      } else if (names.full) {
        params.set("full_name", names.full);
      }
      const hasTarget = params.has("domain") || params.has("company");
      const hasName = params.has("first_name") || params.has("full_name");
      if (!(hasTarget && hasName)) {
        if (!handle) return noMatch("missing_input");
        params.delete("domain");
        params.delete("company");
        params.set("linkedin_handle", handle);
      }
      params.set("max_duration", String(options.config.max_duration_seconds));
      const response = await requestJson(options.fetch, {
        ...PROVIDER,
        url: `${base}/email-finder?${params.toString()}`,
        method: "GET",
        headers,
        // 404: no match; 451: the person asked Hunter to stop processing their data.
        answerStatuses: [404, 451],
        timeoutMs: (options.config.max_duration_seconds + 10) * 1000,
        paid: true,
        classify: hunterErrorAnswer,
      });
      if (response.status === 451) return noMatch("claimed");
      if (response.status === 404) return noMatch("not_found");
      const data = asRecord(asRecord(response.body)?.data);
      if (!data) throw malformed("Hunter", "hunter", "no data object");
      const email = cleanEmail(data.email);
      if (!email) return noMatch("not_found");
      const score = asNumber(data.score);
      return {
        email,
        status: hunterStatus(asRecord(data.verification)?.status),
        ...(score === null ? {} : { confidence: Math.min(1, Math.max(0, score / 100)) }),
        creditsUsed: 1,
      };
    },
  };
}

export const hunterProvider = defineProvider({
  slot: "email_finder",
  id: "hunter",
  name: "Hunter",
  description:
    "Email finder by name and company domain (or LinkedIn handle), with Hunter's own verification status and score. 1 credit per found email, misses are free.",
  docsUrl: "https://hunter.io/api-documentation/v2#email-finder",
  configSchema: hunterConfigSchema,
  secrets: [{ key: "api_key", label: "API key", env: "HUNTER_API_KEY", required: true }],
  create: ({ config, secrets, ctx }) =>
    createHunter({ apiKey: secrets.api_key ?? "", config, fetch: ctx.fetch }),
  test: async (instance) => {
    try {
      const account = await (instance as HunterInstance).account();
      if (account.searchesLeft === 0) {
        const plan = account.plan ? ` (plan ${account.plan})` : "";
        return { ok: false, message: `Hunter key works, but no searches are left${plan}.` };
      }
      const parts = [account.plan ? `plan ${account.plan}` : null];
      if (account.searchesLeft !== null) parts.push(`${account.searchesLeft} searches left`);
      const summary = parts.filter(Boolean).join(", ");
      return {
        ok: true,
        message: summary ? `Hunter key works (${summary}).` : "Hunter key works.",
      };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});
