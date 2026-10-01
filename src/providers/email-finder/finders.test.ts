import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import { failureOf } from "../../core/failures.js";
import { createFakeFetch, type FakeRequest, type FetchRoute } from "../../testing/fake-fetch.js";
import { createFindymail, findymailConfigSchema, findymailProvider } from "./findymail.js";
import { createHunter, hunterConfigSchema, hunterProvider, hunterStatus } from "./hunter.js";
import { createIcypeas, icypeasConfigSchema, icypeasProvider } from "./icypeas.js";
import { providers } from "./index.js";
import { createProspeo, prospeoConfigSchema, prospeoProvider } from "./prospeo.js";
import { nameParts } from "./shared.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const KEY = "finder-test-key-789";

function fakeFetch(routes: FetchRoute[]) {
  const calls: FakeRequest[] = [];
  const fetch = createFakeFetch(routes, calls) as unknown as typeof globalThis.fetch;
  const bodyOf = (index: number) => JSON.parse(String(calls[index]?.init?.body ?? "{}"));
  const headersOf = (index: number) =>
    (calls[index]?.init?.headers ?? {}) as Record<string, string>;
  return { fetch, calls, bodyOf, headersOf };
}

async function caught(promise: Promise<unknown>): Promise<OpenOutboundError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenOutboundError);
    return error as OpenOutboundError;
  }
  throw new Error("expected the call to fail");
}

const DANA = {
  first_name: "Dana",
  last_name: "Rivers",
  domain: "https://www.brightsmile.example.com/",
};

describe("finder helpers", () => {
  it("splits a full name when first or last is missing", () => {
    expect(nameParts({ full_name: "Dana Rivers" })).toEqual({
      first: "Dana",
      last: "Rivers",
      full: "Dana Rivers",
    });
    expect(nameParts({ first_name: "Dana", last_name: "Rivers" }).full).toBe("Dana Rivers");
  });

  it("registers every finder in the slot index", () => {
    expect(providers.map((p) => p.id)).toEqual(["icypeas", "findymail", "hunter", "prospeo"]);
    expect(providers.every((p) => p.secrets[0]?.env?.endsWith("_API_KEY"))).toBe(true);
  });
});

