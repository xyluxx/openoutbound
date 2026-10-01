/**
 * Google Places API (New) Text Search lead source (provider API notes section 2).
 *
 * Terms (Google Maps Platform): Places content may not be cached or stored beyond what the
 * terms allow. Only the place id may be stored indefinitely. OpenOutbound therefore uses the
 * returned fields (name, address, phone, website, rating) only transiently, for previews and
 * fit scoring; an import persists just `source_refs.google_maps` (the place id) with the
 * fetch date, plus the company domain taken from the website URL, and fills name, address
 * and phone from the business's own website. Coordinates are only used to split large
 * searches into sub-areas: a cursor carries the sub-areas still to search and, for an area
 * stopped part way, the bounding box of the places its earlier pages returned (so a resumed
 * search splits the same sub-areas as one that ran in one go), nothing else about a place.
 *
 * Searches return at most 60 results (3 pages of 20). When a query hits that cap, the area
 * is split into a 2x2 grid of rectangles (locationRestriction) and each sub-area is searched,
 * up to `max_split_depth` levels. Sub-areas overlap the parent search, so a later page can
 * repeat a place: places are deduped within one call, and callers dedupe across pages by
 * `external_id`. Billing is per request at the highest SKU in the field mask (website, phone
 * and rating make it the Enterprise SKU). The cost is known only as a range: filling a page of
 * N places takes at least N/20 requests, and closed or repeated places and split areas take
 * more, up to `max_requests_per_search` per call. A call also stops at `maxCredits` (the
 * credits left) and returns a cursor for the rest. A request that fails after earlier billed
 * ones, or that is answered with a body the engine cannot read (billed too), throws with
 * `details.partial`: the places so far, the requests made and a cursor to the failed page.
 */
import { z } from "zod";
import { normalizeDomain } from "../../lib/web/extract.js";
import { isDailyQuota, readGoogleError, secondsUntilPacificMidnight } from "../google-errors.js";
import { type AnswerInput, withPartial } from "../http.js";
import {
  type CompanyCandidate,
  type CompanyQuery,
  defineProvider,
  type LeadSourceProvider,
  type SourcePage,
} from "../types.js";
import { asArray, asNumber, asRecord, asString, malformed, requestJson } from "./http.js";

export const googleMapsConfigSchema = z.object({
  base_url: z.url({ protocol: /^https?$/ }).default("https://places.googleapis.com/v1"),
  language_code: z.string().default("en"),
  region_code: z.string().optional(),
  max_split_depth: z.number().int().min(0).max(3).default(2),
  max_requests_per_search: z.number().int().min(1).max(100).default(30),
});
export type GoogleMapsConfig = z.output<typeof googleMapsConfigSchema>;

const PROVIDER = {
  provider: "Google Maps",
  slot: "lead_source",
  providerId: "google_maps",
} as const;
const RESULT_CAP = 60;
const PAGE_SIZE = 20;

/** "1 Text Search request", "3 Text Search requests". */
function textSearchRequests(count: number): string {
  return `${count} Text Search ${count === 1 ? "request" : "requests"}`;
}

export const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.rating",
  "places.userRatingCount",
  "nextPageToken",
].join(",");

interface LatLng {
  latitude: number;
  longitude: number;
}
interface Box {
  low: LatLng;
  high: LatLng;
}
/** Where an area's search stands when it is queued part way. */
interface AreaProgress {
  depth: number;
  /** The next page of this area. */
  pageToken?: string;
  /** Places its earlier pages returned. */
  count?: number;
  /** Bounding box of the places its earlier pages returned (areas without coordinates). */
  seen?: Box;
}
type Area =
  | ({ kind: "none" } & AreaProgress)
  | ({ kind: "circle"; center: LatLng; radius: number } & AreaProgress)
  | ({ kind: "rect"; low: LatLng; high: LatLng } & AreaProgress);

interface SearchState {
  queue: Area[];
}

function encodeState(state: SearchState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeState(cursor: string): SearchState {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as SearchState;
    if (Array.isArray(value.queue)) return value;
  } catch {
    // fall through
  }
  return { queue: [] };
}

function initialArea(query: CompanyQuery): Area {
  const { lat, lng, radius_m } = query.location ?? {};
  if (typeof lat === "number" && typeof lng === "number") {
    return {
      kind: "circle",
      center: { latitude: lat, longitude: lng },
      radius: Math.min(Math.max(radius_m ?? 10_000, 100), 50_000),
      depth: 0,
    };
  }
  return { kind: "none", depth: 0 };
}

