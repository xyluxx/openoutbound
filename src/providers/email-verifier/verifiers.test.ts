import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import { failureOf } from "../../core/failures.js";
import { createFakeFetch, type FakeRequest, type FetchRoute } from "../../testing/fake-fetch.js";
import { providers } from "./index.js";
import {
  createMillionVerifier,
  millionVerifierConfigSchema,
  millionVerifierProvider,
} from "./millionverifier.js";
import { createReoon, reoonConfigSchema, reoonProvider } from "./reoon.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const KEY = "verifier-test-key-321";

async function caught(promise: Promise<unknown>): Promise<OpenOutboundError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenOutboundError);
    return error as OpenOutboundError;
  }
  throw new Error("expected the call to fail");
}

describe("millionverifier", () => {
  const VERIFY = /^https:\/\/api\.millionverifier\.com\/api\/v3\/\?/;

  function setup(response: FetchRoute["response"], match: string | RegExp = VERIFY) {
    const calls: FakeRequest[] = [];
    const fetch = createFakeFetch(
      [{ match, response }],
      calls,
    ) as unknown as typeof globalThis.fetch;
    const verifier = createMillionVerifier({
      apiKey: KEY,
      config: millionVerifierConfigSchema.parse({}),
      fetch,
    });
    return { verifier, calls };
  }

  it("maps ok to valid and charges a credit", async () => {
    const { verifier, calls } = setup({ json: fixture("millionverifier-ok") });
    const result = await verifier.verify("dana@brightsmile.example.com");
    expect(result).toMatchObject({
      email: "dana@brightsmile.example.com",
      status: "valid",
      reason: "ok",
      creditsUsed: 1,
    });
    const params = new URL(calls[0]?.url ?? "").searchParams;
    expect(params.get("email")).toBe("dana@brightsmile.example.com");
    expect(params.get("timeout")).toBe("20");
  });

  it("does not charge for catch-all and keeps the sub-result", async () => {
    const { verifier } = setup({ json: fixture("millionverifier-catch-all") });
    expect(await verifier.verify("info@northgate.example.org")).toMatchObject({
      status: "catch_all",
      creditsUsed: 0,
      raw: { role: true },
    });
    const invalid = setup({ json: fixture("millionverifier-invalid") });
    expect(await invalid.verifier.verify("bademail@gmal.example.com")).toMatchObject({
      status: "invalid",
      reason: "invalid:unknown",
      creditsUsed: 1,
    });
  });

  it("turns the error field into an auth error without the key", async () => {
    const { verifier } = setup({ json: fixture("millionverifier-error") });
    const error = await caught(verifier.verify("dana@brightsmile.example.com"));
    expect(error.details).toMatchObject({ provider: "millionverifier", auth: true });
    expect(JSON.stringify(error.toJSON())).not.toContain(KEY);
  });

  it("reads the documented error names, not words inside them", async () => {
    const cases: Array<[string, string]> = [
      ["Invalid API key", "auth_invalid"],
      ["Insufficient credits", "quota_exhausted"],
      ["IP blocked", "forbidden"],
      ["Internal error", "unavailable"],
      ["Missing parameter: email", "bad_request"],
      // Mentions a key, but is not the documented key error.
      ["Temporary key rotation in progress", "unavailable"],
    ];
    for (const [message, failureClass] of cases) {
      const { verifier } = setup({ json: { error: message } });
      const error = await caught(verifier.verify("a@example.com"));
      expect(failureOf(error)?.class, message).toBe(failureClass);
    }
  });

  it("does not retry a verification whose answer was lost (it may have cost a credit)", async () => {
    const { verifier } = setup(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const error = await caught(verifier.verify("a@example.com"));
    expect(failureOf(error)).toMatchObject({ class: "timeout", retryable: false });
  });

  it("rejects unknown results and non-JSON as malformed", async () => {
    const odd = setup({ json: { result: "maybe" } });
    expect((await caught(odd.verifier.verify("a@example.com"))).details).toMatchObject({
      malformed: true,
    });
    const html = setup({ body: "<html></html>" });
    expect((await caught(html.verifier.verify("a@example.com"))).details).toMatchObject({
      malformed: true,
    });
  });

  it("maps HTTP 429 to a rate limit and tests the key with the credits call", async () => {
    const limited = setup({ status: 429, headers: { "retry-after": "5" }, json: {} });
    const error = await caught(limited.verifier.verify("a@example.com"));
    expect(error.retryAfterSeconds).toBe(5);
    const credits = setup({ json: { credits: 1234 } }, /\/api\/v3\/credits\?/);
    expect(await millionVerifierProvider.test?.(credits.verifier)).toEqual({
      ok: true,
      message: "MillionVerifier key works (1234 credits left).",
    });
    const empty = setup({ json: { credits: 0 } }, /\/api\/v3\/credits\?/);
    expect(await millionVerifierProvider.test?.(empty.verifier)).toEqual({
      ok: false,
      message: "MillionVerifier key works, but no credits are left.",
    });
  });
});

describe("reoon", () => {
  const VERIFY = /^https:\/\/emailverifier\.reoon\.com\/api\/v1\/verify\?/;

  function setup(
    response: FetchRoute["response"],
    mode: "power" | "quick" = "power",
    match: RegExp = VERIFY,
  ) {
    const calls: FakeRequest[] = [];
    const fetch = createFakeFetch(
      [{ match, response }],
      calls,
    ) as unknown as typeof globalThis.fetch;
    const verifier = createReoon({ apiKey: KEY, config: reoonConfigSchema.parse({ mode }), fetch });
    return { verifier, calls };
  }

  it("maps power-mode safe to valid", async () => {
    const { verifier, calls } = setup({ json: fixture("reoon-safe") });
    expect(await verifier.verify("dana@brightsmile.example.com")).toMatchObject({
      status: "valid",
      reason: "safe",
      creditsUsed: 1,
      raw: { mode: "power", role: false, score: 98 },
    });
    expect(new URL(calls[0]?.url ?? "").searchParams.get("mode")).toBe("power");
  });

  it("maps catch-all, inbox full and role accounts", async () => {
    const catchAll = setup({ json: fixture("reoon-catch-all") });
    expect(await catchAll.verifier.verify("hello@northgate.example.org")).toMatchObject({
      status: "catch_all",
      raw: { role: true },
    });
    const full = setup({ json: { status: "inbox_full", verification_mode: "power" } });
    expect((await full.verifier.verify("a@example.com")).status).toBe("risky");
    const role = setup({ json: { status: "role_account", verification_mode: "power" } });
    expect(await role.verifier.verify("info@example.com")).toMatchObject({
      status: "valid",
      raw: { role: true },
    });
    const unknown = setup({ json: { status: "unknown", verification_mode: "power" } });
    expect((await unknown.verifier.verify("a@example.com")).creditsUsed).toBe(0);
  });

  it("never treats a quick-mode valid as verified", async () => {
    const { verifier } = setup({ json: fixture("reoon-quick-valid") }, "quick");
    expect((await verifier.verify("dana@brightsmile.example.com")).status).toBe("unknown");
  });

  it("maps the error shape to an auth error and odd statuses to malformed", async () => {
    const { verifier } = setup({ status: 400, json: fixture("reoon-error") });
    const error = await caught(verifier.verify("a@example.com"));
    expect(error.details).toMatchObject({ provider: "reoon", auth: true });
    expect(error.hint).toContain("providers test --slot email_verifier --provider reoon");
    const odd = setup({ json: { status: "sparkly" } });
    expect((await caught(odd.verifier.verify("a@example.com"))).details).toMatchObject({
      malformed: true,
    });
  });

  it("classifies reasons it does not know by the HTTP status", async () => {
    const credits = setup({
      status: 400,
      json: { status: "error", reason: "Not enough credits." },
    });
    expect(failureOf(await caught(credits.verifier.verify("a@example.com")))?.class).toBe(
      "quota_exhausted",
    );
    const unknown400 = setup({
      status: 400,
      json: { status: "error", reason: "Email is required" },
    });
    expect(failureOf(await caught(unknown400.verifier.verify("a@example.com")))?.class).toBe(
      "bad_request",
    );
    const unknown200 = setup({ json: { status: "error", reason: "Something went wrong" } });
    expect(failureOf(await caught(unknown200.verifier.verify("a@example.com")))?.class).toBe(
      "unavailable",
    );
  });

  it("tests the key with the balance call", async () => {
    const { verifier } = setup(
      {
        json: {
          api_status: "active",
          remaining_daily_credits: 20,
          remaining_instant_credits: 100,
          status: "success",
        },
      },
      "power",
      /check-account-balance/,
    );
    expect(await reoonProvider.test?.(verifier)).toEqual({
      ok: true,
      message: "Reoon key works (120 credits left).",
    });
    const empty = setup(
      {
        json: {
          api_status: "active",
          remaining_daily_credits: 0,
          remaining_instant_credits: 0,
          status: "success",
        },
      },
      "power",
      /check-account-balance/,
    );
    expect(await reoonProvider.test?.(empty.verifier)).toEqual({
      ok: false,
      message: "Reoon key works, but no credits are left.",
    });
    expect(providers.map((p) => p.id)).toEqual(["millionverifier", "reoon"]);
  });
});
