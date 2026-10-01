import { describe, expect, it } from "vitest";
import { JobWaitError, OpenOutboundError } from "./errors.js";
import {
  classifyFetchError,
  classifyHttpStatus,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  describeFailure,
  FAILURE_CLASSES,
  failureOf,
  failureSchema,
  isFetchError,
  isRetryable,
  MAX_RETRY_AFTER_S,
  PERMANENT_CODES,
  parseRetryAfter,
  partialOf,
  providerFailure,
  providerSignal,
  retryAfterOf,
} from "./failures.js";

describe("providerFailure", () => {
  it("builds a provider error with the failure in details and keeps the older fields", () => {
    const error = providerFailure({
      provider: "apollo",
      name: "Apollo",
      class: "rate_limited",
      upstreamStatus: 429,
      retryAfterSeconds: 30,
    });
    expect(error.code).toBe("provider_error");
    expect(error.message).toBe("Apollo rate limit reached.");
    expect(error.hint).toMatch(/retried automatically/);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.details).toEqual({
      provider: "apollo",
      reason: "rate_limited",
      retryable: true,
      status: 429,
      failure: {
        class: "rate_limited",
        retryable: true,
        scope: "account",
        provider: "apollo",
        retry_after_s: 30,
        upstream_status: 429,
      },
    });
    expect(error.toJSON().retry_after_seconds).toBe(30);
  });

  it("has a message and a hint for every class, without em dashes", () => {
    for (const failureClass of FAILURE_CLASSES) {
      const error = providerFailure({ provider: "x", name: "X", class: failureClass });
      expect(error.message.length).toBeGreaterThan(5);
      expect(error.hint?.length ?? 0).toBeGreaterThan(5);
      expect(`${error.message} ${error.hint}`).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("never marks an unknown outcome retryable, even when asked", () => {
    const error = providerFailure({ provider: "smtp", class: "outcome_unknown", retryable: true });
    expect(failureOf(error)).toMatchObject({ class: "outcome_unknown", retryable: false });
    expect(isRetryable(error)).toBe(false);
  });

  it("lets a caller override retryable and scope, and keeps extra details", () => {
    const error = providerFailure({
      provider: "apollo",
      class: "unavailable",
      retryable: false,
      scope: "call",
      details: { reason: "server_error", chunk: 2 },
    });
    expect(error.details).toMatchObject({ reason: "server_error", chunk: 2, retryable: false });
    expect(failureOf(error)).toMatchObject({
      class: "unavailable",
      retryable: false,
      scope: "call",
    });
  });

  it("does not let extra details overwrite the failure", () => {
    const error = providerFailure({
      provider: "apollo",
      class: "auth_invalid",
      details: { failure: { class: "timeout" }, retryable: true, provider: "other" },
    });
    expect(error.details).toMatchObject({ provider: "apollo", retryable: false });
    expect(failureOf(error)?.class).toBe("auth_invalid");
  });

  it("cuts long or negative waits", () => {
    expect(
      providerFailure({ provider: "x", class: "rate_limited", retryAfterSeconds: 10 ** 9 })
        .retryAfterSeconds,
    ).toBe(MAX_RETRY_AFTER_S);
    expect(
      providerFailure({ provider: "x", class: "rate_limited", retryAfterSeconds: -5 })
        .retryAfterSeconds,
    ).toBe(0);
  });

  it("can build provider_not_configured errors", () => {
    const error = providerFailure({
      provider: "claude-cli",
      class: "not_found",
      code: "provider_not_configured",
      message: "The claude CLI is not installed.",
    });
    expect(error.code).toBe("provider_not_configured");
    expect(failureOf(error)?.class).toBe("not_found");
    expect(isRetryable(error)).toBe(false);
  });

  it("matches the output schema", () => {
    const error = providerFailure({ provider: "x", class: "timeout" });
    expect(failureSchema.parse(failureOf(error))).toEqual(failureOf(error));
  });
});

describe("failureOf", () => {
  it("returns null for errors that are not provider failures", () => {
    expect(failureOf(new OpenOutboundError("validation_failed", "bad"))).toBeNull();
    expect(failureOf(new Error("boom"))).toBeNull();
    expect(failureOf("text")).toBeNull();
    expect(failureOf(undefined)).toBeNull();
  });

  it("infers the class of older provider errors from their reason", () => {
    const cases: Array<[string, string]> = [
      ["timeout", "timeout"],
      ["network", "network"],
      ["server_error", "unavailable"],
      ["rate_limited", "rate_limited"],
      ["unauthorized", "auth_invalid"],
      ["auth", "auth_invalid"],
      ["payment_required", "quota_exhausted"],
      ["quota", "quota_exhausted"],
      ["malformed_response", "malformed"],
      ["bad_request", "bad_request"],
      ["refusal", "refused"],
      ["robots_disallowed", "refused"],
    ];
    for (const [reason, expected] of cases) {
      const error = new OpenOutboundError("provider_error", "x", {
        details: { provider: "p", reason },
      });
      expect(failureOf(error)?.class, reason).toBe(expected);
    }
  });

  it("falls back to the status, then to the retryable flag", () => {
    const byStatus = new OpenOutboundError("provider_error", "x", {
      details: { reason: "something_new", status: 401 },
    });
    expect(failureOf(byStatus)).toMatchObject({
      class: "auth_invalid",
      retryable: false,
      upstream_status: 401,
    });
    const upstream = new OpenOutboundError("provider_error", "x", {
      details: { upstream_status: 503 },
    });
    expect(failureOf(upstream)).toMatchObject({ class: "unavailable", retryable: true });
    const refusedByFlag = new OpenOutboundError("provider_error", "x", {
      details: { retryable: false },
    });
    expect(failureOf(refusedByFlag)).toMatchObject({ class: "refused", retryable: false });
    const silent = new OpenOutboundError("provider_error", "x");
    expect(failureOf(silent)).toMatchObject({ class: "unavailable", retryable: true });
  });

  it("keeps an explicit retryable flag over the class default", () => {
    const error = new OpenOutboundError("provider_error", "x", {
      details: { reason: "server_error", retryable: false },
    });
    expect(failureOf(error)).toMatchObject({ class: "unavailable", retryable: false });
  });

  it("keeps the provider and the wait of older errors", () => {
    const error = new OpenOutboundError("provider_error", "x", {
      details: { provider: "exa", reason: "rate_limited", retryable: true },
      retryAfterSeconds: 12,
    });
    expect(failureOf(error)).toEqual({
      class: "rate_limited",
      retryable: true,
      scope: "account",
      provider: "exa",
      retry_after_s: 12,
    });
  });

  it("classifies raw fetch errors", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(failureOf(timeout)).toEqual({ class: "timeout", retryable: true, scope: "call" });
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    expect(failureOf(refused)).toEqual({ class: "network", retryable: true, scope: "call" });
    const headers = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
    });
    expect(failureOf(headers)?.class).toBe("timeout");
  });
});

