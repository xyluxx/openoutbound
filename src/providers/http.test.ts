import { afterEach, describe, expect, it } from "vitest";
import { isOpenOutboundError, OpenOutboundError } from "../core/errors.js";
import { failureOf, isRetryable, retryAfterOf } from "../core/failures.js";
import {
  answerFailure,
  type CallKind,
  capProviderTimeouts,
  credentialsOf,
  malformedFailure,
  neverConnected,
  redact,
  requestText,
  sendRequest,
  thrownFailure,
  upstreamMessage,
} from "./http.js";

const APOLLO = { id: "apollo", name: "Apollo" };
const SECRET = "secret-key-123456";

function refused(code = "ECONNREFUSED", syscall = "connect"): TypeError {
  const cause = Object.assign(new Error(`${syscall} ${code} 203.0.113.9:443`), { code, syscall });
  return new TypeError("fetch failed", { cause });
}

function reset(): TypeError {
  const cause = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
    syscall: "read",
  });
  return new TypeError("fetch failed", { cause });
}

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** A fetch that never answers until its signal aborts. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

async function failureFrom(promise: Promise<unknown>): Promise<OpenOutboundError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!isOpenOutboundError(error)) throw new Error(`expected a provider error, got ${error}`);
  return error;
}

afterEach(() => capProviderTimeouts(null));

describe("sendRequest", () => {
  it("always passes an abort signal and ends a request that never answers", async () => {
    capProviderTimeouts(30);
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      signals.push(init?.signal);
      return hangingFetch(input, init);
    };
    const error = await failureFrom(
      sendRequest(fetch, APOLLO, { url: "https://api.example.com/v1/search", timeoutMs: 60_000 }),
    );
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(failureOf(error)).toMatchObject({
      class: "timeout",
      retryable: true,
      provider: "apollo",
    });
    expect(error.message).toBe("Apollo did not answer in time.");
  });

  it("stops when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const pending = sendRequest(hangingFetch, APOLLO, {
      url: "https://api.example.com/v1/search",
      signal: controller.signal,
    });
    controller.abort(new Error("job cancelled"));
    expect(failureOf(await failureFrom(pending))?.class).toBe("timeout");
  });

  it("does not send anything when the caller's signal is already aborted", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response("{}");
    };
    const controller = new AbortController();
    controller.abort();
    const error = await failureFrom(
      sendRequest(fetch, APOLLO, {
        url: "https://api.example.com/x",
        write: true,
        signal: controller.signal,
      }),
    );
    expect(calls).toBe(0);
    // Nothing was handed over, so even a write is a plain timeout, marked as never sent.
    expect(failureOf(error)?.class).toBe("timeout");
    expect(error.details?.not_sent).toBe(true);
  });

  it("returns the answer for any status (the caller decides)", async () => {
    const fetch: typeof globalThis.fetch = async () => new Response("{}", { status: 404 });
    const response = await sendRequest(fetch, APOLLO, { url: "https://api.example.com/x" });
    expect(response.status).toBe(404);
  });
});

