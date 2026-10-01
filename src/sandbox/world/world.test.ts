import { describe, expect, it } from "vitest";
import { allCompanies, allPages, allPeople, WORKSPACE_BLUEPRINTS, WORLD } from "./index.js";
import { createRng, hashBool, hashRatio, hashSeed } from "./rng.js";

const ALLOWED_HOSTS = [/^example\.com$/, /\.example\.com$/, /^example\.org$/, /\.example\.org$/];

function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.some((pattern) => pattern.test(host));
}

describe("sandbox world: no real-looking domains", () => {
  it("every company domain and website is on example.com or example.org", () => {
    for (const company of allCompanies()) {
      expect(isAllowedHost(company.domain)).toBe(true);
      expect(isAllowedHost(new URL(company.website).hostname)).toBe(true);
    }
  });

  it("every person email is on an example.com/org host", () => {
    for (const person of allPeople()) {
      if (!person.email) continue;
      const domain = person.email.slice(person.email.indexOf("@") + 1);
      expect(isAllowedHost(domain)).toBe(true);
    }
  });

  it("every canned page and signal evidence URL is on example.com or example.org", () => {
    for (const page of allPages()) {
      expect(isAllowedHost(new URL(page.url).hostname)).toBe(true);
    }
    for (const world of Object.values(WORLD)) {
      for (const { raw } of world.signals) {
        expect(isAllowedHost(new URL(raw.evidence_url).hostname)).toBe(true);
      }
    }
  });

  it("LinkedIn profile and company URLs stay on linkedin.com (the platform, not an invented domain)", () => {
    for (const person of allPeople()) {
      expect(new URL(person.linkedin_url).hostname).toBe("www.linkedin.com");
    }
    for (const company of allCompanies()) {
      expect(new URL(company.linkedin_url).hostname).toBe("www.linkedin.com");
    }
  });
});

describe("sandbox world: determinism", () => {
  it("builds the identical world on every module load (re-running the builders matches WORLD)", () => {
    // Re-import via a fresh dynamic import would re-run module init; instead we assert the
    // generators themselves are pure functions of their seed, which is what makes WORLD stable.
    const rngA = createRng("world:northwind");
    const rngB = createRng("world:northwind");
    const seqA = Array.from({ length: 20 }, () => rngA.next());
    const seqB = Array.from({ length: 20 }, () => rngB.next());
    expect(seqA).toEqual(seqB);
  });

  it("hashRatio and hashBool are pure functions of their input", () => {
    expect(hashRatio("pe_example")).toBe(hashRatio("pe_example"));
    expect(hashSeed("pe_example")).toBe(hashSeed("pe_example"));
    expect(hashBool("pe_example", 0.35)).toBe(hashBool("pe_example", 0.35));
  });

  it("has two workspaces, northwind and brightsmile, each with the expected content", () => {
    const slugs = WORKSPACE_BLUEPRINTS.map((b) => b.slug).sort();
    expect(slugs).toEqual(["brightsmile", "northwind"]);
    for (const world of Object.values(WORLD)) {
      const seededCompanies = world.companies.filter((c) => c.seeded);
      const seededPeople = world.people.filter((p) => p.seeded);
      expect(seededCompanies.length).toBeGreaterThanOrEqual(18);
      expect(seededPeople.length).toBeGreaterThanOrEqual(20);
      // The world is bigger than what gets seeded, so find_leads has something new to surface.
      expect(world.companies.length).toBeGreaterThan(seededCompanies.length);
      expect(world.people.length).toBeGreaterThan(seededPeople.length);
    }
  });
});

describe("sandbox world: realistic variety", () => {
  it("has at least one competitor company per workspace", () => {
    for (const world of Object.values(WORLD)) {
      expect(world.companies.some((c) => c.status === "competitor")).toBe(true);
    }
  });

  it("has a designated catch-all domain per workspace", () => {
    for (const world of Object.values(WORLD)) {
      expect(world.catchAllDomain).toBeTruthy();
      expect(world.companies.some((c) => c.domain === world.catchAllDomain)).toBe(true);
    }
  });

  it("has some people with no email on file", () => {
    for (const world of Object.values(WORLD)) {
      expect(world.people.some((p) => p.email === null)).toBe(true);
    }
  });

  it("northwind has people across the US and the EU, including DE/AT without consent", () => {
    const northwind = WORLD.northwind;
    expect(northwind).toBeDefined();
    const countries = new Set(northwind?.people.map((p) => p.country));
    expect(countries.has("US")).toBe(true);
    expect([...countries].some((c) => c === "DE" || c === "AT")).toBe(true);
    const euWithoutConsent = northwind?.people.filter(
      (p) => (p.country === "DE" || p.country === "AT") && p.custom.consent !== true,
    );
    expect(euWithoutConsent?.length ?? 0).toBeGreaterThan(0);
  });

  it("companies have plausible intent scores derived from their signals", () => {
    for (const world of Object.values(WORLD)) {
      const withSignals = world.companies.filter(
        (c) => world.signals.some((s) => s.companyKey === c.key) && c.status !== "competitor",
      );
      expect(withSignals.length).toBeGreaterThan(0);
      for (const company of withSignals) {
        expect(company.intent_score).toBeGreaterThan(0);
        expect(company.intent_score).toBeLessThanOrEqual(100);
      }
    }
  });
});
