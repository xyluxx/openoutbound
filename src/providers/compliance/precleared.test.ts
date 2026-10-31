import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import { failureOf } from "../../core/failures.js";
import { createFakeFetch, type FakeRequest, type FetchRoute } from "../../testing/fake-fetch.js";
import type { EmailCheckInput } from "../types.js";
import { providers } from "./index.js";
import {
  buyUrl,
  checkPayload,
  createPrecleared,
  GET_KEY_URL,
  MAX_RATE_LIMIT_WAIT_S,
  preclearedConfigSchema,
  preclearedProvider,
} from "./precleared.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const KEY = "pc_live_compliance_test_key_321";
const CHECK = /^https:\/\/precleared\.dev\/api\/v1\/check\?src=openoutbound$/;

const INPUT: EmailCheckInput = {
  email: "dana@harbor-dental.example.com",
  sender_country: "GB",
  address_source: "published",
  company_name: "Harbor Dental Ltd",
  recipient_name: "Dana Reyes",
  recipient_country: "GB",
};

async function caught(promise: Promise<unknown>): Promise<OpenOutboundError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenOutboundError);
    return error as OpenOutboundError;
  }
  throw new Error("expected the call to fail");
}

function setup(
  responses: FetchRoute["response"] | FetchRoute["response"][],
  options: { apiKey?: string; wait?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
) {
  const calls: FakeRequest[] = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  // One answer per call, in order; the last one repeats.
  const fetch = createFakeFetch(
    [
      {
        match: CHECK,
        response: (request) => {
          const next = queue.length > 1 ? (queue.shift() as FetchRoute["response"]) : queue[0];
          if (next === undefined) throw new Error("no fake answer left");
          return typeof next === "function" ? next(request) : next;
        },
      },
    ],
    calls,
  ) as unknown as typeof globalThis.fetch;
  const provider = createPrecleared({
    apiKey: options.apiKey ?? "",
    config: preclearedConfigSchema.parse({}),
    fetch,
    ...(options.wait ? { wait: options.wait } : {}),
  });
  return { provider, calls };
}

function sentBody(call: FakeRequest | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body ?? "{}")) as Record<string, unknown>;
}

