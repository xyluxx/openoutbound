import { describe, expect, it } from "vitest";
import {
  answeredDespiteFailure,
  callFailure,
  stopsProvider,
  worthRetrying,
} from "./call-failure.js";
import { OpenOutboundError } from "./errors.js";
import { type FailureClass, providerFailure } from "./failures.js";

const failure = (failureClass: FailureClass) =>
  callFailure(providerFailure({ provider: "hunter", class: failureClass }), "hunter");

describe("callFailure", () => {
  it("keeps the failure of a provider error and fills in the provider", () => {
    expect(
      callFailure(
        providerFailure({ provider: "apollo", class: "rate_limited", retryAfterSeconds: 30 }),
        "x",
      ),
    ).toEqual({
      class: "rate_limited",
      retryable: true,
      scope: "account",
      provider: "apollo",
      retry_after_s: 30,
    });
    const legacy = new OpenOutboundError("provider_error", "Hunter failed with HTTP 401", {
      details: { status: 401 },
    });
    expect(callFailure(legacy, "hunter")).toMatchObject({
      class: "auth_invalid",
      provider: "hunter",
    });
  });

  it("records errors that are not provider failures instead of dropping them", () => {
    expect(callFailure(new TypeError("boom"), "icypeas")).toEqual({
      class: "unavailable",
      retryable: true,
      scope: "call",
      provider: "icypeas",
    });
    expect(callFailure(new OpenOutboundError("validation_failed", "bad input"), "icypeas")).toEqual(
      { class: "refused", retryable: false, scope: "call", provider: "icypeas" },
    );
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    expect(callFailure(timeout, "exa")).toMatchObject({ class: "timeout", provider: "exa" });
  });
});

describe("stopsProvider and worthRetrying", () => {
  it("stop asking a provider after an account or provider failure", () => {
    expect(stopsProvider(failure("auth_invalid"))).toBe(true);
    expect(stopsProvider(failure("rate_limited"))).toBe(true);
    expect(stopsProvider(failure("unavailable"))).toBe(true);
    expect(stopsProvider(failure("timeout"))).toBe(false);
    expect(stopsProvider(failure("not_found"))).toBe(false);
  });

  it("charge only a failed call the provider answered", () => {
    expect(answeredDespiteFailure(failure("malformed"))).toBe(true);
    for (const cls of [
      "auth_invalid",
      "forbidden",
      "quota_exhausted",
      "timeout",
      "network",
    ] as const) {
      expect(answeredDespiteFailure(failure(cls))).toBe(false);
    }
  });

  it("retry temporary and account failures, not ones that repeat for this call", () => {
    for (const cls of [
      "timeout",
      "network",
      "unavailable",
      "rate_limited",
      "auth_invalid",
      "forbidden",
      "quota_exhausted",
    ] as const) {
      expect(worthRetrying(failure(cls))).toBe(true);
    }
    for (const cls of [
      "not_found",
      "bad_request",
      "malformed",
      "refused",
      "outcome_unknown",
    ] as const) {
      expect(worthRetrying(failure(cls))).toBe(false);
    }
  });

  it("ask again later after a paid call that lost its answer, which is not repeated by itself", () => {
    for (const cls of ["timeout", "network", "unavailable"] as const) {
      const paid = callFailure(
        providerFailure({ provider: "crustdata", class: cls, scope: "call", retryable: false }),
        "crustdata",
      );
      expect(paid).toMatchObject({ class: cls, retryable: false, scope: "call" });
      expect(worthRetrying(paid)).toBe(true);
    }
  });
});
