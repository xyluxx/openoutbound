import { describe, expect, it } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import { providerFailure } from "../../core/failures.js";
import {
  classifySendError,
  enhancedStatus,
  isDeliveryUncertain,
  senderRejection,
  sendPhase,
} from "./send-errors.js";

const smtp = (responseCode: number, response: string, code = "EENVELOPE") => ({
  code,
  responseCode,
  response: `${responseCode} ${response}`,
});

describe("classifySendError", () => {
  it.each([
    [smtp(535, "5.7.8 Username and Password not accepted", "EAUTH"), "auth"],
    [{ code: "EAUTH", message: "Invalid login" }, "auth"],
    [smtp(550, "5.1.1 The email account that you tried to reach does not exist"), "recipient"],
    [smtp(550, "Requested action not taken: mailbox unavailable, user unknown"), "recipient"],
    [smtp(550, "5.7.26 Unauthenticated email from brand.example.com is not accepted"), "blocked"],
    [smtp(421, "4.7.0 Try again later, closing connection."), "throttled"],
    [smtp(451, "4.7.1 Please try again later, rate limited"), "throttled"],
    [smtp(452, "4.5.3 Too many recipients, slow down"), "throttled"],
    [smtp(452, "4.2.2 The email account that you tried to reach is over quota"), "temporary"],
    [smtp(550, "5.7.1 Daily user sending quota exceeded"), "throttled"],
    [smtp(554, "5.4.5 Daily sending limit exceeded"), "throttled"],
    [smtp(450, "4.2.1 Mailbox busy, try later"), "temporary"],
    [{ code: "ETIMEDOUT", message: "Connection timeout" }, "temporary"],
    [smtp(554, "5.7.1 Message rejected due to content"), "permanent"],
    [{ code: "ETLS", message: "unable to verify the first certificate" }, "config"],
  ])("classifies %o as %s", (error, kind) => {
    expect(classifySendError(error).kind).toBe(kind);
  });

  it("keeps the enhanced status and a short message", () => {
    const failure = classifySendError(smtp(550, `5.1.1 ${"x".repeat(500)}`));
    expect(failure.status).toBe("5.1.1");
    expect(failure.responseCode).toBe(550);
    expect(failure.message.length).toBeLessThanOrEqual(300);
  });

  it.each([
    // Provider blocks: the existing domain pause.
    ["550 5.7.26 Unauthenticated email from brand.example.com is not accepted", "blocked"],
    [
      "550 5.7.515 Access denied, brand.example.com does not meet the required authentication level",
      "blocked",
    ],
    ["421 4.7.28 Our system has detected an unusual rate of unsolicited mail", "blocked"],
    // Rate limits: the mailbox waits until tomorrow.
    ["421 4.7.0 Try again later, closing connection.", "throttled"],
    ["450 4.7.1 Please try again later, rate limited", "throttled"],
    ["550 5.4.5 Daily sending limit exceeded", "throttled"],
    // Reputation, blocklists, policy and other authentication results: a failure on the mailbox.
    [
      "554 5.7.1 Service unavailable; client host [192.0.2.10] blocked using zen.spamhaus.org",
      "rejected",
    ],
    [
      "550 5.7.1 [192.0.2.10] Our system has detected that this message is likely unsolicited mail",
      "rejected",
    ],
    ["550 5.7.606 Access denied, banned sending IP [192.0.2.10]", "rejected"],
    [
      "550 5.7.509 Access denied, sending domain brand.example.com does not pass DMARC verification",
      "rejected",
    ],
    ["550 5.7.1 Message rejected due to local policy", "rejected"],
    ["553 5.1.8 <sam@brand.example.com>: Sender address rejected: Domain not found", "rejected"],
    [
      "554 5.7.1 <dana@harbor.example.com>: Recipient address rejected: Mail appears to be unsolicited",
      "rejected",
    ],
    ["550 Rejected: your IP is listed at bl.example.net", "rejected"],
    // The address or the mailbox itself: counts against the recipient.
    ["550 5.1.1 The email account that you tried to reach does not exist", null],
    ["550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup", null],
    ["550 5.2.1 The email account that you tried to reach is disabled", null],
    ["552 5.2.2 The email account that you tried to reach is over quota", null],
    ["550 5.4.4 Unrouteable address: host or domain name not found", null],
    ["550 5.4.1 Recipient address rejected: Access denied. AS(201806281)", null],
    ["550 5.7.1 <dana@harbor.example.com>: Recipient address rejected: Access denied", null],
    ["550 5.7.133 RESOLVER.RST.SenderNotAuthenticatedForGroup; authentication required", null],
    ["550 Requested action not taken: mailbox unavailable, user unknown", null],
    ["554 4.4.7 Message expired: connection to mx.harbor.example.com timed out", null],
  ])("sends %s to %s", (response, kind) => {
    const code = Number(response.slice(0, 3));
    expect(senderRejection(code, enhancedStatus(response), response)).toBe(kind);
  });

  it("maps engine errors by their reason", () => {
    const auth = new OpenOutboundError("provider_error", "revoked", {
      details: { reason: "auth" },
    });
    expect(classifySendError(auth).kind).toBe("auth");
    const config = new OpenOutboundError("provider_error", "no host", {
      details: { reason: "config" },
    });
    expect(classifySendError(config).kind).toBe("config");
  });

  it("maps provider failures (a token refresh): rejected credentials are a login problem", () => {
    const revoked = providerFailure({ class: "auth_invalid", provider: "google" });
    expect(classifySendError(revoked).kind).toBe("auth");
    const scope = providerFailure({ class: "forbidden", provider: "microsoft" });
    expect(classifySendError(scope).kind).toBe("auth");
    const down = providerFailure({ class: "unavailable", provider: "google", upstreamStatus: 503 });
    expect(classifySendError(down).kind).toBe("temporary");
  });
});