describe("requestText", () => {
  it("cuts the request's credentials out of the answer, since providers echo keys", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: `Invalid key ${SECRET} for ?api=${SECRET}` }), {
        status: 401,
      });
    const answer = await requestText(fetch, APOLLO, {
      url: `https://api.example.com/v1/x?api=${SECRET}&email=dana@example.com`,
      headers: { authorization: `Bearer ${SECRET}`, accept: "application/json" },
    });
    expect(answer.text).not.toContain(SECRET);
    expect(answer.text).toContain("[redacted]");
    const error = answerFailure(APOLLO, { status: answer.status, body: answer.text });
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  it("reads an answer whose body broke off by what the call was", async () => {
    // The connection dropped after the status and the first bytes of the body.
    const broken =
      (status: number, headers: Record<string, string> = {}): typeof globalThis.fetch =>
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"id":'));
              const socket = Object.assign(new Error("other side closed"), {
                code: "UND_ERR_SOCKET",
              });
              controller.error(new TypeError("terminated", { cause: socket }));
            },
          }),
          { status, headers },
        );
    const url = "https://api.example.com/v1/notes";
    // A one-time write answered 2xx: something in between may have answered, so it is unknown...
    const lost = await failureFrom(
      requestText(broken(201), APOLLO, { url, method: "POST", write: true }),
    );
    expect(failureOf(lost)).toMatchObject({
      class: "outcome_unknown",
      retryable: false,
      upstream_status: 201,
    });
    // ...unless the provider's id for what it made came in the headers first.
    const kept = await requestText(broken(201, { "x-restli-id": "urn:li:share:1" }), APOLLO, {
      url,
      method: "POST",
      write: true,
      idHeaders: ["x-restli-id"],
    });
    expect(kept).toMatchObject({ ok: true, status: 201, text: "" });
    expect(kept.headers.get("x-restli-id")).toBe("urn:li:share:1");
    // A write that can be repeated counts as done.
    const done = await failureFrom(
      requestText(broken(200), APOLLO, { url, method: "PUT", write: true, idempotent: true }),
    );
    expect(failureOf(done)?.class).toBe("malformed");
    expect(done.details?.accepted).toBe(true);
    // Any other status is read from the status, as if the body were empty.
    const refused = await requestText(broken(502), APOLLO, { url, method: "POST", write: true });
    expect(refused).toMatchObject({ ok: false, status: 502, text: "" });
    // A read is tried again, like any connection that broke.
    const read = await failureFrom(requestText(broken(200), APOLLO, { url }));
    expect(failureOf(read)).toMatchObject({ class: "network", retryable: true });
  });

  it("collects only credential headers and key-like query parameters", () => {
    expect(
      credentialsOf({
        url: "https://api.example.com/v1/?key=abcdefgh123&email=dana@example.com",
        headers: { "X-API-KEY": "xyz-secret-987", "content-type": "application/json" },
      }).sort(),
    ).toEqual(["abcdefgh123", "xyz-secret-987"]);
    expect(redact("a secret-abc-123 b", ["secret-abc-123"])).toBe("a [redacted] b");
  });

  it("collects key-like query parameters from an address that does not parse", () => {
    expect(credentialsOf({ url: "api.example.com/v3/credits?api=mv-key-0123456789" })).toEqual([
      "mv-key-0123456789",
    ]);
  });

  it("collects secrets sent in a form or JSON body", () => {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: "auth-code-0123456789",
      // Stored as a secret with the app's keys, so kept out of messages too.
      client_id: "client-id-0123456789",
      client_secret: "client-secret-0123456789",
      code_verifier: "verifier-0123456789",
    });
    const sent = [
      "auth-code-0123456789",
      "client-id-0123456789",
      "client-secret-0123456789",
      "verifier-0123456789",
    ];
    expect(credentialsOf({ url: "https://www.example.com/token", body: form }).sort()).toEqual(
      sent,
    );
    expect(
      credentialsOf({ url: "https://www.example.com/token", body: form.toString() }).sort(),
    ).toEqual(sent);
    expect(
      credentialsOf({
        url: "https://api.example.com/v1/search",
        body: JSON.stringify({ api_key: "json-key-0123456789", q_keywords: "dental clinics" }),
      }),
    ).toEqual(["json-key-0123456789"]);
  });
});

