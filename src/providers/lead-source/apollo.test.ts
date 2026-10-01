import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import { failureOf, partialOf } from "../../core/failures.js";
import { createFakeFetch, type FakeRequest } from "../../testing/fake-fetch.js";
import type { PersonCandidate } from "../types.js";
import {
  apolloProvider,
  createApollo,
  mapApolloMatch,
  mapApolloOrganization,
  peopleSearchBody,
} from "./apollo.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const API = "https://api.apollo.io/api/v1";
const KEY = "apollo-test-key-123";

function setup(routes: Parameters<typeof createFakeFetch>[0] = []) {
  const calls: FakeRequest[] = [];
  const fetch = createFakeFetch(routes, calls) as unknown as typeof globalThis.fetch;
  const apollo = createApollo({ apiKey: KEY, fetch });
  const bodyOf = (index: number) => JSON.parse(String(calls[index]?.init?.body ?? "{}"));
  const headersOf = (index: number) =>
    (calls[index]?.init?.headers ?? {}) as Record<string, string>;
  return { apollo, calls, bodyOf, headersOf };
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

describe("apollo people search", () => {
  it("maps masked people for free and pages by number", async () => {
    const { apollo, calls, bodyOf, headersOf } = setup([
      {
        match: `${API}/mixed_people/api_search`,
        response: { json: fixture("apollo-people-search") },
      },
    ]);
    const page = await apollo.searchPeople?.(
      {
        titles: ["owner"],
        countries: ["US"],
        keywords: ["dental"],
        employee_range: { min: 5, max: 50 },
      },
      { limit: 2, cursor: "1" },
    );
    expect(page?.creditsUsed).toBe(0);
    expect(page?.total).toBe(3);
    expect(page?.nextCursor).toBe("2");
    expect(page?.items).toHaveLength(2);
    expect(page?.items[0]).toMatchObject({
      external_id: "64a1f0c2e5b7a10001a1b2c3",
      first_name: "Dana",
      last_name: null,
      full_name: "Dana Ri***s",
      title: "Practice Owner",
      company: { name: "Brightsmile Dental Studio" },
      raw: { has_email: true },
    });
    expect(calls[0]?.method).toBe("POST");
    expect(headersOf(0)["x-api-key"]).toBe(KEY);
    expect(bodyOf(0)).toMatchObject({
      page: 1,
      per_page: 2,
      person_titles: ["owner"],
      include_similar_titles: true,
      person_locations: ["United States"],
      q_keywords: "dental",
      organization_num_employees_ranges: ["5,50"],
    });
  });

  it("stops paging on the last page", async () => {
    const { apollo } = setup([
      {
        match: `${API}/mixed_people/api_search`,
        response: { json: fixture("apollo-people-search") },
      },
    ]);
    const page = await apollo.searchPeople?.({ query: "dentist" }, { limit: 25, cursor: "1" });
    expect(page?.nextCursor).toBeNull();
  });

  it("uses a free-text place before country names", () => {
    const body = peopleSearchBody(
      { location: { text: "Austin, TX" }, countries: ["US"], company_domains: ["example.com"] },
      1,
      10,
    );
    expect(body.person_locations).toEqual(["Austin, TX"]);
    expect(body.q_organization_domains_list).toEqual(["example.com"]);
  });

  it("treats a body without a people array as malformed", async () => {
    const { apollo } = setup([
      { match: `${API}/mixed_people/api_search`, response: { json: { total_entries: 0 } } },
    ]);
    const error = await caught(apollo.searchPeople?.({}, { limit: 5 }) as Promise<unknown>);
    expect(error.code).toBe("provider_error");
    expect(error.details).toMatchObject({ provider: "apollo", malformed: true });
  });

  it("treats a non-JSON success body as malformed", async () => {
    const { apollo } = setup([
      { match: `${API}/mixed_people/api_search`, response: { body: "<html>maintenance</html>" } },
    ]);
    const error = await caught(apollo.searchPeople?.({}, { limit: 5 }) as Promise<unknown>);
    expect(error.details).toMatchObject({ malformed: true });
  });
});

describe("apollo organization search", () => {
  it("maps companies, charges one credit per page and pages", async () => {
    const { apollo, bodyOf } = setup([
      { match: `${API}/mixed_companies/search`, response: { json: fixture("apollo-org-search") } },
    ]);
    const page = await apollo.searchCompanies?.(
      { query: "dental clinic", location: { text: "Austin" } },
      { limit: 2 },
    );
    expect(page?.creditsUsed).toBe(1);
    expect(page?.nextCursor).toBe("2");
    expect(page?.items).toHaveLength(2);
    expect(page?.items[0]).toMatchObject({
      external_id: "615d029256de500001bdb460",
      name: "Brightsmile Dental Studio",
      domain: "brightsmile.example.com",
      website: "http://www.brightsmile.example.com",
      linkedin_url: "https://www.linkedin.com/company/brightsmile-dental-example",
      phone: "+15125550101",
      employee_count: 24,
      country: "United States",
      technologies: ["WordPress", "Google Analytics"],
      source: "apollo",
    });
    expect(page?.items[1]?.domain).toBe("northgate.example.org");
    expect(bodyOf(0)).toMatchObject({
      q_organization_keyword_tags: ["dental clinic"],
      organization_locations: ["Austin"],
    });
  });

  it("drops organizations without a name", () => {
    expect(mapApolloOrganization({ id: "x" })).toBeNull();
    expect(mapApolloOrganization(null)).toBeNull();
  });
});

describe("apollo enrichment", () => {
  it("matches by id in chunks of ten and drops locked placeholder emails", async () => {
    const matches = fixture("apollo-bulk-match") as Record<string, unknown>;
    const { apollo, calls, bodyOf } = setup([
      {
        match: `${API}/people/bulk_match`,
        response: (request) => {
          const details = JSON.parse(String(request.init?.body)).details as unknown[];
          if (details.length === 10) {
            return {
              json: { status: "success", credits_consumed: 0, matches: details.map(() => null) },
            };
          }
          return { json: matches };
        },
      },
    ]);
    const filler: PersonCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      external_id: `64a1f0c2e5b7a10001a1b3${String(i).padStart(2, "0")}`,
      source: "apollo",
    }));
    const wanted: PersonCandidate[] = [
      { external_id: "64a1f0c2e5b7a10001a1b2c4", source: "apollo" },
      { external_id: "64a1f0c2e5b7a10001a1b2c3", source: "apollo" },
      {
        first_name: "Nobody",
        last_name: "Known",
        company: { name: "Unknown Co", domain: "unknown.example.com", source: "apollo" },
        source: "apollo",
      },
    ];
    const result = await apollo.enrichPeople?.([...filler, ...wanted]);
    expect(calls).toHaveLength(2);
    expect(bodyOf(0).details).toHaveLength(10);
    expect(bodyOf(1)).toMatchObject({ reveal_personal_emails: false, reveal_phone_number: false });
    expect(bodyOf(1).details[2]).toEqual({
      first_name: "Nobody",
      last_name: "Known",
      domain: "unknown.example.com",
      organization_name: "Unknown Co",
    });
    expect(result?.creditsUsed).toBe(2);
    expect(result?.items).toHaveLength(13);
    expect(result?.items.slice(0, 10).every((item) => item === null)).toBe(true);
    // Answers follow the request order even though Apollo returned them in another order.
    expect(result?.items[10]).toMatchObject({ full_name: "Marco Pellegrini", email: null });
    expect(result?.items[11]).toMatchObject({
      first_name: "Dana",
      last_name: "Rivers",
      email: "dana.rivers@brightsmile.example.com",
      email_status: "valid",
      seniority: "owner",
      department: "operations",
      linkedin_url: "https://www.linkedin.com/in/dana-rivers-example",
      company: { domain: "brightsmile.example.com" },
    });
    expect(result?.items[12]).toBeNull();
  });

  it("returns null for a match with no confidence", () => {
    expect(
      mapApolloMatch({ id: "a1", match_confidence: "none", email: "a@example.com" }),
    ).toBeNull();
    expect(
      mapApolloMatch({ id: "a2", email: "pat@example.com", email_status: "guessed" })?.email_status,
    ).toBe("unknown");
  });
});