/** A nodemailer error as smtp-connection builds it: code, command and sometimes an answer. */
const nodemailerError = (fields: Record<string, unknown>) =>
  Object.assign(new Error(String(fields.message ?? "SMTP error")), fields);

describe("sendPhase and isDeliveryUncertain", () => {
  it.each([
    // Nothing was handed over: today's handling (retry, bounce, mailbox error) stays safe.
    [
      {
        code: "ESOCKET",
        command: "CONN",
        syscall: "connect",
        message: "connect ECONNREFUSED 192.0.2.1:587",
      },
      "before_data",
      false,
    ],
    [
      { code: "EDNS", command: "CONN", message: "getaddrinfo ENOTFOUND smtp.example.com" },
      "before_data",
      false,
    ],
    [{ code: "ETIMEDOUT", command: "CONN", message: "Connection timeout" }, "before_data", false],
    [
      { code: "ETIMEDOUT", command: "CONN", message: "Greeting never received" },
      "before_data",
      false,
    ],
    [
      { code: "ETLS", command: "CONN", message: "unable to verify the first certificate" },
      "before_data",
      false,
    ],
    [
      { code: "EAUTH", command: "AUTH PLAIN", responseCode: 535, message: "Invalid login" },
      "before_data",
      false,
    ],
    [
      { code: "EENVELOPE", command: "MAIL FROM", responseCode: 553, message: "Sender rejected" },
      "before_data",
      false,
    ],
    [
      { code: "EENVELOPE", command: "RCPT TO", responseCode: 550, message: "No such user" },
      "before_data",
      false,
    ],
    [{ code: "EENVELOPE", command: "API", message: "No recipients defined" }, "before_data", false],
    // The server answered the data with a refusal: it did not take the message.
    [
      { code: "EMESSAGE", command: "DATA", responseCode: 451, message: "Try again later" },
      "data",
      false,
    ],
    [{ code: "EMESSAGE", command: "DATA", responseCode: 554, message: "Rejected" }, "data", false],
    // The message stream broke before its end: the server drops the partial message.
    [{ code: "ESTREAM", command: "API", message: "stream error" }, "before_data", false],
    [{ code: "ESTREAM", message: "stream error" }, "unknown", false],
    // No answer after (or while) handing over the data: it may have gone out.
    [{ code: "ETIMEDOUT", command: "CONN", message: "Timeout" }, "unknown", true],
    [
      { code: "ECONNECTION", command: "CONN", message: "Connection closed unexpectedly" },
      "unknown",
      true,
    ],
    [
      { code: "ESOCKET", command: "CONN", syscall: "read", message: "read ECONNRESET" },
      "unknown",
      true,
    ],
    [{ code: "ETIMEDOUT", command: "DATA", message: "Timeout" }, "data", true],
    [{ message: "something odd" }, "unknown", true],
  ])("reads %o as %s (uncertain: %s)", (fields, phase, uncertain) => {
    const error = nodemailerError(fields);
    expect(sendPhase(error)).toBe(phase);
    expect(isDeliveryUncertain(error)).toBe(uncertain);
  });

  it("treats engine errors (no transport, bad settings) as before the data", () => {
    const error = new OpenOutboundError("provider_error", "no host", {
      details: { reason: "config" },
    });
    expect(sendPhase(error)).toBe("before_data");
    expect(isDeliveryUncertain(error)).toBe(false);
  });

  it("handles values that are not errors", () => {
    expect(isDeliveryUncertain(null)).toBe(true);
    expect(isDeliveryUncertain("boom")).toBe(true);
  });
});
