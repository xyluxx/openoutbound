import { describe, expect, it } from "vitest";
import { failureOf, isRetryable, retryAfterOf } from "../../core/failures.js";
import { BRAIN_REASON_CLASSES, brainError, mapBrainApiError } from "./errors.js";

const CONTEXT = { label: "Gemini", providerId: "gemini", secrets: ["gemini-test-key-0001"] };

/** An SDK-style API error (Stainless shape: status, headers, error body, message). */
function apiError(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`${status} ${JSON.stringify(body)}`), {
    name: "APIError",
    status,
    headers: new Headers(headers),
    error: body,
  });
}

describe("brainError", () => {
  it("builds a classified failure and keeps the brain reason", () => {
    const error = brainError(CONTEXT, "Bad key.", { reason: "auth", retryable: false });
    expect(failureOf(error)).toMatchObject({ class: "auth_invalid", retryable: false });
    expect(error.details).toMatchObject({ reason: "auth", provider: "gemini" });
    const limit = brainError(CONTEXT, "Plan limit.", {
      reason: "usage_limit",
      retryable: true,
      retryAfterSeconds: 3600,
    });
    expect(failureOf(limit)).toMatchObject({ class: "quota_exhausted", retryable: true });
    expect(retryAfterOf(limit)).toBe(3600);
    expect(BRAIN_REASON_CLASSES.aborted).toBe("timeout");
    expect(isRetryable(brainError(CONTEXT, "x", { reason: "aborted", retryable: false }))).toBe(
      false,
    );
  });

  it("cuts the API key out of messages", () => {
    const error = brainError(CONTEXT, "Key gemini-test-key-0001 is not valid.", {
      reason: "auth",
      retryable: false,
    });
    expect(error.message).not.toContain("gemini-test-key-0001");
  });
});

describe("mapBrainApiError", () => {
  it("reads a Gemini daily quota as quota_exhausted and a per-minute limit as a rate limit", () => {
    const daily = mapBrainApiError(
      CONTEXT,
      apiError(429, [
        {
          error: {
            code: 429,
            message: "You exceeded your current quota.",
            status: "RESOURCE_EXHAUSTED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }],
              },
            ],
          },
        },
      ]),
    );
    expect(failureOf(daily)).toMatchObject({ class: "quota_exhausted", retryable: false });
    expect(retryAfterOf(daily)).toBeGreaterThan(0);
    const minute = mapBrainApiError(
      CONTEXT,
      apiError(429, {
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }],
            },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "33s" },
          ],
        },
      }),
    );
    expect(failureOf(minute)).toMatchObject({ class: "rate_limited", retryable: true });
    expect(retryAfterOf(minute)).toBe(33);
  });

  it("reads 402 as out of credits", () => {
    const error = mapBrainApiError(
      { label: "OpenRouter", providerId: "openrouter" },
      apiError(402, { error: { message: "Insufficient credits." } }),
    );
    expect(failureOf(error)).toMatchObject({ class: "quota_exhausted", retryable: false });
  });

  it("reads an answer the SDK could not parse as malformed, not as a network failure", () => {
    const error = mapBrainApiError(
      CONTEXT,
      new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"),
    );
    expect(failureOf(error)).toMatchObject({ class: "malformed", retryable: false });
    expect(error.details).toMatchObject({ reason: "malformed_response", provider: "gemini" });
    expect(error.hint).toContain("base_url");
  });

  it("keeps connection failures as network failures", () => {
    // SDK error classes that leave `name` as "Error": the class name decides.
    class APIConnectionError extends Error {}
    for (const cause of [
      new APIConnectionError("Connection error."),
      new TypeError("fetch failed"),
    ]) {
      const error = mapBrainApiError(CONTEXT, cause);
      expect(failureOf(error)).toMatchObject({ class: "network", retryable: true });
    }
  });

  it("reads the SDK's abort and timeout classes by class name", () => {
    class APIUserAbortError extends Error {}
    class APIConnectionTimeoutError extends Error {}
    const aborted = mapBrainApiError(CONTEXT, new APIUserAbortError("Request was aborted."));
    expect(aborted.details).toMatchObject({ reason: "aborted" });
    expect(isRetryable(aborted)).toBe(false);
    const late = mapBrainApiError(CONTEXT, new APIConnectionTimeoutError("Request timed out."));
    expect(failureOf(late)).toMatchObject({ class: "timeout", retryable: true });
  });
});