function sentHeaders(call: FakeRequest | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries((call?.init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
}

describe("precleared", () => {
  it("posts the check with the source tag and user agent, and maps ok_to_email", async () => {
    const { provider, calls } = setup({ json: fixture("precleared-ok") });
    const result = await provider.checkEmail(INPUT);
    expect(result).toMatchObject({
      verdict: "ok_to_email",
      confidence: 0.92,
      reason: expect.stringContaining("corporate subscriber"),
      source: {
        title: "PECR regulation 22",
        url: "https://www.legislation.gov.uk/uksi/2003/2426/regulation/22",
      },
      next_step: null,
      footer_text: expect.stringContaining("opt out"),
      receipt_id: "rcpt_01k6a3v0q8x3m2n4p5r6s7t8ok",
      recipient_country: "GB",
      creditsUsed: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    const headers = sentHeaders(calls[0]);
    expect(headers["user-agent"]).toMatch(
      /^OpenOutboundBot\/.* \(\+https:\/\/github\.com\/xyluxx\/openoutbound\)$/,
    );
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBeUndefined();
    expect(sentBody(calls[0])).toEqual({
      recipient_email: "dana@harbor-dental.example.com",
      sender_country: "GB",
      address_source: "published",
      company_name: "Harbor Dental Ltd",
      recipient_name: "Dana Reyes",
      recipient_country: "GB",
    });
  });

  it("sends the key as a bearer token and never the default country next to a known one", async () => {
    const { provider, calls } = setup({ json: fixture("precleared-ok") }, { apiKey: KEY });
    await provider.checkEmail({
      ...INPUT,
      recipient_country: null,
      default_recipient_country: "gb",
      company_number: " 01234567 ",
      existing_customer: false,
      pitch: "  Front desk   scheduling software ",
    });
    expect(sentHeaders(calls[0]).authorization).toBe(`Bearer ${KEY}`);
    expect(sentBody(calls[0])).toMatchObject({
      default_recipient_country: "GB",
      company_number: "01234567",
      pitch: "Front desk scheduling software",
    });
    expect(sentBody(calls[0])).not.toHaveProperty("recipient_country");
    expect(sentBody(calls[0])).not.toHaveProperty("existing_customer");
  });

  it("maps consent_needed with its rule and next step, and unknown with its note", async () => {
    const consent = setup({ json: fixture("precleared-consent-needed") });
    expect(await consent.provider.checkEmail(INPUT)).toMatchObject({
      verdict: "consent_needed",
      reason: expect.stringContaining("sole trader"),
      next_step: expect.stringContaining("Companies House number"),
      receipt_id: "rcpt_01k6a3v0q8x3m2n4p5r6s7t8cn",
    });
    const unknown = setup({ json: fixture("precleared-unknown") });
    expect(await unknown.provider.checkEmail(INPUT)).toMatchObject({
      verdict: "unknown",
      reason: expect.stringContaining("nothing at Companies House"),
      source: null,
      next_step: expect.stringContaining("company number"),
    });
  });

  it("cuts names to the limits and drops a country that is not a code", () => {
    const payload = checkPayload({
      ...INPUT,
      company_name: `${"A".repeat(200)} Ltd`,
      recipient_name: "   ",
      recipient_country: "United Kingdom",
      default_recipient_country: "GB",
    });
    expect((payload.company_name as string).length).toBe(160);
    expect(payload).not.toHaveProperty("recipient_name");
    expect(payload).not.toHaveProperty("recipient_country");
    expect(payload.default_recipient_country).toBe("GB");
  });

  it("holds a rejected key as an auth failure without printing the key", async () => {
    const { provider } = setup(
      { status: 401, json: { error: "invalid_key", message: `Key ${KEY} is not valid` } },
      { apiKey: KEY },
    );
    const error = await caught(provider.checkEmail(INPUT));
    expect(failureOf(error)).toMatchObject({ class: "auth_invalid", retryable: false });
    expect(error.hint).toContain("providers test --slot compliance --provider precleared");
    expect(JSON.stringify(error.toJSON())).not.toContain(KEY);
  });

  it("passes the operator message and a trusted checkout link on when the key is out of checks", async () => {
    const { provider } = setup(
      { status: 402, json: fixture("precleared-payment-required") },
      { apiKey: KEY },
    );
    const error = await caught(provider.checkEmail(INPUT));
    expect(failureOf(error)).toMatchObject({ class: "quota_exhausted", retryable: false });
    expect(error.message).toContain("no pack left");
    expect(error.hint).toContain("https://precleared.dev/buy?plan=pack");
    expect(error.details).toMatchObject({ buy_url: "https://precleared.dev/buy?plan=pack" });
  });

  it("never follows a checkout link to another host", () => {
    expect(buyUrl({ buy_url: "https://checkout.stripe.com/c/pay/cs_test_example" })).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_example",
    );
    expect(buyUrl({ buy_url: "https://evil.example.com/buy" })).toBe("https://precleared.dev/buy");
    expect(buyUrl({ buy_url: "http://precleared.dev/buy" })).toBe("https://precleared.dev/buy");
    expect(buyUrl({ buy_url: "https://user:pw@precleared.dev/buy" })).toBe(
      "https://precleared.dev/buy",
    );
    expect(buyUrl({})).toBe("https://precleared.dev/buy");
  });

  it("holds the keyless daily limit as a used-up quota with the free key link", async () => {
    const { provider } = setup({
      status: 429,
      headers: { "retry-after": "3600" },
      json: fixture("precleared-daily-limit"),
    });
    const error = await caught(provider.checkEmail(INPUT));
    expect(failureOf(error)).toMatchObject({
      class: "quota_exhausted",
      retryable: false,
      retry_after_s: 3600,
    });
    expect(error.message).toContain("free checks for this network are used");
    expect(error.hint).toContain(GET_KEY_URL);
    expect(error.hint).toContain("PRECLEARED_API_KEY");
  });

  it("waits out a short rate limit once and then answers", async () => {
    const waits: number[] = [];
    const { provider, calls } = setup(
      [
        { status: 429, json: fixture("precleared-rate-limited") },
        { json: fixture("precleared-ok") },
      ],
      {
        wait: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect((await provider.checkEmail(INPUT)).verdict).toBe("ok_to_email");
    expect(waits).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it("leaves a long or repeated rate limit to the caller", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    const long = setup(
      { status: 429, json: { error: "rate_limited", retry_after: MAX_RATE_LIMIT_WAIT_S + 1 } },
      { wait },
    );
    const error = await caught(long.provider.checkEmail(INPUT));
    expect(failureOf(error)).toMatchObject({
      class: "rate_limited",
      retryable: true,
      retry_after_s: MAX_RATE_LIMIT_WAIT_S + 1,
    });
    expect(waits).toEqual([]);
    expect(long.calls).toHaveLength(1);

    const twice = setup({ status: 429, json: fixture("precleared-rate-limited") }, { wait });
    expect(failureOf(await caught(twice.provider.checkEmail(INPUT)))?.class).toBe("rate_limited");
    expect(twice.calls).toHaveLength(2);
  });

  it("stops waiting for a rate limit when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const { provider, calls } = setup(
      { status: 429, json: fixture("precleared-rate-limited") },
      {
        wait: (_ms, signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            controller.abort();
          }),
      },
    );
    const error = await caught(provider.checkEmail({ ...INPUT, signal: controller.signal }));
    expect(failureOf(error)?.class).toBe("rate_limited");
    expect(calls).toHaveLength(1);
  });

  it("reports a bad field as a request problem, not a provider outage", async () => {
    const { provider } = setup({
      status: 400,
      json: { error: "bad_request", operator_message: "sender_country must be GB, US or AE" },
    });
    const error = await caught(provider.checkEmail(INPUT));
    expect(failureOf(error)).toMatchObject({ class: "bad_request", retryable: false });
    expect(error.message).toContain("sender_country must be GB, US or AE");
  });

  it("does not repeat a check whose answer was lost (it may have counted)", async () => {
    const { provider } = setup(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const error = await caught(provider.checkEmail(INPUT));
    expect(failureOf(error)).toMatchObject({ class: "timeout", retryable: false });
  });

  it("treats an answer without a known verdict, or that is not JSON, as malformed", async () => {
    const odd = setup({ json: { verdict: "maybe", receipt: { id: "rcpt_x" } } });
    expect((await caught(odd.provider.checkEmail(INPUT))).details).toMatchObject({
      malformed: true,
    });
    const html = setup({ body: "<html></html>" });
    expect((await caught(html.provider.checkEmail(INPUT))).details).toMatchObject({
      malformed: true,
    });
    const down = setup({ status: 503, body: "" });
    expect(failureOf(await caught(down.provider.checkEmail(INPUT)))).toMatchObject({
      class: "unavailable",
      retryable: true,
    });
  });

  it("is the built-in compliance provider, with an optional key", () => {
    expect(providers.map((provider) => provider.id)).toEqual(["precleared"]);
    expect(preclearedProvider.secrets).toEqual([
      expect.objectContaining({ key: "api_key", env: "PRECLEARED_API_KEY", required: false }),
    ]);
  });
});
