/**
 * Icypeas email finder (provider API notes section 10). Fully asynchronous: `POST
 * /api/email-search` returns a search id, then `POST /api/bulk-single-searchs/read` is polled
 * until the search reaches a terminal status. 1 credit per found email, free on a miss.
 * Auth is the raw key in the Authorization header (no Bearer prefix).
 *
 * Statuses are read as documented; one the docs do not list is `malformed`, never a miss. Once
 * a search has started, a failure is not retried automatically: a search still running after
 * the last poll is a `timeout`, and a status check that failed keeps its class; both carry
 * `retryable: false` and `details.search_id`, since the search may still find (and charge for)
 * the email and a new one could pay twice.
 */
import { z } from "zod";
import { isOpenOutboundError, OpenOutboundError } from "../../core/errors.js";
import { failureOf } from "../../core/failures.js";
import {
  asArray,
  asRecord,
  asString,
  malformed,
  reportedFailure,
  requestJson,
} from "../lead-source/http.js";
import {
  defineProvider,
  type EmailFinderProvider,
  type EmailStatus,
  type FindEmailInput,
  type FindEmailResult,
} from "../types.js";
import { cleanEmail, inputDomain, nameParts, noMatch } from "./shared.js";

export const icypeasConfigSchema = z.object({
  base_url: z.url({ protocol: /^https?$/ }).default("https://app.icypeas.com/api"),
  poll_interval_ms: z.number().int().min(0).max(30_000).default(3_000),
  max_polls: z.number().int().min(1).max(60).default(20),
});
export type IcypeasConfig = z.output<typeof icypeasConfigSchema>;

const PROVIDER = { provider: "Icypeas", slot: "email_finder", providerId: "icypeas" } as const;
const PENDING = new Set(["NONE", "SCHEDULED", "IN_PROGRESS"]);
const FOUND = new Set(["FOUND", "DEBITED"]);
const NOT_FOUND = new Set(["NOT_FOUND", "DEBITED_NOT_FOUND"]);
const TARGET = { provider: "Icypeas", slot: "email_finder", providerId: "icypeas" };

const CERTAINTY: Record<string, { status: EmailStatus; confidence: number }> = {
  ultra_sure: { status: "valid", confidence: 0.99 },
  very_sure: { status: "valid", confidence: 0.9 },
  sure: { status: "risky", confidence: 0.75 },
  probable: { status: "risky", confidence: 0.5 },
};

/** Best email from a finished search item. */
export function icypeasResult(item: Record<string, unknown>): FindEmailResult {
  const status = asString(item.status) ?? "UNKNOWN";
  if (status === "INSUFFICIENT_FUNDS") {
    throw reportedFailure(TARGET, "quota_exhausted", {
      message: "Icypeas has no credits left.",
      hint: "Top up Icypeas credits, or change the finder order in settings.data.enrichment.finders.",
    });
  }
  if (status === "ABORTED") {
    throw reportedFailure(TARGET, "unavailable", {
      message: "Icypeas aborted the search.",
      hint: "Retry later; the enrichment job retries automatically.",
    });
  }
  if (NOT_FOUND.has(status)) return noMatch("not_found", { status });
  if (status === "BAD_INPUT") return noMatch("bad_input", { status });
  if (!FOUND.has(status))
    throw malformed("Icypeas", "icypeas", `unknown status ${status.slice(0, 40)}`);
  const emails = asArray(asRecord(item.results)?.emails)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      email: cleanEmail(entry.email),
      certainty: asString(entry.certainty) ?? "",
    }))
    .filter((entry): entry is { email: string; certainty: string } => entry.email !== null);
  const ranked = emails.sort(
    (a, b) => (CERTAINTY[b.certainty]?.confidence ?? 0) - (CERTAINTY[a.certainty]?.confidence ?? 0),
  );
  const best = ranked[0];
  if (!best) throw malformed("Icypeas", "icypeas", `status ${status} without an email`);
  const quality = CERTAINTY[best.certainty] ?? { status: "unknown" as const, confidence: 0.3 };
  return {
    email: best.email,
    status: quality.status,
    confidence: quality.confidence,
    creditsUsed: 1,
    raw: { status, certainty: best.certainty },
  };
}

