import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isOpenOutboundError } from "../../core/errors.js";
import { partialOf } from "../../core/failures.js";
import { createFakeFetch, type FakeSafeFetch } from "../../testing/fake-fetch.js";
import {
  createPredictLeads,
  mapFinancingEvents,
  mapJobOpenings,
  mapNewsEvents,
  mapTechnologyDetections,
  PREDICTLEADS_BASE_URL,
} from "./predictleads.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const jobs = fixture("predictleads-job-openings.json");
const financing = fixture("predictleads-financing-events.json");
const technologies = fixture("predictleads-technology-detections.json");
const news = fixture("predictleads-news-events.json");

const NOW = new Date("2026-09-19T12:00:00Z");
const target = {
  company: { id: "co_1", name: "Northwind Example", domain: "northwind.example.com" },
};

function provider(fake: FakeSafeFetch) {
  const fetch = fake as unknown as typeof globalThis.fetch;
  return createPredictLeads({ apiKey: "test-key", apiToken: "test-token", fetch, now: () => NOW });
}

async function caught(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("predictleads mapping", () => {
  it("maps job openings with a url to hiring_relevant_roles", () => {
    const signals = mapJobOpenings(jobs);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      definition_key: "hiring_relevant_roles",
      title: "Hiring: Head of Sales Operations",
      evidence_url: "https://careers.northwind.example.com/jobs/101",
      evidence_excerpt: "Head of Sales Operations (Berlin, Germany)",
      occurred_at: "2026-09-10T08:00:00.000Z",
      source: "predictleads",
      dedupe_key: "predictleads:job_opening:4d5ac23c-0001-4000-8000-000000000001",
    });
    expect(signals[1]?.summary).toBe("mid_senior");
  });

  it("maps financing events with a source url and formats the amount", () => {
    const signals = mapFinancingEvents(financing);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      definition_key: "funding_round",
      title: "Raised $12M (series a)",
      evidence_url: "https://news.example.org/northwind-raises-series-a",
      occurred_at: "2026-09-01T00:00:00.000Z",
      strength: 1,
    });
  });

  it("maps technology detections through the included technology names", () => {
    const signals = mapTechnologyDetections(technologies, "https://northwind.example.com");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      definition_key: "tech_adopted",
      title: "Started using Examplytics CRM",
      evidence_url: "https://northwind.example.com",
      strength: 0.9,
      raw: { technology: "Examplytics CRM" },
    });
  });

  it("maps news categories to signal keys and needs a source article", () => {
    const signals = mapNewsEvents(news);
    expect(signals.map((signal) => signal.definition_key)).toEqual([
      "expansion_new_location",
      "news_mention",
    ]);
    expect(signals[0]).toMatchObject({
      evidence_url: "https://news.example.org/northwind-lisbon-office",
      strength: 0.82,
    });
    // Low confidence is floored so the signal is not dropped as noise by the mapper itself.
    expect(signals[1]?.strength).toBe(0.3);
  });

  it("returns nothing for malformed bodies", () => {
    expect(mapJobOpenings(null)).toEqual([]);
    expect(mapFinancingEvents({ data: "nope" })).toEqual([]);
    expect(mapTechnologyDetections({ data: [{}] }, "https://x.example.com")).toEqual([]);
    expect(mapNewsEvents([1, 2, 3])).toEqual([]);
  });
});