describe("thrownFailure", () => {
  it("classifies a refused connection as network, for reads and writes alike", () => {
    for (const write of [false, true]) {
      const error = thrownFailure(APOLLO, refused(), { write });
      expect(failureOf(error)).toMatchObject({ class: "network", retryable: true });
      expect(isRetryable(error)).toBe(true);
    }
    expect(neverConnected(refused("ENOTFOUND", "getaddrinfo"))).toBe(true);
  });

  it("makes a write whose answer was lost an outcome_unknown failure", () => {
    for (const lost of [timeoutError(), reset()]) {
      const error = thrownFailure(APOLLO, lost, { write: true });
      expect(failureOf(error)).toMatchObject({ class: "outcome_unknown", retryable: false });
      expect(error.hint).toMatch(/does not repeat it blindly/);
    }
  });

  it("keeps idempotent writes retryable", () => {
    const error = thrownFailure(APOLLO, timeoutError(), { write: true, idempotent: true });
    expect(failureOf(error)).toMatchObject({ class: "timeout", retryable: true });
  });

  it("does not retry a paid call that may have been charged", () => {
    const error = thrownFailure(APOLLO, timeoutError(), { paid: true });
    expect(failureOf(error)).toMatchObject({ class: "timeout", retryable: false });
    expect(error.hint).toMatch(/credits/);
    // A connection that never opened cost nothing.
    expect(failureOf(thrownFailure(APOLLO, refused(), { paid: true }))?.retryable).toBe(true);
  });

  it("keeps the cause so callers can inspect the network error", () => {
    const original = refused();
    const error = thrownFailure(APOLLO, original, {});
    expect(error.cause).toBe(original);
    expect(neverConnected(error.cause)).toBe(true);
  });

  it("turns safe fetch refusals into refused and bad_request, never network", () => {
    const blocked = new OpenOutboundError("forbidden", "Refused to fetch 10.0.0.1.", {
      details: { reason: "blocked_address" },
    });
    const robots = new OpenOutboundError("forbidden", "robots.txt disallows /x.", {
      details: { reason: "robots_disallowed" },
    });
    const invalid = new OpenOutboundError("validation_failed", "Invalid URL.", {
      details: { reason: "invalid_url" },
    });
    expect(failureOf(thrownFailure(APOLLO, blocked, {}))).toMatchObject({
      class: "refused",
      retryable: false,
    });
    expect(failureOf(thrownFailure(APOLLO, robots, {}))?.class).toBe("refused");
    expect(failureOf(thrownFailure(APOLLO, invalid, {}))?.class).toBe("bad_request");
    // The safe fetch repeats the address it refused: the provider error never does.
    const echoed = new OpenOutboundError(
      "validation_failed",
      'Invalid URL "api.example.com/v3/credits?api=mv-key-0123456789".',
      { details: { reason: "invalid_url" } },
    );
    const refusedAddress = thrownFailure(APOLLO, echoed, {
      url: "api.example.com/v3/credits?api=mv-key-0123456789",
    } as CallKind);
    expect(refusedAddress.message).not.toContain("mv-key-0123456789");
    expect(refusedAddress.message).toMatch(/not a valid URL/);
    const slowDown = new OpenOutboundError("provider_error", "slow down", {
      details: { reason: "rate_limited" },
      retryAfterSeconds: 12,
    });
    const limited = thrownFailure(APOLLO, slowDown, { write: true });
    expect(failureOf(limited)).toMatchObject({ class: "rate_limited", retry_after_s: 12 });
  });

  it("reads a safe fetch timeout or broken connection like any other lost answer", () => {
    // Safe fetch classifies its own failures (details.failure) without knowing the call kind.
    const timedOut = new OpenOutboundError("provider_error", "Request to example.com timed out.", {
      details: { reason: "timeout", failure: { class: "timeout", retryable: true, scope: "call" } },
    });
    expect(failureOf(thrownFailure(APOLLO, timedOut, { write: true }))).toMatchObject({
      class: "outcome_unknown",
      retryable: false,
    });
    const neverOpened = new OpenOutboundError("provider_error", "Could not connect.", {
      details: { reason: "network", failure: { class: "network", retryable: true, scope: "call" } },
      cause: refused(),
    });
    expect(failureOf(thrownFailure(APOLLO, neverOpened, { write: true }))).toMatchObject({
      class: "network",
      retryable: true,
    });
  });

  it("passes classified provider errors through", () => {
    const original = new OpenOutboundError("provider_error", "x", {
      details: { failure: { class: "quota_exhausted", retryable: false, scope: "account" } },
    });
    expect(thrownFailure(APOLLO, original, {})).toBe(original);
  });
});