/** Text Search request body for one area and page. */
export function textSearchBody(
  query: CompanyQuery,
  area: Area,
  config: Pick<GoogleMapsConfig, "language_code" | "region_code">,
  pageSize = PAGE_SIZE,
): Record<string, unknown> {
  const words = [query.query, ...(query.keywords ?? []), ...(query.industries ?? [])].filter(
    Boolean,
  );
  const place = query.location?.text;
  const textQuery = [
    words.join(" ") || query.categories?.[0] || "business",
    place ? `in ${place}` : "",
  ]
    .join(" ")
    .trim();
  const body: Record<string, unknown> = {
    textQuery,
    pageSize: Math.min(Math.max(pageSize, 1), PAGE_SIZE),
    languageCode: config.language_code,
  };
  if (config.region_code) body.regionCode = config.region_code;
  else if (query.countries?.length === 1) body.regionCode = query.countries[0]?.toUpperCase();
  if (query.categories?.length) body.includedType = query.categories[0];
  if (typeof query.min_rating === "number")
    body.minRating = Math.min(5, Math.max(0, Math.round(query.min_rating * 2) / 2));
  if (area.kind === "circle")
    body.locationBias = { circle: { center: area.center, radius: area.radius } };
  if (area.kind === "rect")
    body.locationRestriction = { rectangle: { low: area.low, high: area.high } };
  if (area.pageToken) body.pageToken = area.pageToken;
  return body;
}

function componentOf(
  components: unknown[],
  type: string,
  key: "shortText" | "longText",
): string | null {
  for (const component of components) {
    const record = asRecord(component);
    if (asArray(record?.types).includes(type)) return asString(record?.[key]);
  }
  return null;
}

function humanize(type: string | null): string | null {
  return type ? type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : null;
}

/** Place -> CompanyCandidate (transient; see the terms note at the top of this file). */
export function mapPlace(raw: unknown): CompanyCandidate | null {
  const place = asRecord(raw);
  const id = asString(place?.id);
  const name = asString(asRecord(place?.displayName)?.text);
  if (!place || !id || !name) return null;
  if (place.businessStatus === "CLOSED_PERMANENTLY") return null;
  const components = asArray(place.addressComponents);
  const website = asString(place.websiteUri);
  const location = asRecord(place.location);
  const types = asArray(place.types).filter((t): t is string => typeof t === "string");
  return {
    external_id: id,
    name,
    website,
    domain: website ? normalizeDomain(website) : null,
    industry: humanize(asString(place.primaryType) ?? types[0] ?? null),
    address: asString(place.formattedAddress),
    city:
      componentOf(components, "locality", "longText") ??
      componentOf(components, "postal_town", "longText"),
    region: componentOf(components, "administrative_area_level_1", "shortText"),
    postal_code: componentOf(components, "postal_code", "longText"),
    country: componentOf(components, "country", "shortText"),
    phone: asString(place.nationalPhoneNumber) ?? asString(place.internationalPhoneNumber),
    rating: asNumber(place.rating),
    reviews_count: asNumber(place.userRatingCount),
    lat: asNumber(location?.latitude),
    lng: asNumber(location?.longitude),
    categories: types,
    source: "google_maps",
  };
}

/** Bounding box of the points, or null without any. */
function boxOf(points: LatLng[]): Box | null {
  if (points.length === 0) return null;
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  return {
    low: { latitude: Math.min(...lats), longitude: Math.min(...lngs) },
    high: { latitude: Math.max(...lats), longitude: Math.max(...lngs) },
  };
}

/** The points an area's search has seen: this call's and the box of its earlier pages. */
function seenPoints(area: Area, points: LatLng[]): LatLng[] {
  return area.seen ? [...points, area.seen.low, area.seen.high] : points;
}

/** The area queued again part way: its next page, the places so far and their box. */
function requeued(area: Area, pageToken: string | undefined, count: number, points: LatLng[]) {
  const seen = area.kind === "none" ? boxOf(seenPoints(area, points)) : null;
  return { ...area, pageToken, count, ...(seen ? { seen } : {}) } as Area;
}

function boundsOf(area: Area, points: LatLng[]): Box | null {
  if (area.kind === "rect") return { low: area.low, high: area.high };
  if (area.kind === "circle") {
    const dLat = area.radius / 111_320;
    const dLng =
      area.radius / (111_320 * Math.max(0.1, Math.cos((area.center.latitude * Math.PI) / 180)));
    return {
      low: { latitude: area.center.latitude - dLat, longitude: area.center.longitude - dLng },
      high: { latitude: area.center.latitude + dLat, longitude: area.center.longitude + dLng },
    };
  }
  // Without coordinates: the places of every page of this area, earlier calls included.
  const all = seenPoints(area, points);
  return all.length < 2 ? null : boxOf(all);
}