describe("predictleads provider", () => {
  const base = `${PREDICTLEADS_BASE_URL}/companies/northwind.example.com`;

  it("calls the four endpoints with both auth headers and the since date", async () => {
    const fetch = createFakeFetch([
      { match: new RegExp(`^${base}/job_openings\\?`), response: { json: jobs } },
      { match: new RegExp(`^${base}/financing_events\\?`), response: { json: financing } },
      { match: new RegExp(`^${base}/technology_detections\\?`), response: { json: technologies } },
      { match: new RegExp(`^${base}/news_events\\?`), response: { json: news } },
    ]);
    const signals = await provider(fetch).collect(target, {
      since: new Date("2026-09-01T00:00:00Z"),
    });
    expect(signals.map((signal) => signal.definition_key).sort()).toEqual([
      "expansion_new_location",
      "funding_round",
      "hiring_relevant_roles",
      "hiring_relevant_roles",
      "news_mention",
      "tech_adopted",
    ]);
    expect(fetch.calls).toHaveLength(4);
    const first = fetch.calls[0];
    expect(first?.url).toContain("first_seen_at_from=2026-09-01");
    const headers = first?.init?.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("test-key");
    expect(headers["X-Api-Token"]).toBe("test-token");
  });

  it("only calls the endpoints needed for the requested keys", async () => {
    const fetch = createFakeFetch([
      { match: new RegExp(`^${base}/news_events\\?`), response: { json: news } },
    ]);
    const signals = await provider(fetch).collect(target, {
      signalKeys: ["expansion_new_location"],
    });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toContain("found_at_from=2026-08-20");
    expect(signals.map((signal) => signal.definition_key)).toEqual(["expansion_new_location"]);
  });

  it("skips companies without a domain and treats 404 as no data", async () => {
    const fetch = createFakeFetch([{ match: /predictleads\.com/, response: { status: 404 } }]);
    const instance = provider(fetch);
    expect(await instance.collect({ company: { id: "co_2", name: "No Domain" } })).toEqual([]);
    expect(fetch.calls).toHaveLength(0);
    expect(await instance.collect(target, { signalKeys: ["funding_round"] })).toEqual([]);
  });

  it("maps upstream errors to actionable provider errors", async () => {
    const cases: Array<[number, Record<string, string>, string]> = [
      [401, {}, "rejected the credentials"],
      [402, {}, "out of credits"],
      [429, { "retry-after": "120" }, "rate limit"],
      [500, {}, "server error 500"],
    ];
    for (const [status, headers, message] of cases) {
      const fetch = createFakeFetch([
        { match: /predictleads\.com/, response: { status, headers, json: { error: {} } } },
      ]);
      const error = await caught(
        provider(fetch).collect(target, { signalKeys: ["funding_round"] }),
      );
      expect(isOpenOutboundError(error)).toBe(true);
      if (!isOpenOutboundError(error)) continue;
      expect(error.code).toBe("provider_error");
      expect(error.message).toContain(message);
      expect(error.hint).toBeTruthy();
      expect(JSON.stringify(error.details)).not.toContain("test-key");
      if (status === 429) expect(error.retryAfterSeconds).toBe(120);
    }
  });

  it("returns the signals already paid for when a later endpoint fails, and resumes", async () => {
    const fetch = createFakeFetch([
      { match: /job_openings/, response: { json: { data: [] } } },
      { match: /financing_events/, response: { status: 503, json: {} } },
      { match: /news_events/, response: { json: { data: [] } } },
    ]);
    const instance = provider(fetch);
    const keys = ["hiring_relevant_roles", "funding_round"];
    const error = await caught(instance.collect(target, { signalKeys: keys }));
    const partial = partialOf(error);
    expect(partial).toMatchObject({ credits: 1, resume: { done: ["job_openings"] } });
    fetch.route(/financing_events/, { json: { data: [] } });
    await instance.collect(target, { signalKeys: keys, resume: partial?.resume });
    // Only the endpoint that failed is asked again.
    expect(fetch.calls.filter((call) => call.url.includes("job_openings"))).toHaveLength(1);
    expect(fetch.calls.filter((call) => call.url.includes("financing_events"))).toHaveLength(2);
  });

  it("fails clearly on a body that is not JSON", async () => {
    const fetch = createFakeFetch([
      { match: /predictleads\.com/, response: { body: "<html>maintenance</html>" } },
    ]);
    const error = await caught(provider(fetch).collect(target, { signalKeys: ["funding_round"] }));
    expect(isOpenOutboundError(error) && error.message).toContain("not JSON");
  });
});
