import { describe, expect, it } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import { providerFailure } from "../../core/failures.js";
import { classifyFailure } from "./accounts.js";

const failure = (
  failureClass: Parameters<typeof providerFailure>[0]["class"],
  details?: Record<string, unknown>,
) =>
  providerFailure({
    provider: "unipile",
    name: "Unipile",
    class: failureClass,
    ...(details ? { details } : {}),
  });

describe("classifyFailure", () => {
  it("reads the LinkedIn slot flags first", () => {
    expect(classifyFailure(failure("refused", { restricted: true }))).toBe("restricted");
    expect(classifyFailure(failure("auth_invalid", { disconnected: true }))).toBe("disconnected");
    expect(classifyFailure(failure("rate_limited"))).toBe("rate_limited");
  });

  it("reads new-shape failures: a session that lost its login is a disconnection", () => {
    const session = providerFailure({
      provider: "unipile",
      class: "auth_invalid",
      scope: "call",
    });
    expect(classifyFailure(session)).toBe("disconnected");
    // The provider key itself was rejected: not this account's fault; actions wait for the fix.
    expect(classifyFailure(failure("auth_invalid"))).toBe("provider_paused");
    const limited = providerFailure({
      provider: "unipile",
      class: "rate_limited",
      retryAfterSeconds: 3600,
    });
    expect(classifyFailure(limited)).toBe("rate_limited");
  });

  it("keeps an action that may have reached LinkedIn apart from a failure", () => {
    expect(classifyFailure(failure("outcome_unknown"))).toBe("unknown");
  });

  it("follows the one retry rule for everything else", () => {
    expect(classifyFailure(failure("timeout"))).toBe("transient");
    expect(classifyFailure(failure("unavailable"))).toBe("transient");
    expect(classifyFailure(failure("bad_request"))).toBe("permanent");
    // A refusal of this one call (scope call) is not a pause of the provider.
    expect(
      classifyFailure(providerFailure({ provider: "unipile", class: "forbidden", scope: "call" })),
    ).toBe("permanent");
    // The provider paused for the workspace, or its quota or access gone: wait for the fix.
    expect(classifyFailure(failure("quota_exhausted"))).toBe("provider_paused");
    expect(classifyFailure(failure("forbidden"))).toBe("provider_paused");
    const paused = providerFailure({
      provider: "unipile",
      class: "auth_invalid",
      details: { paused: true },
    });
    expect(classifyFailure(paused)).toBe("provider_paused");
    // Older errors without a failure: a retryable flag, or none (unknown provider trouble).
    const old = new OpenOutboundError("provider_error", "x", { details: { retryable: false } });
    expect(classifyFailure(old)).toBe("permanent");
    expect(classifyFailure(new OpenOutboundError("provider_error", "x"))).toBe("transient");
    expect(classifyFailure(new OpenOutboundError("validation_failed", "x"))).toBe("permanent");
    expect(classifyFailure(new Error("socket hang up"))).toBe("transient");
  });
});