describe("apollo errors", () => {
  it("maps 401 to an auth error with the fix command and never echoes the key", async () => {
    const { apollo } = setup([
      {
        match: `${API}/mixed_people/api_search`,
        response: { status: 401, json: fixture("apollo-error-auth") },
      },
    ]);
    const error = await caught(apollo.searchPeople?.({}, { limit: 1 }) as Promise<unknown>);
    expect(error.code).toBe("provider_error");
    expect(error.message).toContain("Invalid access credentials.");
    expect(error.details).toMatchObject({ provider: "apollo", status: 401, auth: true });
    expect(error.hint).toContain(
      "openoutbound providers test --slot lead_source --provider apollo",
    );
    expect(JSON.stringify(error.toJSON())).not.toContain(KEY);
  });

  it("maps 429 to rateLimited with retry-after", async () => {
    const { apollo } = setup([
      {
        match: `${API}/mixed_companies/search`,
        response: {
          status: 429,
          headers: { "retry-after": "30" },
          json: { error: "Too many requests" },
        },
      },
    ]);
    const error = await caught(apollo.searchCompanies?.({}, { limit: 1 }) as Promise<unknown>);
    expect(error.details).toMatchObject({ rateLimited: true, retryable: true });
    expect(error.retryAfterSeconds).toBe(30);
  });

  it("maps 402 to insufficient credits and 500 to retryable", async () => {
    const { apollo } = setup([
      {
        match: `${API}/people/bulk_match`,
        response: { status: 402, json: { error: "No credits" } },
      },
      { match: `${API}/mixed_companies/search`, response: { status: 503, body: "busy" } },
    ]);
    const credits = await caught(
      apollo.enrichPeople?.([{ external_id: "x1", source: "apollo" }]) as Promise<unknown>,
    );
    expect(credits.details).toMatchObject({ insufficient_credits: true });
    const outage = await caught(apollo.searchCompanies?.({}, { limit: 1 }) as Promise<unknown>);
    expect(outage.details).toMatchObject({ retryable: true, status: 503 });
  });
});

