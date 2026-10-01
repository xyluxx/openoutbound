/**
 * Findymail email finder (provider API notes section 10). Synchronous: `POST
 * /api/search/business-profile` with a LinkedIn URL, or `POST /api/search/name` with a name and
 * domain. Findymail only returns verified addresses and charges 1 credit per found email, so a
 * search whose answer was lost is not repeated automatically. HTTP 423 (subscription paused)
 * is `quota_exhausted`: nothing can be found until the account is active again.
 */
import { z } from "zod";
import {
  asNumber,
  asRecord,
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

export const findymailConfigSchema = z.object({
  base_url: z.url({ protocol: /^https?$/ }).default("https://app.findymail.com"),
});
export type FindymailConfig = z.output<typeof findymailConfigSchema>;

const PROVIDER = { provider: "Findymail", slot: "email_finder", providerId: "findymail" } as const;

export interface FindymailOptions {
  apiKey: string;
  config: FindymailConfig;
  fetch: typeof fetch;
}

export interface FindymailInstance extends EmailFinderProvider {
  credits(): Promise<number | null>;
}

export function createFindymail(options: FindymailOptions): FindymailInstance {
  const base = options.config.base_url.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${options.apiKey}` };

  return {
    id: "findymail",

    async credits() {
      const { body } = await requestJson(options.fetch, {
        ...PROVIDER,
        url: `${base}/api/credits`,
        method: "GET",
        headers,
      });
      return asNumber(asRecord(body)?.credits);
    },

    async findEmail(input: FindEmailInput): Promise<FindEmailResult> {
      const names = nameParts(input);
      const domain = inputDomain(input);
      let path: string;
      let body: Record<string, unknown>;
      if (input.linkedin_url) {
        path = "/api/search/business-profile";
        body = { linkedin_url: input.linkedin_url };
      } else if (names.full && domain) {
        path = "/api/search/name";
        body = { name: names.full, domain };
      } else {
        return noMatch("missing_input");
      }
      const response = await requestJson(options.fetch, {
        ...PROVIDER,
        url: `${base}${path}`,
        method: "POST",
        headers,
        body,
        answerStatuses: [404, 423],
        paid: true,
      });
      if (response.status === 423) {
        throw reportedFailure(PROVIDER, "quota_exhausted", {
          message: "Findymail subscription is paused.",
          hint: "Resume the Findymail subscription, or change the finder order in settings.data.enrichment.finders.",
          upstreamStatus: 423,
          details: { status: 423 },
        });
      }
      if (response.status === 404) return noMatch("not_found");
      const record = asRecord(response.body);
      if (!record || !("contact" in record)) {
        throw malformed("Findymail", "findymail", "no contact field");
      }
      const email = cleanEmail(asRecord(record.contact)?.email);
      if (!email) return noMatch("not_found");
      // Findymail only returns addresses it verified.
      return { email, status: "valid", confidence: 0.95, creditsUsed: 1 };
    },
  };
}

export const findymailProvider = defineProvider({
  slot: "email_finder",
  id: "findymail",
  name: "Findymail",
  description:
    "Email finder by LinkedIn URL or by name and company domain. Returns only verified addresses; 1 credit per found email, misses are free.",
  docsUrl: "https://app.findymail.com/docs/",
  configSchema: findymailConfigSchema,
  secrets: [{ key: "api_key", label: "API key", env: "FINDYMAIL_API_KEY", required: true }],
  create: ({ config, secrets, ctx }) =>
    createFindymail({ apiKey: secrets.api_key ?? "", config, fetch: ctx.fetch }),
  test: async (instance) => {
    try {
      const credits = await (instance as FindymailInstance).credits();
      if (credits === 0) {
        return { ok: false, message: "Findymail key works, but no credits are left." };
      }
      return {
        ok: true,
        message:
          credits === null
            ? "Findymail key accepted."
            : `Findymail key works (${credits} credits left).`,
      };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});