describe("isRetryable", () => {
  it("follows the provider failure", () => {
    expect(isRetryable(providerFailure({ provider: "x", class: "unavailable" }))).toBe(true);
    expect(isRetryable(providerFailure({ provider: "x", class: "auth_invalid" }))).toBe(false);
    expect(isRetryable(providerFailure({ provider: "x", class: "quota_exhausted" }))).toBe(false);
  });

  it("never retries permanent codes, whatever the details say", () => {
    for (const code of PERMANENT_CODES) {
      const error = new OpenOutboundError(code, "x", { details: { retryable: true } });
      expect(isRetryable(error), code).toBe(false);
    }
  });

  it("retries other engine errors unless they say otherwise", () => {
    expect(isRetryable(new OpenOutboundError("conflict", "x"))).toBe(true);
    expect(isRetryable(new OpenOutboundError("internal", "x"))).toBe(true);
    expect(
      isRetryable(new OpenOutboundError("conflict", "x", { details: { retryable: false } })),
    ).toBe(false);
  });

  it("does not treat a wait as a failure to retry", () => {
    expect(isRetryable(new JobWaitError("brain:configured"))).toBe(false);
  });

  it("retries unexpected errors and network errors", () => {
    expect(isRetryable(new Error("boom"))).toBe(true);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("retryAfterOf", () => {
  it("reads the error's wait, then the failure's", () => {
    expect(
      retryAfterOf(providerFailure({ provider: "x", class: "rate_limited", retryAfterSeconds: 9 })),
    ).toBe(9);
    const inFailureOnly = new OpenOutboundError("provider_error", "x", {
      details: {
        failure: { class: "rate_limited", retryable: true, scope: "account", retry_after_s: 4 },
      },
    });
    expect(retryAfterOf(inFailureOnly)).toBe(4);
    expect(retryAfterOf(new Error("x"))).toBeUndefined();
  });
});

describe("classifyHttpStatus", () => {
  it("maps statuses to classes", () => {
    expect(classifyHttpStatus(400)).toBe("bad_request");
    expect(classifyHttpStatus(401)).toBe("auth_invalid");
    expect(classifyHttpStatus(402)).toBe("quota_exhausted");
    expect(classifyHttpStatus(403)).toBe("forbidden");
    expect(classifyHttpStatus(404)).toBe("not_found");
    expect(classifyHttpStatus(408)).toBe("timeout");
    expect(classifyHttpStatus(410)).toBe("not_found");
    expect(classifyHttpStatus(422)).toBe("bad_request");
    expect(classifyHttpStatus(429)).toBe("rate_limited");
    expect(classifyHttpStatus(500)).toBe("unavailable");
    expect(classifyHttpStatus(503)).toBe("unavailable");
    expect(classifyHttpStatus(504)).toBe("timeout");
    expect(classifyHttpStatus(200)).toBe("malformed");
    expect(classifyHttpStatus(302)).toBe("malformed");
  });
});

describe("fetch errors", () => {
  it("tells timeouts from other network errors", () => {
    expect(classifyFetchError(new DOMException("t", "TimeoutError"))).toBe("timeout");
    expect(classifyFetchError(new DOMException("a", "AbortError"))).toBe("timeout");
    expect(classifyFetchError({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(classifyFetchError(new TypeError("fetch failed"))).toBe("network");
  });

  it("only counts network-layer errors", () => {
    expect(isFetchError(new TypeError("fetch failed"))).toBe(true);
    expect(isFetchError(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe(true);
    expect(isFetchError(new TypeError("x is not a function"))).toBe(false);
    expect(isFetchError(new OpenOutboundError("provider_error", "x"))).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");

  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("30", now)).toBe(30);
    expect(parseRetryAfter("1.2", now)).toBe(2);
    expect(parseRetryAfter("Wed, 30 Sep 2026 12:01:00 GMT", now)).toBe(60);
    expect(parseRetryAfter("Wed, 30 Sep 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("ignores missing or unreadable values and cuts long waits", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-3", now)).toBeUndefined();
    expect(parseRetryAfter("999999999", now)).toBe(MAX_RETRY_AFTER_S);
  });
});

describe("providerSignal", () => {
  it("aborts after the timeout", async () => {
    const signal = providerSignal(10);
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe("TimeoutError");
  });

  it("follows the caller's signal", () => {
    const parent = new AbortController();
    const signal = providerSignal(DEFAULT_PROVIDER_TIMEOUT_MS, parent.signal);
    parent.abort(new Error("cancelled"));
    expect(signal.aborted).toBe(true);
  });
});

describe("describeFailure", () => {
  it("summarizes in one line", () => {
    expect(
      describeFailure({
        class: "rate_limited",
        retryable: true,
        scope: "account",
        provider: "apollo",
        upstream_status: 429,
        retry_after_s: 30,
      }),
    ).toBe("apollo: rate_limited (429), retry after 30 s");
    expect(describeFailure({ class: "timeout", retryable: true, scope: "call" })).toBe("timeout");
  });
});

describe("partialOf", () => {
  it("reads the partial result a failure carries", () => {
    const error = providerFailure({
      provider: "apollo",
      class: "rate_limited",
      details: { partial: { items: [{ id: 1 }], credits: 3, resume: { chunk: 2 } } },
    });
    expect(partialOf<{ id: number }>(error)).toEqual({
      items: [{ id: 1 }],
      credits: 3,
      resume: { chunk: 2 },
    });
  });

  it("returns null without one", () => {
    expect(partialOf(providerFailure({ provider: "x", class: "timeout" }))).toBeNull();
    expect(partialOf(new Error("x"))).toBeNull();
    expect(
      partialOf(providerFailure({ provider: "x", class: "timeout", details: { partial: {} } })),
    ).toBeNull();
  });
});
