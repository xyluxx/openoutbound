import { describe, expect, it } from "vitest";
import { reportError } from "../cli/errors.js";
import { type CliIO, palette } from "../cli/io.js";
import { OpenOutboundError } from "../core/errors.js";
import { providerFailure } from "../core/failures.js";
import { errorPayload, errorText, toolErrorResult } from "./errors.js";

const limited = () =>
  providerFailure({
    provider: "apollo",
    name: "Apollo",
    class: "rate_limited",
    upstreamStatus: 429,
    retryAfterSeconds: 30,
  });

describe("errors at the doors", () => {
  it("keeps the wait in the structured error and the text", () => {
    const result = toolErrorResult(limited());
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: "provider_error",
      retry_after_seconds: 30,
      details: { failure: { class: "rate_limited", retryable: true, retry_after_s: 30 } },
    });
    expect(result.content[0]?.text).toContain("Retry after 30 s.");
  });

  it("reads the wait from the failure when the error itself has none", () => {
    const error = new OpenOutboundError("provider_error", "Hunter is busy.", {
      details: {
        failure: { class: "rate_limited", retryable: true, scope: "account", retry_after_s: 12 },
      },
    });
    expect(errorPayload(error).retry_after_seconds).toBe(12);
  });

  it("says nothing about waiting when there is no wait", () => {
    const payload = errorPayload(new OpenOutboundError("not_found", "No such person."));
    expect(payload).not.toHaveProperty("retry_after_seconds");
    expect(errorText(payload)).toBe("Error (not_found): No such person.");
  });

  it("prints the wait in the CLI", () => {
    const err: string[] = [];
    const out: string[] = [];
    const io: CliIO = {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      stdoutIsTTY: false,
      stderrIsTTY: false,
    };
    reportError(io, limited(), { json: true, palette: palette(false) });
    expect(err.join("")).toContain("retry after 30 s");
    expect(JSON.parse(out.join("")).error.retry_after_seconds).toBe(30);
  });
});