describe("answerFailure", () => {
  it("maps statuses to classes with the provider's message, without secrets or URLs", () => {
    const cases: Array<[number, string, boolean]> = [
      [401, "auth_invalid", false],
      [402, "quota_exhausted", false],
      [403, "forbidden", false],
      [404, "not_found", false],
      [400, "bad_request", false],
      [500, "unavailable", true],
      [503, "unavailable", true],
    ];
    for (const [status, failureClass, retryable] of cases) {
      const error = answerFailure(APOLLO, {
        status,
        body: { error: { message: `Key ${SECRET.slice(0, 3)}... is not valid` } },
      });
      expect(failureOf(error)).toMatchObject({
        class: failureClass,
        retryable,
        upstream_status: status,
      });
      expect(JSON.stringify(error)).not.toContain(SECRET);
    }
  });

  it("reads Retry-After on rate limits", () => {
    const error = answerFailure(APOLLO, {
      status: 429,
      headers: new Headers({ "retry-after": "7" }),
      body: null,
    });
    expect(failureOf(error)).toMatchObject({ class: "rate_limited", retry_after_s: 7 });
    expect(retryAfterOf(error)).toBe(7);
    const quota = answerFailure(APOLLO, {
      status: 402,
      headers: new Headers({ "retry-after": "3600" }),
      body: null,
    });
    expect(failureOf(quota)).toMatchObject({ class: "quota_exhausted", retry_after_s: 3600 });
  });

  it("makes a server error on a write outcome_unknown, unless the write is idempotent", () => {
    expect(failureOf(answerFailure(APOLLO, { status: 502 }, { write: true }))?.class).toBe(
      "outcome_unknown",
    );
    expect(
      failureOf(answerFailure(APOLLO, { status: 502 }, { write: true, idempotent: true }))?.class,
    ).toBe("unavailable");
    // A refusal answered before acting stays a refusal.
    expect(failureOf(answerFailure(APOLLO, { status: 429 }, { write: true }))?.class).toBe(
      "rate_limited",
    );
  });

  it("uses the family's hints and legacy details", () => {
    const error = answerFailure(
      APOLLO,
      { status: 401 },
      {},
      {
        hint: (failureClass) => (failureClass === "auth_invalid" ? "Fix the key." : undefined),
        details: (failureClass) => (failureClass === "auth_invalid" ? { auth: true } : undefined),
      },
    );
    expect(error.hint).toBe("Fix the key.");
    expect(error.details).toMatchObject({ auth: true, provider: "apollo", status: 401 });
  });
});

describe("malformedFailure", () => {
  it("says a write was accepted when its answer cannot be read", () => {
    const read = malformedFailure(APOLLO, "no people array");
    expect(failureOf(read)).toMatchObject({ class: "malformed", retryable: false });
    expect(read.message).toContain("no people array");
    const write = malformedFailure(APOLLO, "no id", { write: true });
    expect(write.message).toMatch(/accepted/);
    expect(write.details).toMatchObject({ accepted: true });
  });
});

describe("upstreamMessage", () => {
  it("reads common error shapes and keeps them short", () => {
    expect(upstreamMessage({ error: "Not enough credits" })).toBe("Not enough credits");
    expect(upstreamMessage({ error: "invalid_request", error_description: "code not found" })).toBe(
      "invalid_request: code not found",
    );
    expect(upstreamMessage({ error: { message: "Bad key" } })).toBe("Bad key");
    expect(upstreamMessage({ errors: [{ details: "missing domain" }] })).toBe("missing domain");
    expect(upstreamMessage({ message: "x".repeat(500) })?.length).toBeLessThanOrEqual(200);
    expect(upstreamMessage("<html><body>Bad gateway</body></html>")).toBeNull();
    expect(upstreamMessage(null)).toBeNull();
  });
});
