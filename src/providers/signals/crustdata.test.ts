import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isOpenOutboundError } from "../../core/errors.js";
import { createFakeFetch, type FakeSafeFetch } from "../../testing/fake-fetch.js";
import {
  CRUSTDATA_API_VERSION,
  CRUSTDATA_BASE_URL,
  createCrustdata,
  crustdataProvider,
  mapHeadcount,
  mapWatcherPayload,
  pickCompanyMatch,
} from "./crustdata.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const enrich = fixture("crustdata-company-enrich.json");
const watcher = fixture("crustdata-watcher-job-change.json");
const NOW = new Date("2026-09-19T12:00:00Z");
const target = {
  company: { id: "co_1", name: "Northwind Example", domain: "northwind.example.com" },
};

function provider(fake: FakeSafeFetch) {
  const fetch = fake as unknown as typeof globalThis.fetch;
  return createCrustdata({ apiKey: "test-key", fetch, now: () => NOW });
}

describe("crustdata mapping", () => {
  it("picks only confident matches", () => {
    expect(pickCompanyMatch(enrich)).toMatchObject({ crustdata_company_id: 700001 });
    expect(
      pickCompanyMatch([{ matches: [{ confidence_score: 0.5, company_data: { a: 1 } }] }]),
    ).toBeNull();
    // The documented answer is an array: anything else is malformed, never "no match".
    expect(() => pickCompanyMatch({ not: "an array" })).toThrow(/unexpected response/);
  });

  it("emits headcount growth only above the 20% six month threshold", () => {
    const low = mapHeadcount(
      { headcount: { total: 50, growth_percent: { six_months: 12 } } },
      "a.example.com",
      NOW,
    );
    expect(low).toEqual([]);
    const high = mapHeadcount(
      { headcount: { total: 50, growth_percent: { six_months: 40 } } },
      "a.example.com",
      NOW,
    );
    expect(high[0]).toMatchObject({
      definition_key: "headcount_growth",
      title: "Headcount up 40% in 6 months (50 people)",
      strength: 1,
      evidence_url: "https://a.example.com",
      dedupe_key: "crustdata:headcount:a.example.com:2026-09",
    });
  });

  it("maps watcher job changes to job_change on the person", () => {
    const signals = mapWatcherPayload(watcher);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      definition_key: "job_change",
      title: "Jordan Example started as VP Sales at Globex Example",
      evidence_url: "https://www.linkedin.com/in/jordan-example",
      person: { linkedin_url: "https://www.linkedin.com/in/jordan-example" },
      company: { name: "Globex Example" },
      occurred_at: "2026-09-01T00:00:00.000Z",
    });
    expect(mapWatcherPayload({ results: "nope" })).toEqual([]);
  });
});

describe("crustdata provider", () => {
  it("enriches by domain with the version header and maps every signal type", async () => {
    const fetch = createFakeFetch([
      {
        match: `${CRUSTDATA_BASE_URL}/company/enrich`,
        method: "POST",
        response: { json: enrich },
      },
    ]);
    const signals = await provider(fetch).collect(target, {
      since: new Date("2026-09-01T00:00:00Z"),
    });
    expect(signals.map((signal) => signal.definition_key).sort()).toEqual([
      "funding_round",
      "headcount_growth",
      "hiring_relevant_roles",
      "news_mention",
    ]);
    const funding = signals.find((signal) => signal.definition_key === "funding_round");
    expect(funding?.title).toBe("Raised $25M (series b)");
    expect(funding?.evidence_url).toBe("https://www.linkedin.com/company/northwind-example");
    const request = fetch.calls[0];
    const headers = request?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["x-api-version"]).toBe(CRUSTDATA_API_VERSION);
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      domains: ["northwind.example.com"],
      fields: ["basic_info", "headcount", "funding", "hiring"],
      exact_match: true,
    });
  });

  it("filters to the requested keys and skips companies without a domain", async () => {
    const fetch = createFakeFetch([
      { match: `${CRUSTDATA_BASE_URL}/company/enrich`, response: { json: enrich } },
    ]);
    const instance = provider(fetch);
    const signals = await instance.collect(target, { signalKeys: ["headcount_growth"] });
    expect(signals.map((signal) => signal.definition_key)).toEqual(["headcount_growth"]);
    expect(await instance.collect({ company: { id: "co_2", name: "No Domain" } })).toEqual([]);
    expect(await instance.collect(target, { signalKeys: ["tech_adopted"] })).toEqual([]);
    expect(fetch.calls).toHaveLength(1);
  });

  it("returns nothing when no company matches", async () => {
    const fetch = createFakeFetch([
      { match: `${CRUSTDATA_BASE_URL}/company/enrich`, response: { json: [] } },
    ]);
    expect(await provider(fetch).collect(target)).toEqual([]);
  });

  it("maps 402 to an out-of-credits error without leaking the key", async () => {
    const fetch = createFakeFetch([
      {
        match: `${CRUSTDATA_BASE_URL}/company/enrich`,
        response: { status: 402, json: { error: { type: "insufficient_credits" } } },
      },
    ]);
    let error: unknown;
    try {
      await provider(fetch).collect(target);
    } catch (caught) {
      error = caught;
    }
    expect(isOpenOutboundError(error)).toBe(true);
    if (!isOpenOutboundError(error)) return;
    expect(error.details).toMatchObject({
      provider: "crustdata",
      failure: { class: "quota_exhausted", retryable: false },
    });
    expect(JSON.stringify(error)).not.toContain("test-key");
  });

  it("parses watcher webhooks and checks credentials for free", async () => {
    const fetch = createFakeFetch([
      { match: `${CRUSTDATA_BASE_URL}/account/credits`, response: { json: { credits: 1200 } } },
    ]);
    const instance = provider(fetch);
    expect(await instance.parseWebhook?.(watcher, {})).toHaveLength(1);
    expect(await crustdataProvider.test?.(instance)).toEqual({
      ok: true,
      message: "Connected, 1200 credits left.",
    });

    const denied = provider(
      createFakeFetch([
        { match: `${CRUSTDATA_BASE_URL}/account/credits`, response: { status: 401 } },
      ]),
    );
    expect(await crustdataProvider.test?.(denied)).toEqual({
      ok: false,
      message: "Crustdata returned HTTP 401.",
    });
  });
});