export interface IcypeasOptions {
  apiKey: string;
  config: IcypeasConfig;
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface IcypeasInstance extends EmailFinderProvider {
  checkKey(): Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A failed status check of a started search: the class stays (provider health counts it), but
 * the call is not repeated automatically, since the search may still charge for the email.
 */
function searchStarted(error: unknown, id: string): OpenOutboundError {
  const hint = `Icypeas search ${id} was started and may still find (and charge for) the email, so it is not started again automatically.`;
  const known = failureOf(error);
  if (!isOpenOutboundError(error) || !known) {
    return reportedFailure(TARGET, "unavailable", {
      message: `Checking Icypeas search ${id} failed.`,
      hint,
      retryable: false,
      details: { search_id: id },
      cause: error,
    });
  }
  return new OpenOutboundError(error.code, error.message, {
    hint: `${hint} ${error.hint ?? ""}`.trim(),
    details: {
      ...error.details,
      search_id: id,
      retryable: false,
      failure: { ...known, retryable: false },
    },
    status: error.status,
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
    cause: error,
  });
}

export function createIcypeas(options: IcypeasOptions): IcypeasInstance {
  const base = options.config.base_url.replace(/\/+$/, "");
  const sleep = options.sleep ?? defaultSleep;
  const post = (path: string, body: unknown, answerStatuses?: number[], paid = false) =>
    requestJson(options.fetch, {
      ...PROVIDER,
      url: `${base}${path}`,
      method: "POST",
      headers: { Authorization: options.apiKey },
      body,
      paid,
      ...(answerStatuses ? { answerStatuses } : {}),
    });

  return {
    id: "icypeas",

    async checkKey() {
      await post("/bulk-single-searchs/read", { mode: "single", limit: 1 }, [400, 404]);
    },

    async findEmail(input: FindEmailInput): Promise<FindEmailResult> {
      const names = nameParts(input);
      const target = inputDomain(input) ?? input.company?.trim() ?? null;
      if (!target || (!names.first && !names.last)) return noMatch("missing_input");
      // Charged when the email is found, even if this answer is lost.
      const started = await post(
        "/email-search",
        { firstname: names.first ?? "", lastname: names.last ?? "", domainOrCompany: target },
        undefined,
        true,
      );
      const startRecord = asRecord(started.body);
      if (startRecord?.success === false) return noMatch("bad_input");
      const id = asString(asRecord(startRecord?.item)?._id);
      if (!id) throw malformed("Icypeas", "icypeas", "no search id");
      for (let poll = 0; poll < options.config.max_polls; poll += 1) {
        await sleep(options.config.poll_interval_ms);
        let body: unknown;
        try {
          ({ body } = await post("/bulk-single-searchs/read", { id }));
        } catch (error) {
          throw searchStarted(error, id);
        }
        const item = asRecord(asArray(asRecord(body)?.items)[0]);
        const status = asString(item?.status);
        if (!item || !status || PENDING.has(status)) continue;
        return icypeasResult(item);
      }
      // Still running: it may yet find (and charge for) the email, so never search again blindly.
      throw reportedFailure(TARGET, "timeout", {
        message: `Icypeas did not finish search ${id} in time.`,
        hint: "The enrichment moves on to the next finder. The search was not repeated, since Icypeas may still charge for it.",
        retryable: false,
        details: { search_id: id },
      });
    },
  };
}

export const icypeasProvider = defineProvider({
  slot: "email_finder",
  id: "icypeas",
  name: "Icypeas",
  description:
    "Email finder by name and company domain. Searches run asynchronously and are polled until done (a few seconds). 1 credit per found email; misses are free.",
  docsUrl: "https://api-doc.icypeas.com/",
  configSchema: icypeasConfigSchema,
  secrets: [{ key: "api_key", label: "API key", env: "ICYPEAS_API_KEY", required: true }],
  create: ({ config, secrets, ctx }) =>
    createIcypeas({ apiKey: secrets.api_key ?? "", config, fetch: ctx.fetch }),
  test: async (instance) => {
    try {
      await (instance as IcypeasInstance).checkKey();
      return { ok: true, message: "Icypeas key accepted." };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});
