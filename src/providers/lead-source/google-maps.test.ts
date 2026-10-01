import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import { failureOf, partialOf } from "../../core/failures.js";
import { createFakeFetch, type FakeRequest, type FetchRoute } from "../../testing/fake-fetch.js";
import { secondsUntilPacificMidnight } from "../google-errors.js";
import {
  createGoogleMaps,
  type GoogleMapsConfig,
  googleErrorAnswer,
  googleMapsConfigSchema,
  googleMapsProvider,
  mapPlace,
  SEARCH_FIELD_MASK,
  splitArea,
  textSearchBody,
} from "./google-maps.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const URL_SEARCH = "https://places.googleapis.com/v1/places:searchText";
const KEY = "places-test-key-456";

function setup(response: FetchRoute["response"], config: Partial<GoogleMapsConfig> = {}) {
  const calls: FakeRequest[] = [];
  const fetch = createFakeFetch(
    [{ match: URL_SEARCH, method: "POST", response }],
    calls,
  ) as unknown as typeof globalThis.fetch;
  const maps = createGoogleMaps({
    apiKey: KEY,
    config: googleMapsConfigSchema.parse(config),
    fetch,
  });
  const bodyOf = (index: number) => JSON.parse(String(calls[index]?.init?.body ?? "{}"));
  const headersOf = (index: number) =>
    (calls[index]?.init?.headers ?? {}) as Record<string, string>;
  return { maps, calls, bodyOf, headersOf };
}

function requestBody(request: FakeRequest): Record<string, unknown> {
  return JSON.parse(String(request.init?.body ?? "{}"));
}

interface Rect {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
}

function rectOf(body: Record<string, unknown> | undefined): Rect {
  const restriction = body?.locationRestriction as { rectangle: Rect } | undefined;
  if (!restriction) throw new Error("expected a locationRestriction");
  return restriction.rectangle;
}