/** 2x2 grid of sub-rectangles. */
export function splitArea(bounds: { low: LatLng; high: LatLng }, depth: number): Area[] {
  const midLat = (bounds.low.latitude + bounds.high.latitude) / 2;
  const midLng = (bounds.low.longitude + bounds.high.longitude) / 2;
  const cell = (lowLat: number, lowLng: number, highLat: number, highLng: number): Area => ({
    kind: "rect",
    low: { latitude: lowLat, longitude: lowLng },
    high: { latitude: highLat, longitude: highLng },
    depth,
  });
  return [
    cell(bounds.low.latitude, bounds.low.longitude, midLat, midLng),
    cell(bounds.low.latitude, midLng, midLat, bounds.high.longitude),
    cell(midLat, bounds.low.longitude, bounds.high.latitude, midLng),
    cell(midLat, midLng, bounds.high.latitude, bounds.high.longitude),
  ];
}

const KEY_REASONS = new Set(["API_KEY_INVALID", "API_KEY_EXPIRED"]);
const ACCESS_REASONS = new Set([
  "BILLING_DISABLED",
  "SERVICE_DISABLED",
  "API_KEY_SERVICE_BLOCKED",
  "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED",
  "API_KEY_ANDROID_APP_BLOCKED",
  "API_KEY_IOS_APP_BLOCKED",
]);

/**
 * Google's error envelope read by its documented fields (see providers/google-errors): a daily
 * quota (a 429 RESOURCE_EXHAUSTED whose limit is per day) is `quota_exhausted` until midnight
 * Pacific time; a per-minute limit stays `rate_limited`.
 */
export function googleErrorAnswer(status: number, body: unknown): Partial<AnswerInput> | undefined {
  const error = readGoogleError(body);
  if (!error) return undefined;
  if (
    error.reasons.some((reason) => KEY_REASONS.has(reason)) ||
    /API key (not valid|expired)|missing a valid API key/i.test(error.message)
  ) {
    return { class: "auth_invalid" };
  }
  const exhausted = status === 429 || error.status === "RESOURCE_EXHAUSTED";
  if (exhausted && isDailyQuota(error)) {
    return {
      class: "quota_exhausted",
      retryAfterSeconds: secondsUntilPacificMidnight(),
      hint: "The daily Places API quota of this Google Cloud project is used up; it resets at midnight Pacific time. Raise the quota in the Google Cloud console to search more today.",
    };
  }
  if (error.reasons.some((reason) => ACCESS_REASONS.has(reason))) {
    return {
      class: "forbidden",
      hint: "Enable the Places API (New) and billing in the Google Cloud project of this key, and allow the key to call it (API restrictions). Then run manage_providers (action test).",
    };
  }
  return undefined;
}

/** A failure after billed requests: the places so far, their requests and a cursor. */
function partialFailure(
  error: unknown,
  items: CompanyCandidate[],
  requests: number,
  state: SearchState,
): unknown {
  return withPartial(
    error,
    { id: "google_maps", name: "Google Maps" },
    { items, credits: requests, resume: encodeState(state) },
    "Pass details.partial.resume as the cursor to go on from the page that failed.",
  );
}

/** The instance also exposes a cheap key check (IDs-only field mask, the lowest SKU). */
export interface GoogleMapsInstance extends LeadSourceProvider {
  checkKey(): Promise<void>;
}

export interface GoogleMapsOptions {
  apiKey: string;
  config: GoogleMapsConfig;
  fetch: typeof fetch;
}