describe("icypeas", () => {
  const SEARCH = "https://app.icypeas.com/api/email-search";
  const READ = "https://app.icypeas.com/api/bulk-single-searchs/read";

  function setup(
    reads: unknown[],
    start: FetchRoute["response"] = { json: fixture("icypeas-search-started") },
  ) {
    let index = 0;
    const net = fakeFetch([
      { match: SEARCH, method: "POST", response: start },
      {
        match: READ,
        method: "POST",
        response: () => ({ json: reads[Math.min(index++, reads.length - 1)] }),
      },
    ]);
    const sleeps: number[] = [];
    const icypeas = createIcypeas({
      apiKey: KEY,
      config: icypeasConfigSchema.parse({ poll_interval_ms: 5, max_polls: 3 }),
      fetch: net.fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    return { ...net, icypeas, sleeps };
  }

  it("starts a search, polls until done and picks the surest address", async () => {
    const { icypeas, bodyOf, headersOf, sleeps } = setup([
      fixture("icypeas-read-pending"),
      fixture("icypeas-read-found"),
    ]);
    const result = await icypeas.findEmail(DANA);
    expect(result).toEqual({
      email: "dana.rivers@brightsmile.example.com",
      status: "valid",
      confidence: 0.99,
      creditsUsed: 1,
      raw: { status: "DEBITED", certainty: "ultra_sure" },
    });
    expect(headersOf(0).Authorization).toBe(KEY);
    expect(bodyOf(0)).toEqual({
      firstname: "Dana",
      lastname: "Rivers",
      domainOrCompany: "brightsmile.example.com",
    });
    expect(bodyOf(1)).toEqual({ id: "p_exampleSearch0001" });
    expect(sleeps).toEqual([5, 5]);
  });

  it("returns a free miss when nothing is found", async () => {
    const { icypeas } = setup([fixture("icypeas-read-not-found")]);
    expect(await icypeas.findEmail(DANA)).toMatchObject({ email: null, creditsUsed: 0 });
  });

  it("gives up after max polls with a timeout that is not retried (no second paid search)", async () => {
    const { icypeas, calls } = setup([fixture("icypeas-read-pending")]);
    const error = await caught(icypeas.findEmail(DANA));
    expect(failureOf(error)).toMatchObject({ class: "timeout", retryable: false });
    expect(error.details).toMatchObject({ search_id: "p_exampleSearch0001" });
    expect(calls.filter((call) => call.url.endsWith("/email-search"))).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it("does not repeat a started search whose status check failed, and keeps the failure's class", async () => {
    const timedOut = () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    };
    for (const [read, failureClass, scope] of [
      [{ status: 429, json: { message: "Too many requests" } }, "rate_limited", "account"],
      [{ status: 503, body: "Service Unavailable" }, "unavailable", "provider"],
      [timedOut, "timeout", "call"],
    ] as const) {
      const net = fakeFetch([
        { match: SEARCH, method: "POST", response: { json: fixture("icypeas-search-started") } },
        { match: READ, method: "POST", response: read },
      ]);
      const icypeas = createIcypeas({
        apiKey: KEY,
        config: icypeasConfigSchema.parse({ poll_interval_ms: 5, max_polls: 3 }),
        fetch: net.fetch,
        sleep: async () => {},
      });
      const error = await caught(icypeas.findEmail(DANA));
      // The search may still find (and charge for) the email: never started again by itself.
      expect(failureOf(error)).toMatchObject({ class: failureClass, retryable: false, scope });
      expect(error.details).toMatchObject({ search_id: "p_exampleSearch0001", retryable: false });
      expect(error.hint).toContain("p_exampleSearch0001");
      expect(net.calls.filter((call) => call.url === SEARCH)).toHaveLength(1);
    }
  });

  it("reads statuses it does not know, or a found status without an email, as malformed", async () => {
    const odd = setup([{ items: [{ status: "SOMETHING_NEW", _id: "p_x" }] }]);
    expect(failureOf(await caught(odd.icypeas.findEmail(DANA)))?.class).toBe("malformed");
    const empty = setup([{ items: [{ status: "FOUND", _id: "p_x", results: { emails: [] } }] }]);
    expect(failureOf(await caught(empty.icypeas.findEmail(DANA)))?.class).toBe("malformed");
    const aborted = setup([{ items: [{ status: "ABORTED", _id: "p_x" }] }]);
    expect(failureOf(await caught(aborted.icypeas.findEmail(DANA)))).toMatchObject({
      class: "unavailable",
      retryable: true,
    });
  });

  it("skips the call when there is no domain or company", async () => {
    const { icypeas, calls } = setup([]);
    expect(await icypeas.findEmail({ first_name: "Dana" })).toMatchObject({
      email: null,
      raw: { reason: "missing_input" },
    });
    expect(calls).toHaveLength(0);
  });

  it("treats validation errors as bad input and funds errors as insufficient credits", async () => {
    const invalid = setup([], { json: fixture("icypeas-validation-error") });
    expect(await invalid.icypeas.findEmail(DANA)).toMatchObject({ raw: { reason: "bad_input" } });
    const broke = setup([{ items: [{ status: "INSUFFICIENT_FUNDS", _id: "p_x" }] }]);
    const error = await caught(broke.icypeas.findEmail(DANA));
    expect(error.details).toMatchObject({ provider: "icypeas", insufficient_credits: true });
    expect(failureOf(error)?.class).toBe("quota_exhausted");
  });

  it("rejects a start response without a search id as malformed", async () => {
    const { icypeas } = setup([], { json: { success: true, item: {} } });
    const error = await caught(icypeas.findEmail(DANA));
    expect(error.details).toMatchObject({ malformed: true });
  });

  it("reports a bad key from the provider test", async () => {
    const { icypeas } = setup([], { status: 401, json: { message: "Unauthorized" } });
    const net = fakeFetch([
      { match: READ, response: { status: 401, json: { message: "Unauthorized" } } },
    ]);
    const instance = createIcypeas({
      apiKey: KEY,
      config: icypeasConfigSchema.parse({}),
      fetch: net.fetch,
    });
    const result = await icypeasProvider.test?.(instance);
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("rejected the API key");
    expect(icypeas.id).toBe("icypeas");
  });
});

describe("findymail", () => {
  const NAME = "https://app.findymail.com/api/search/name";
  const PROFILE = "https://app.findymail.com/api/search/business-profile";

  function setup(routes: FetchRoute[]) {
    const net = fakeFetch(routes);
    const findymail = createFindymail({
      apiKey: KEY,
      config: findymailConfigSchema.parse({}),
      fetch: net.fetch,
    });
    return { ...net, findymail };
  }

  it("finds by name and domain with a bearer key", async () => {
    const { findymail, bodyOf, headersOf } = setup([
      { match: NAME, response: { json: fixture("findymail-found") } },
    ]);
    expect(await findymail.findEmail(DANA)).toEqual({
      email: "dana@brightsmile.example.com",
      status: "valid",
      confidence: 0.95,
      creditsUsed: 1,
    });
    expect(headersOf(0).Authorization).toBe(`Bearer ${KEY}`);
    expect(bodyOf(0)).toEqual({ name: "Dana Rivers", domain: "brightsmile.example.com" });
  });

  it("prefers the LinkedIn profile lookup", async () => {
    const { findymail, bodyOf } = setup([
      { match: PROFILE, response: { json: fixture("findymail-found") } },
    ]);
    await findymail.findEmail({
      ...DANA,
      linkedin_url: "https://www.linkedin.com/in/dana-rivers-example",
    });
    expect(bodyOf(0)).toEqual({ linkedin_url: "https://www.linkedin.com/in/dana-rivers-example" });
  });

  it("returns a free miss for an empty contact or a 404", async () => {
    const empty = setup([{ match: NAME, response: { json: fixture("findymail-not-found") } }]);
    expect(await empty.findymail.findEmail(DANA)).toMatchObject({ email: null, creditsUsed: 0 });
    const missing = setup([
      { match: NAME, response: { status: 404, json: { error: "Not found" } } },
    ]);
    expect(await missing.findymail.findEmail(DANA)).toMatchObject({ email: null, creditsUsed: 0 });
  });

  it("maps 402 and 423 to actionable errors", async () => {
    const broke = setup([
      { match: NAME, response: { status: 402, json: fixture("findymail-no-credits") } },
    ]);
    const credits = await caught(broke.findymail.findEmail(DANA));
    expect(credits.details).toMatchObject({ insufficient_credits: true });
    expect(credits.message).toContain("Not enough credits");
    const paused = setup([
      { match: NAME, response: { status: 423, json: { error: "Subscription is paused" } } },
    ]);
    const error = await caught(paused.findymail.findEmail(DANA));
    expect(error.hint).toContain("Resume the Findymail subscription");
    expect(failureOf(error)).toMatchObject({ class: "quota_exhausted", retryable: false });
    const odd = setup([{ match: NAME, response: { json: { unexpected: true } } }]);
    expect(failureOf(await caught(odd.findymail.findEmail(DANA)))?.class).toBe("malformed");
  });

  it("tests the key through the credits endpoint", async () => {
    const { findymail } = setup([
      { match: "https://app.findymail.com/api/credits", response: { json: { credits: 42 } } },
    ]);
    expect(await findymailProvider.test?.(findymail)).toEqual({
      ok: true,
      message: "Findymail key works (42 credits left).",
    });
    // A key with nothing left does not work for finding: the test says so (and lifts no pause).
    const empty = setup([
      { match: "https://app.findymail.com/api/credits", response: { json: { credits: 0 } } },
    ]);
    expect(await findymailProvider.test?.(empty.findymail)).toEqual({
      ok: false,
      message: "Findymail key works, but no credits are left.",
    });
  });
});

describe("hunter", () => {
  const FINDER = /^https:\/\/api\.hunter\.io\/v2\/email-finder\?/;

  function setup(routes: FetchRoute[]) {
    const net = fakeFetch(routes);
    const hunter = createHunter({
      apiKey: KEY,
      config: hunterConfigSchema.parse({}),
      fetch: net.fetch,
    });
    return { ...net, hunter };
  }

  it("finds with the key in a header, never in the URL", async () => {
    const { hunter, calls, headersOf } = setup([
      { match: FINDER, response: { json: fixture("hunter-found") } },
    ]);
    expect(await hunter.findEmail(DANA)).toEqual({
      email: "dana@brightsmile.example.com",
      status: "catch_all",
      confidence: 0.91,
      creditsUsed: 1,
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      domain: "brightsmile.example.com",
      first_name: "Dana",
      last_name: "Rivers",
      max_duration: "10",
    });
    expect(calls[0]?.url).not.toContain(KEY);
    expect(headersOf(0)["X-API-KEY"]).toBe(KEY);
  });

  it("falls back to the LinkedIn handle without a company", async () => {
    const { hunter, calls } = setup([
      { match: FINDER, response: { json: fixture("hunter-found") } },
    ]);
    await hunter.findEmail({ linkedin_url: "linkedin.com/in/dana-rivers-example/" });
    expect(new URL(calls[0]?.url ?? "").searchParams.get("linkedin_handle")).toBe(
      "dana-rivers-example",
    );
  });

  it("returns free misses for no email, 404 and 451", async () => {
    const none = setup([{ match: FINDER, response: { json: fixture("hunter-not-found") } }]);
    expect(await none.hunter.findEmail(DANA)).toMatchObject({ email: null, creditsUsed: 0 });
    const claimed = setup([{ match: FINDER, response: { status: 451, json: {} } }]);
    expect(await claimed.hunter.findEmail(DANA)).toMatchObject({ raw: { reason: "claimed" } });
  });

  it("surfaces Hunter error details", async () => {
    const { hunter } = setup([
      { match: FINDER, response: { status: 400, json: fixture("hunter-error") } },
    ]);
    const error = await caught(hunter.findEmail(DANA));
    expect(error.message).toContain("You are missing the domain parameter");
    const broken = setup([{ match: FINDER, response: { json: { meta: {} } } }]);
    expect((await caught(broken.hunter.findEmail(DANA))).details).toMatchObject({
      malformed: true,
    });
  });

  it("reads 403 as Hunter's rate limit and 429 as its usage limit, as documented", async () => {
    const limited = setup([
      { match: FINDER, response: { status: 403, json: fixture("hunter-error") } },
    ]);
    expect(failureOf(await caught(limited.hunter.findEmail(DANA)))?.class).toBe("rate_limited");
    const used = setup([
      { match: FINDER, response: { status: 429, json: fixture("hunter-error") } },
    ]);
    const error = await caught(used.hunter.findEmail(DANA));
    expect(failureOf(error)?.class).toBe("quota_exhausted");
    expect(error.details).toMatchObject({ insufficient_credits: true });
  });

  it("maps verification statuses and tests the key via the account endpoint", async () => {
    expect(hunterStatus("valid")).toBe("valid");
    expect(hunterStatus("disposable")).toBe("invalid");
    expect(hunterStatus("webmail")).toBe("risky");
    expect(hunterStatus(null)).toBe("unknown");
    const { hunter } = setup([
      { match: "https://api.hunter.io/v2/account", response: { json: fixture("hunter-account") } },
    ]);
    expect((await hunterProvider.test?.(hunter))?.message).toBe(
      "Hunter key works (plan Starter, 380 searches left).",
    );
    const usedUp = setup([
      {
        match: "https://api.hunter.io/v2/account",
        response: {
          json: {
            data: { plan_name: "Starter", requests: { searches: { used: 500, available: 500 } } },
          },
        },
      },
    ]);
    expect(await hunterProvider.test?.(usedUp.hunter)).toEqual({
      ok: false,
      message: "Hunter key works, but no searches are left (plan Starter).",
    });
  });
});

describe("prospeo", () => {
  const ENRICH = "https://api.prospeo.io/enrich-person";

  function setup(routes: FetchRoute[]) {
    const net = fakeFetch(routes);
    const prospeo = createProspeo({
      apiKey: KEY,
      config: prospeoConfigSchema.parse({}),
      fetch: net.fetch,
    });
    return { ...net, prospeo };
  }

  it("asks for verified emails only and never mobiles", async () => {
    const { prospeo, bodyOf, headersOf } = setup([
      { match: ENRICH, response: { json: fixture("prospeo-found") } },
    ]);
    expect(await prospeo.findEmail(DANA)).toEqual({
      email: "dana.rivers@brightsmile.example.com",
      status: "valid",
      confidence: 0.95,
      creditsUsed: 1,
    });
    expect(headersOf(0)["X-KEY"]).toBe(KEY);
    expect(bodyOf(0)).toEqual({
      only_verified_email: true,
      enrich_mobile: false,
      data: { first_name: "Dana", last_name: "Rivers", company_website: "brightsmile.example.com" },
    });
  });

  it("ignores masked addresses and treats NO_MATCH as a free miss", async () => {
    const masked = setup([{ match: ENRICH, response: { json: fixture("prospeo-masked") } }]);
    expect(
      await masked.prospeo.findEmail({ linkedin_url: "https://www.linkedin.com/in/marco" }),
    ).toMatchObject({
      email: null,
      creditsUsed: 0,
    });
    const none = setup([
      { match: ENRICH, response: { status: 400, json: fixture("prospeo-no-match") } },
    ]);
    expect(await none.prospeo.findEmail(DANA)).toMatchObject({
      email: null,
      raw: { reason: "not_found" },
    });
  });

  it("maps key and credit error codes", async () => {
    const badKey = setup([
      {
        match: ENRICH,
        response: { status: 400, json: { error: true, error_code: "INVALID_API_KEY" } },
      },
    ]);
    const auth = await caught(badKey.prospeo.findEmail(DANA));
    expect(auth.details).toMatchObject({ auth: true });
    expect(auth.hint).toContain("providers test --slot email_finder --provider prospeo");
    const broke = setup([
      {
        match: ENRICH,
        response: { status: 400, json: { error: true, error_code: "INSUFFICIENT_CREDITS" } },
      },
    ]);
    expect((await caught(broke.prospeo.findEmail(DANA))).details).toMatchObject({
      insufficient_credits: true,
    });
  });

  it("classifies every documented error code, and unknown codes by status", async () => {
    const answer = (status: number, code: string) =>
      setup([{ match: ENRICH, response: { status, json: { error: true, error_code: code } } }]);
    expect(await answer(400, "INVALID_DATAPOINTS").prospeo.findEmail(DANA)).toMatchObject({
      email: null,
      raw: { reason: "missing_input" },
    });
    const cases: Array<[number, string, string]> = [
      [400, "INVALID_REQUEST", "bad_request"],
      [400, "INTERNAL_ERROR", "unavailable"],
      [400, "RATE_LIMITED", "rate_limited"],
      [400, "SOMETHING_NEW", "bad_request"],
      [500, "SOMETHING_NEW", "unavailable"],
    ];
    for (const [status, code, failureClass] of cases) {
      const error = await caught(answer(status, code).prospeo.findEmail(DANA));
      expect(failureOf(error)?.class, code).toBe(failureClass);
    }
  });

  it("needs a company or LinkedIn URL before spending a call", async () => {
    const { prospeo, calls } = setup([]);
    expect(await prospeo.findEmail({ full_name: "Dana Rivers" })).toMatchObject({
      raw: { reason: "missing_input" },
    });
    expect(calls).toHaveLength(0);
    const check = setup([
      { match: "https://api.prospeo.io/account-information", response: { json: { error: false } } },
    ]);
    expect(await prospeoProvider.test?.(check.prospeo)).toMatchObject({ ok: true });
  });
});