/** A generated place inside the given box (invented names, example.com websites). */
function place(n: number, lat: number, lng: number) {
  return {
    id: `ChIJgen${String(n).padStart(6, "0")}`,
    displayName: { text: `Example Dental ${n}` },
    location: { latitude: lat, longitude: lng },
    businessStatus: "OPERATIONAL",
    websiteUri: `https://dental${n}.example.com/`,
  };
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

describe("google maps place mapping", () => {
  it("maps a place for previews and takes the domain from the website URL", () => {
    const places = (fixture("places-search-page1") as { places: unknown[] }).places;
    expect(mapPlace(places[0])).toMatchObject({
      external_id: "ChIJexample0000000000000001",
      name: "Brightsmile Dental Studio",
      website: "https://www.brightsmile.example.com/?utm_source=gmb",
      domain: "brightsmile.example.com",
      industry: "Dentist",
      address: "100 Example Ave, Austin, TX 78701, USA",
      city: "Austin",
      region: "TX",
      postal_code: "78701",
      country: "US",
      phone: "(512) 555-0101",
      rating: 4.8,
      reviews_count: 212,
      source: "google_maps",
    });
    expect(mapPlace(places[1])).toMatchObject({ website: null, domain: null });
  });

  it("drops permanently closed and nameless places", () => {
    const places = (fixture("places-search-page1") as { places: unknown[] }).places;
    expect(mapPlace(places[2])).toBeNull();
    expect(mapPlace({ id: "ChIJx" })).toBeNull();
    expect(mapPlace("nope")).toBeNull();
  });

  it("builds the text query, region, type and rating filters", () => {
    const body = textSearchBody(
      {
        query: "dentist",
        location: { text: "Austin, TX" },
        countries: ["us"],
        categories: ["dentist"],
        min_rating: 4.3,
      },
      { kind: "none", depth: 0 },
      { language_code: "en" },
    );
    expect(body).toEqual({
      textQuery: "dentist in Austin, TX",
      pageSize: 20,
      languageCode: "en",
      regionCode: "US",
      includedType: "dentist",
      minRating: 4.5,
    });
  });

  it("splits an area into four quadrants", () => {
    const cells = splitArea(
      { low: { latitude: 0, longitude: 0 }, high: { latitude: 2, longitude: 4 } },
      1,
    );
    expect(cells).toHaveLength(4);
    expect(cells[0]).toMatchObject({
      kind: "rect",
      low: { latitude: 0, longitude: 0 },
      high: { latitude: 1, longitude: 2 },
      depth: 1,
    });
    expect(cells[3]).toMatchObject({
      low: { latitude: 1, longitude: 2 },
      high: { latitude: 2, longitude: 4 },
    });
  });
});

describe("google maps search", () => {
  it("follows page tokens, skips closed and duplicate places and bills per request", async () => {
    const { maps, calls, bodyOf, headersOf } = setup((request) =>
      requestBody(request).pageToken === "page-token-2"
        ? { json: fixture("places-search-page2") }
        : { json: fixture("places-search-page1") },
    );
    const page = await maps.searchCompanies?.(
      { query: "dentist", location: { text: "Austin, TX" } },
      { limit: 25 },
    );
    expect(page?.items.map((item) => item.name)).toEqual([
      "Brightsmile Dental Studio",
      "Lakeview Orthodontics",
      "Hillside Dental Care",
    ]);
    expect(page?.creditsUsed).toBe(2);
    expect(page?.nextCursor).toBeNull();
    expect(calls).toHaveLength(2);
    expect(headersOf(0)["X-Goog-Api-Key"]).toBe(KEY);
    expect(headersOf(0)["X-Goog-FieldMask"]).toBe(SEARCH_FIELD_MASK);
    expect(bodyOf(0).pageToken).toBeUndefined();
    expect(bodyOf(1)).toMatchObject({
      pageToken: "page-token-2",
      textQuery: "dentist in Austin, TX",
    });
  });

  it("returns a cursor that resumes with the page token and never exceeds the limit", async () => {
    const { maps, bodyOf } = setup((request) =>
      requestBody(request).pageToken === "page-token-2"
        ? { json: fixture("places-search-page2") }
        : { json: fixture("places-search-page1") },
    );
    const first = await maps.searchCompanies?.({ query: "dentist" }, { limit: 2 });
    expect(first?.items).toHaveLength(2);
    expect(bodyOf(0).pageSize).toBe(2);
    expect(first?.nextCursor).toEqual(expect.any(String));
    const second = await maps.searchCompanies?.(
      { query: "dentist" },
      { limit: 2, cursor: first?.nextCursor ?? "" },
    );
    expect(bodyOf(1).pageToken).toBe("page-token-2");
    // Dedupe is per call; across calls the caller dedupes by external_id (sub-areas overlap).
    expect(second?.items.map((item) => item.name)).toEqual([
      "Hillside Dental Care",
      "Brightsmile Dental Studio",
    ]);
    expect(second?.nextCursor).toBeNull();
  });

  it("splits a capped circle search into four rectangles", async () => {
    let generated = 0;
    const { maps, calls } = setup((request) => {
      const body = requestBody(request);
      if (body.locationRestriction) {
        const { low, high } = rectOf(body);
        generated += 1;
        const lat = (low.latitude + high.latitude) / 2;
        const lng = (low.longitude + high.longitude) / 2;
        // One new place per quadrant plus one already seen in the parent search.
        return { json: { places: [place(1000 + generated, lat, lng), place(1, lat, lng)] } };
      }
      const pageIndex = body.pageToken ? Number(body.pageToken) : 0;
      const places = Array.from({ length: 20 }, (_, i) =>
        place(pageIndex * 20 + i + 1, 30.2 + i * 0.001, -97.7 - i * 0.001),
      );
      return {
        json: { places, ...(pageIndex < 2 ? { nextPageToken: String(pageIndex + 1) } : {}) },
      };
    });
    const page = await maps.searchCompanies?.(
      { query: "dentist", location: { lat: 30.2672, lng: -97.7431, radius_m: 20_000 } },
      { limit: 100 },
    );
    expect(calls).toHaveLength(7);
    expect(page?.creditsUsed).toBe(7);
    expect(page?.items).toHaveLength(64);
    expect(new Set(page?.items.map((item) => item.external_id)).size).toBe(64);
    expect(page?.nextCursor).toBeNull();
    const first = requestBody(calls[0] as FakeRequest);
    expect(first.locationBias).toEqual({
      circle: { center: { latitude: 30.2672, longitude: -97.7431 }, radius: 20_000 },
    });
    const quadrants = calls.slice(3).map((call) => requestBody(call));
    expect(quadrants.every((body) => body.locationRestriction && !body.locationBias)).toBe(true);
    const rect = rectOf(quadrants[0]);
    expect(rect.low.latitude).toBeLessThan(30.2672);
    expect(rect.high.latitude).toBeCloseTo(30.2672, 6);
  });

  it("splits a search without coordinates using the places it found", async () => {
    const { maps, calls } = setup((request) => {
      const body = requestBody(request);
      if (body.locationRestriction) return { json: {} };
      const pageIndex = body.pageToken ? Number(body.pageToken) : 0;
      const places = Array.from({ length: 20 }, (_, i) =>
        place(pageIndex * 20 + i + 1, 48.1 + i * 0.01, 11.5 + pageIndex * 0.01),
      );
      return {
        json: { places, ...(pageIndex < 2 ? { nextPageToken: String(pageIndex + 1) } : {}) },
      };
    });
    const page = await maps.searchCompanies?.({ query: "Zahnarzt in Munich" }, { limit: 100 });
    expect(page?.items).toHaveLength(60);
    expect(calls).toHaveLength(7);
    const rect = rectOf(requestBody(calls[3] as FakeRequest));
    expect(rect.low).toEqual({ latitude: 48.1, longitude: 11.5 });
  });

  it("does not split when the split depth is zero", async () => {
    const { maps, calls } = setup(
      (request) => {
        const body = requestBody(request);
        const pageIndex = body.pageToken ? Number(body.pageToken) : 0;
        const places = Array.from({ length: 20 }, (_, i) =>
          place(pageIndex * 20 + i + 1, 30 + i * 0.01, -97),
        );
        return {
          json: { places, ...(pageIndex < 2 ? { nextPageToken: String(pageIndex + 1) } : {}) },
        };
      },
      { max_split_depth: 0 },
    );
    const page = await maps.searchCompanies?.(
      { query: "dentist", location: { lat: 30, lng: -97 } },
      { limit: 100 },
    );
    expect(calls).toHaveLength(3);
    expect(page?.nextCursor).toBeNull();
  });

  it("treats an empty object as no results", async () => {
    const { maps } = setup({ json: {} });
    const page = await maps.searchCompanies?.({ query: "nothing here" }, { limit: 10 });
    expect(page).toMatchObject({ items: [], nextCursor: null, creditsUsed: 1 });
  });
});

describe("google maps errors and definition", () => {
  it("maps the Google error envelope for a bad key", async () => {
    const { maps } = setup({ status: 403, json: fixture("places-error-key") });
    const error = await caught(
      maps.searchCompanies?.({ query: "x" }, { limit: 5 }) as Promise<unknown>,
    );
    expect(error.code).toBe("provider_error");
    expect(error.message).toContain("The request is missing a valid API key.");
    expect(error.details).toMatchObject({ provider: "google_maps", auth: true });
    expect(error.hint).toContain(
      "openoutbound providers test --slot lead_source --provider google_maps",
    );
    expect(JSON.stringify(error.toJSON())).not.toContain(KEY);
  });

  it("maps quota errors to rateLimited and bad JSON to malformed", async () => {
    const quota = setup({
      status: 429,
      json: { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } },
    });
    const limited = await caught(
      quota.maps.searchCompanies?.({ query: "x" }, { limit: 5 }) as Promise<unknown>,
    );
    expect(limited.details).toMatchObject({ rateLimited: true });
    const broken = setup({ body: "not json" });
    const malformed = await caught(
      broken.maps.searchCompanies?.({ query: "x" }, { limit: 5 }) as Promise<unknown>,
    );
    expect(malformed.details).toMatchObject({ malformed: true });
  });

  it("reads a daily quota as quota_exhausted until midnight Pacific time", async () => {
    const daily = {
      error: {
        code: 429,
        message:
          "Quota exceeded for quota metric 'SearchText requests' and limit 'SearchText requests per day'.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
            metadata: { quota_limit: "SearchTextRequestsPerDayPerProject" },
          },
        ],
      },
    };
    const { maps } = setup({ status: 429, json: daily });
    const error = await caught(
      maps.searchCompanies?.({ query: "x" }, { limit: 5 }) as Promise<unknown>,
    );
    expect(failureOf(error)).toMatchObject({ class: "quota_exhausted", retryable: false });
    expect(failureOf(error)?.retry_after_s).toBeGreaterThan(0);
    expect(error.details).toMatchObject({ insufficient_credits: true });
    // A per-minute limit stays a short rate limit.
    const perMinute = {
      error: {
        code: 429,
        message: "Quota exceeded",
        status: "RESOURCE_EXHAUSTED",
        details: [{ reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_limit: "PerMinute" } }],
      },
    };
    expect(googleErrorAnswer(429, perMinute)).toBeUndefined();
    expect(
      googleErrorAnswer(403, { error: { details: [{ reason: "BILLING_DISABLED" }] } }),
    ).toMatchObject({
      class: "forbidden",
    });
    // 08:00 UTC in summer is 01:00 Pacific: 23 hours to go.
    expect(secondsUntilPacificMidnight(Date.parse("2026-07-01T08:00:00Z"))).toBe(23 * 3600);
  });

  it("returns the places already paid for when a later page fails, with a cursor to go on", async () => {
    let call = 0;
    const { maps, bodyOf } = setup((request) => {
      call += 1;
      if (call === 2) return { status: 500, json: { error: { message: "Backend error" } } };
      const body = requestBody(request);
      return {
        json: {
          places: [place(call, 30.1, -97.1)],
          ...(body.pageToken ? {} : { nextPageToken: "token-2" }),
        },
      };
    });
    const error = await caught(
      maps.searchCompanies?.({ query: "dentist" }, { limit: 40 }) as Promise<unknown>,
    );
    const partial = partialOf(error);
    expect(partial).toMatchObject({ credits: 1 });
    expect(partial?.items).toHaveLength(1);
    expect(failureOf(error)?.retryable).toBe(false);
    const resumed = await maps.searchCompanies?.(
      { query: "dentist" },
      { limit: 40, cursor: partial?.resume as string },
    );
    expect(bodyOf(2).pageToken).toBe("token-2");
    expect(resumed?.items).toHaveLength(1);
  });

  it("returns the places already paid for when a later page cannot be read, with a cursor to it", async () => {
    for (const unreadable of [{ body: "" }, { json: ["not", "an", "object"] }]) {
      let call = 0;
      const { maps, bodyOf } = setup((request) => {
        call += 1;
        if (call === 2) return unreadable;
        const body = requestBody(request);
        return {
          json: {
            places: [place(call, 30.1, -97.1)],
            ...(body.pageToken ? {} : { nextPageToken: "token-2" }),
          },
        };
      });
      const error = await caught(
        maps.searchCompanies?.({ query: "dentist" }, { limit: 40 }) as Promise<unknown>,
      );
      expect(failureOf(error)).toMatchObject({ class: "malformed", retryable: false });
      // Both requests were answered, so both were billed.
      const partial = partialOf(error);
      expect(partial).toMatchObject({ credits: 2 });
      expect(partial?.items).toHaveLength(1);
      await maps.searchCompanies?.(
        { query: "dentist" },
        { limit: 40, cursor: partial?.resume as string },
      );
      expect(bodyOf(2).pageToken).toBe("token-2");
    }
  });

  it("splits a search resumed after a failed page like a clean one", async () => {
    const pages = (failThirdPage: boolean) => {
      let failed = false;
      return setup((request) => {
        const body = requestBody(request);
        if (body.locationRestriction) return { json: {} };
        const pageIndex = body.pageToken ? Number(body.pageToken) : 0;
        if (failThirdPage && pageIndex === 2 && !failed) {
          failed = true;
          return { status: 503, json: { error: { message: "Backend error" } } };
        }
        const places = Array.from({ length: 20 }, (_, i) =>
          place(pageIndex * 20 + i + 1, 30.1 + i * 0.01 + pageIndex * 0.2, -97.7 + pageIndex * 0.1),
        );
        return {
          json: { places, ...(pageIndex < 2 ? { nextPageToken: String(pageIndex + 1) } : {}) },
        };
      });
    };
    const query = { query: "dentist in Austin" };
    const rects = (calls: FakeRequest[]) =>
      calls
        .map((call) => requestBody(call))
        .filter((body) => body.locationRestriction)
        .map(rectOf);

    const clean = pages(false);
    await clean.maps.searchCompanies?.(query, { limit: 100 });
    expect(rects(clean.calls)).toHaveLength(4);

    const resumed = pages(true);
    const error = await caught(
      resumed.maps.searchCompanies?.(query, { limit: 100 }) as Promise<unknown>,
    );
    const partial = partialOf(error);
    expect(partial?.items).toHaveLength(40);
    await resumed.maps.searchCompanies?.(query, {
      limit: 60,
      cursor: partial?.resume as string,
    });
    expect(rects(resumed.calls)).toEqual(rects(clean.calls));
  });

  it("checks the key with the IDs-only field mask and says what is stored", async () => {
    const { maps, headersOf, bodyOf } = setup({ json: { places: [{ id: "ChIJx" }] } });
    expect(await googleMapsProvider.test?.(maps)).toMatchObject({ ok: true });
    expect(headersOf(0)["X-Goog-FieldMask"]).toBe("places.id");
    expect(bodyOf(0).pageSize).toBe(1);
    const failing = setup({ status: 403, json: fixture("places-error-key") });
    expect((await googleMapsProvider.test?.(failing.maps))?.ok).toBe(false);
    expect(googleMapsProvider.description).toContain("place id");
  });

  it("estimates the least a search costs (one request per 20 places) and the most it can cost", async () => {
    const { maps, calls } = setup({ json: {} });
    expect(await maps.estimate?.({ kind: "companies", count: 45 })).toEqual({
      credits: 3,
      maxCredits: 30,
      minCredits: 1,
      note: "Returning 45 places takes at least 3 Text Search requests of up to 20 places, billed per request at the Enterprise SKU (website, phone and rating fields). Closed or repeated places, and busy areas split into smaller squares, take more requests, up to 30 per search (the max_requests_per_search provider setting). A search stops early at the credits left (data budget or spend cap) and returns a cursor for the rest.",
    });
    expect(await maps.estimate?.({ kind: "companies", count: 1 })).toEqual({
      credits: 1,
      maxCredits: 30,
      minCredits: 1,
      note: "Returning 1 place takes at least 1 Text Search request of up to 20 places, billed per request at the Enterprise SKU (website, phone and rating fields). Closed or repeated places, and busy areas split into smaller squares, take more requests, up to 30 per search (the max_requests_per_search provider setting). A search stops early at the credits left (data budget or spend cap) and returns a cursor for the rest.",
    });
    expect(calls).toHaveLength(0);
  });

  it("estimates the request cap alone when the cap is all a search can take", async () => {
    const capped = setup({ json: {} }, { max_requests_per_search: 4 });
    expect(await capped.maps.estimate?.({ kind: "companies", count: 100 })).toEqual({
      credits: 4,
      minCredits: 1,
      note: "At most 4 Text Search requests of up to 20 places (the max_requests_per_search provider setting), billed per request at the Enterprise SKU (website, phone and rating fields). A search stops early at the credits left (data budget or spend cap) and returns a cursor for the rest.",
    });
    expect(await capped.maps.estimate?.({ kind: "companies", count: 60 })).toMatchObject({
      credits: 3,
      maxCredits: 4,
    });
    const single = setup({ json: {} }, { max_requests_per_search: 1 });
    expect(await single.maps.estimate?.({ kind: "companies", count: 5 })).toEqual({
      credits: 1,
      minCredits: 1,
      note: "At most 1 Text Search request of up to 20 places (the max_requests_per_search provider setting), billed per request at the Enterprise SKU (website, phone and rating fields). A search stops early at the credits left (data budget or spend cap) and returns a cursor for the rest.",
    });
  });

  it("can make more requests than the least estimate, never more than the most", async () => {
    // Every place is permanently closed, so no request fills the page and each full area splits.
    const { maps, calls } = setup((request) => {
      const pageIndex = requestBody(request).pageToken ? Number(requestBody(request).pageToken) : 0;
      const places = Array.from({ length: 20 }, (_, i) => ({
        ...place(pageIndex * 20 + i + 1, 30 + i * 0.001, -97 - i * 0.001),
        businessStatus: "CLOSED_PERMANENTLY",
      }));
      return {
        json: { places, ...(pageIndex < 2 ? { nextPageToken: String(pageIndex + 1) } : {}) },
      };
    });
    const estimate = await maps.estimate?.({ kind: "companies", count: 25 });
    const page = await maps.searchCompanies?.(
      { query: "dentist", location: { lat: 30, lng: -97, radius_m: 5_000 } },
      { limit: 25 },
    );
    expect(estimate).toMatchObject({ credits: 2, maxCredits: 30 });
    expect(page?.items).toHaveLength(0);
    expect(calls).toHaveLength(30);
    expect(page?.creditsUsed).toBe(30);
    // More credits than max_requests_per_search do not raise the cap.
    const generous = await maps.searchCompanies?.(
      { query: "dentist", location: { lat: 30, lng: -97, radius_m: 5_000 } },
      { limit: 25, maxCredits: 50 },
    );
    expect(generous?.creditsUsed).toBe(30);
  });

  it("stops at the credits it is given and returns a cursor that continues the search", async () => {
    // Three full pages of new places (page tokens "1" and "2"); no split at depth 0.
    const { maps, calls, bodyOf } = setup(
      (request) => {
        const token = requestBody(request).pageToken;
        const pageIndex = token ? Number(token) : 0;
        const places = Array.from({ length: 20 }, (_, i) =>
          place(pageIndex * 20 + i + 1, 30 + i * 0.001, -97 - pageIndex * 0.001),
        );
        return {
          json: { places, ...(pageIndex < 2 ? { nextPageToken: String(pageIndex + 1) } : {}) },
        };
      },
      { max_split_depth: 0 },
    );
    const query = { query: "dentist", location: { text: "Austin, TX" } };
    // A partial credit buys no request: 2.5 credits make 2 requests.
    const first = await maps.searchCompanies?.(query, { limit: 60, maxCredits: 2.5 });
    expect(calls).toHaveLength(2);
    expect(first?.items).toHaveLength(40);
    expect(first?.creditsUsed).toBe(2);
    expect(first?.nextCursor).toEqual(expect.any(String));

    const rest = await maps.searchCompanies?.(query, {
      limit: 60,
      cursor: first?.nextCursor ?? "",
      maxCredits: 5,
    });
    expect(calls).toHaveLength(3);
    expect(bodyOf(2).pageToken).toBe("2");
    expect(rest).toMatchObject({ creditsUsed: 1, nextCursor: null });
    expect(rest?.items).toHaveLength(20);
  });

  it("makes no request with less than one credit and returns a cursor for the whole search", async () => {
    const { maps, calls, bodyOf } = setup({ json: fixture("places-search-page2") });
    const query = { query: "dentist", location: { text: "Austin, TX" } };
    const none = await maps.searchCompanies?.(query, { limit: 10, maxCredits: 0.5 });
    expect(calls).toHaveLength(0);
    expect(none).toMatchObject({ items: [], creditsUsed: 0, nextCursor: expect.any(String) });
    const later = await maps.searchCompanies?.(query, {
      limit: 10,
      cursor: none?.nextCursor ?? "",
      maxCredits: 1,
    });
    expect(calls).toHaveLength(1);
    expect(bodyOf(0)).toMatchObject({ textQuery: "dentist in Austin, TX" });
    expect(bodyOf(0).pageToken).toBeUndefined();
    expect(later?.items.length).toBeGreaterThan(0);
  });
});