export function createGoogleMaps(options: GoogleMapsOptions): GoogleMapsInstance {
  const { config } = options;
  const base = config.base_url.replace(/\/+$/, "");
  const search = (body: Record<string, unknown>, fieldMask: string, paid: boolean) =>
    requestJson(options.fetch, {
      ...PROVIDER,
      url: `${base}/places:searchText`,
      method: "POST",
      headers: { "X-Goog-Api-Key": options.apiKey, "X-Goog-FieldMask": fieldMask },
      body,
      paid,
      classify: googleErrorAnswer,
    });

  return {
    id: "google_maps",
    capabilities: { people: false, companies: true, enrich: false },

    async checkKey() {
      // The IDs-only field mask is the free SKU.
      await search({ textQuery: "coffee", pageSize: 1 }, "places.id", false);
    },

    async searchCompanies(query, pageRequest): Promise<SourcePage<CompanyCandidate>> {
      // A failed call's details.partial.resume is a cursor to the request that failed.
      const cursor = pageRequest.cursor;
      const state: SearchState = cursor ? decodeState(cursor) : { queue: [initialArea(query)] };
      const items: CompanyCandidate[] = [];
      const seen = new Set<string>();
      // One credit per request: stop at the setting or at the credits left, whichever is lower.
      const maxRequests = Math.min(
        config.max_requests_per_search,
        Math.floor(pageRequest.maxCredits ?? Number.POSITIVE_INFINITY),
      );
      let requests = 0;
      while (state.queue.length > 0 && items.length < pageRequest.limit && requests < maxRequests) {
        const area = state.queue.shift() as Area;
        const points: LatLng[] = [];
        let count = area.count ?? 0;
        let token = area.pageToken;
        let stoppedEarly = false;
        do {
          // Ask only for what this page still needs, so no fetched place is dropped.
          const pageSize = Math.min(PAGE_SIZE, pageRequest.limit - items.length);
          let body: unknown;
          try {
            ({ body } = await search(
              textSearchBody(query, { ...area, pageToken: token } as Area, config, pageSize),
              SEARCH_FIELD_MASK,
              true,
            ));
          } catch (error) {
            if (requests === 0) throw error;
            // Earlier requests were billed: return their places and a cursor to this page.
            state.queue.unshift(requeued(area, token, count, points));
            throw partialFailure(error, items, requests, state);
          }
          requests += 1;
          const record = asRecord(body);
          if (!record) {
            // Answered, so billed like the pages before it: keep them, with a cursor to it.
            state.queue.unshift(requeued(area, token, count, points));
            throw partialFailure(
              malformed("Google Maps", "google_maps", "empty body"),
              items,
              requests,
              state,
            );
          }
          const places = asArray(record.places);
          count += places.length;
          for (const raw of places) {
            const candidate = mapPlace(raw);
            if (candidate?.lat != null && candidate.lng != null) {
              points.push({ latitude: candidate.lat, longitude: candidate.lng });
            }
            if (!candidate?.external_id || seen.has(candidate.external_id)) continue;
            seen.add(candidate.external_id);
            items.push(candidate);
          }
          token = asString(record.nextPageToken) ?? undefined;
          if (token && (items.length >= pageRequest.limit || requests >= maxRequests)) {
            state.queue.unshift(requeued(area, token, count, points));
            stoppedEarly = true;
            break;
          }
        } while (token);
        if (!stoppedEarly && count >= RESULT_CAP && area.depth < config.max_split_depth) {
          const bounds = boundsOf(area, points);
          if (bounds) state.queue.push(...splitArea(bounds, area.depth + 1));
        }
      }
      return {
        items,
        total: null,
        nextCursor: state.queue.length > 0 ? encodeState(state) : null,
        creditsUsed: requests,
      };
    },

    async estimate(request) {
      // The least: every request returns a full page of new, open places. The most: the cap.
      const most = config.max_requests_per_search;
      const least = Math.min(Math.max(1, Math.ceil(request.count / PAGE_SIZE)), most);
      const billing = "billed per request at the Enterprise SKU (website, phone and rating fields)";
      const setting = "the max_requests_per_search provider setting";
      const stops =
        "A search stops early at the credits left (data budget or spend cap) and returns a cursor for the rest.";
      if (least === most) {
        return {
          credits: most,
          minCredits: 1,
          note: `At most ${textSearchRequests(most)} of up to 20 places (${setting}), ${billing}. ${stops}`,
        };
      }
      return {
        credits: least,
        maxCredits: most,
        minCredits: 1,
        note: `Returning ${request.count} ${request.count === 1 ? "place" : "places"} takes at least ${textSearchRequests(least)} of up to 20 places, ${billing}. Closed or repeated places, and busy areas split into smaller squares, take more requests, up to ${most} per search (${setting}). ${stops}`,
      };
    },
  };
}

export const googleMapsProvider = defineProvider({
  slot: "lead_source",
  id: "google_maps",
  name: "Google Maps (Places API)",
  description:
    "Local business search with the Places API (New) Text Search. Results (name, address, phone, rating) are shown in previews only; to follow the Google Maps Platform terms an import stores just the place id and the website domain, and fills company details from the business website. Billed per request.",
  docsUrl: "https://developers.google.com/maps/documentation/places/web-service/text-search",
  configSchema: googleMapsConfigSchema,
  secrets: [{ key: "api_key", label: "API key", env: "GOOGLE_MAPS_API_KEY", required: true }],
  create: ({ config, secrets, ctx }) =>
    createGoogleMaps({ apiKey: secrets.api_key ?? "", config, fetch: ctx.fetch }),
  test: async (instance) => {
    try {
      await (instance as GoogleMapsInstance).checkKey();
      return { ok: true, message: "Google Maps key works (Places Text Search)." };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});
