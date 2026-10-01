import { describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import type { ProviderRuntime } from "../../providers/types.js";
import { allCompanies, WORLD } from "../world/index.js";
import { createSandboxResearch } from "./research.js";

function runtime(): ProviderRuntime {
  return {
    fetch: fetch,
    safeFetch: (() => {
      throw new Error("not used");
    }) as unknown as ProviderRuntime["safeFetch"],
    log: { info: () => {}, warn: () => {}, error: () => {} } as unknown as ProviderRuntime["log"],
    clock: fixedClock(),
    baseUrl: "http://localhost:7331",
    workspaceId: "ws_test",
    db: {} as ProviderRuntime["db"],
  };
}

describe("sandbox research provider", () => {
  it("is deterministic for the same query", async () => {
    const research = createSandboxResearch(runtime());
    const a = await research.search("forecasting");
    const b = await research.search("forecasting");
    expect(a).toEqual(b);
  });

  it("search finds a known company's page and fetch returns its exact text", async () => {
    const research = createSandboxResearch(runtime());
    const company = allCompanies().find((c) => c.status !== "competitor");
    expect(company).toBeDefined();
    if (!company) return;

    const results = await research.search(company.name);
    expect(results.length).toBeGreaterThan(0);
    const home = results.find((r) => r.url === `https://${company.domain}/`);
    expect(home).toBeDefined();

    const fetched = await research.fetch?.(`https://${company.domain}/`);
    expect(fetched?.title).toBe(company.name);
    expect(fetched?.text).toContain(company.name);
    expect(fetched?.url).toBe(`https://${company.domain}/`);
  });

  it("fetch throws an actionable provider_error for an unknown URL", async () => {
    const research = createSandboxResearch(runtime());
    await expect(
      research.fetch?.("https://not-a-real-page.example.com/nope"),
    ).rejects.toMatchObject({
      code: "provider_error",
    });
  });

  it("respects the includeDomains option", async () => {
    const research = createSandboxResearch(runtime());
    const newsSignal = Object.values(WORLD)
      .flatMap((w) => w.signals)
      .find((s) => new URL(s.raw.evidence_url).hostname === "news.example.com");
    expect(newsSignal).toBeDefined();
    const queryWord =
      newsSignal?.raw.title.split(/\s+/).find((word) => word.length > 4) ??
      newsSignal?.raw.title ??
      "";

    const all = await research.search(queryWord, { limit: 50 });
    expect(all.length).toBeGreaterThan(0);

    const onlyNews = await research.search(queryWord, {
      limit: 50,
      includeDomains: ["news.example.com"],
    });
    expect(onlyNews.length).toBeGreaterThan(0);
    expect(onlyNews.every((r) => new URL(r.url).hostname === "news.example.com")).toBe(true);
  });
});