describe("apollo paid calls", () => {
  const people = (count: number): PersonCandidate[] =>
    Array.from({ length: count }, (_, i) => ({ external_id: `p${i}`, source: "apollo" }));
  const matchesFor = (ids: string[]) => ({
    credits_consumed: ids.length,
    matches: ids.map((id) => ({ id, name: `Person ${id}`, match_confidence: "high" })),
  });

  it("returns the chunks already matched when a later chunk fails, lined up with the candidates", async () => {
    let call = 0;
    const { apollo, bodyOf } = setup([
      {
        match: `${API}/people/bulk_match`,
        response: (request) => {
          call += 1;
          if (call === 2) return { status: 503, body: "busy" };
          const ids = (
            JSON.parse(String(request.init?.body)) as { details: Array<{ id: string }> }
          ).details.map((d) => d.id);
          return { json: matchesFor(ids) };
        },
      },
    ]);
    const candidates = people(12);
    const error = await caught(apollo.enrichPeople?.(candidates) as Promise<unknown>);
    const partial = partialOf<PersonCandidate | null>(error);
    // The first chunk, index by index with the first ten candidates.
    expect(partial?.items.map((item) => item?.external_id)).toEqual(
      candidates.slice(0, 10).map((candidate) => candidate.external_id),
    );
    expect(partial?.credits).toBe(10);
    expect(partial).not.toHaveProperty("resume");
    // Starting again would pay for the first ten twice.
    expect(failureOf(error)).toMatchObject({ class: "unavailable", retryable: false });
    expect(error.hint).toContain("after the first 10");

    // Going on: only the rest.
    const rest = await apollo.enrichPeople?.(candidates.slice(10));
    expect(rest?.items.map((item) => item?.external_id)).toEqual(["p10", "p11"]);
    expect(rest?.creditsUsed).toBe(2);
    expect(bodyOf(2).details).toEqual([{ id: "p10" }, { id: "p11" }]);
  });

  it("does not retry a paid call whose answer was lost", async () => {
    const { apollo } = setup([
      {
        match: `${API}/mixed_companies/search`,
        response: () => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
      },
      {
        match: `${API}/mixed_people/api_search`,
        response: () => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
      },
    ]);
    const paid = await caught(apollo.searchCompanies?.({}, { limit: 1 }) as Promise<unknown>);
    expect(failureOf(paid)).toMatchObject({ class: "timeout", retryable: false });
    expect(paid.hint).toContain("credits");
    // People search is free: a timeout is retried as usual.
    const free = await caught(apollo.searchPeople?.({}, { limit: 1 }) as Promise<unknown>);
    expect(failureOf(free)).toMatchObject({ class: "timeout", retryable: true });
  });
});

describe("apollo provider definition", () => {
  it("estimates costs without calling the API", async () => {
    const { apollo, calls } = setup();
    expect((await apollo.estimate?.({ kind: "people", count: 250 }))?.credits).toBe(0);
    expect((await apollo.estimate?.({ kind: "companies", count: 250 }))?.credits).toBe(3);
    expect((await apollo.estimate?.({ kind: "enrich", count: 7 }))?.credits).toBe(7);
    expect(calls).toHaveLength(0);
  });

  it("tests the key with a free search", async () => {
    const { apollo } = setup([
      {
        match: `${API}/mixed_people/api_search`,
        response: { json: fixture("apollo-people-search") },
      },
    ]);
    expect(await apolloProvider.test?.(apollo)).toMatchObject({ ok: true });
    const failing = setup([
      {
        match: `${API}/mixed_people/api_search`,
        response: { status: 403, json: fixture("apollo-error-auth") },
      },
    ]);
    const result = await apolloProvider.test?.(failing.apollo);
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("rejected the API key");
  });
});
