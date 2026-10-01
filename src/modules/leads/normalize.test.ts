import { describe, expect, it } from "vitest";
import {
  buildNames,
  cleanText,
  companyDomainFrom,
  emailDomain,
  isFreeMailDomain,
  normalizeCompanyLinkedin,
  normalizeCountry,
  normalizeEmail,
  normalizePersonLinkedin,
  normalizeTags,
  normalizeWebsite,
  parseBoolean,
  parseEmployees,
  parseLocation,
} from "./normalize.js";

describe("normalizeEmail", () => {
  it.each([
    ["  Dana.Reyes@Harbor-Dental.example.com ", "dana.reyes@harbor-dental.example.com"],
    ["mailto:omar@example.org?subject=Hi", "omar@example.org"],
    ["Dana Reyes <DANA@example.com>", "dana@example.com"],
    ["priya+sales@example.com.", "priya+sales@example.com"],
    ["info@bäckerei.example", "info@xn--bckerei-5wa.example"],
    ["not an email", null],
    ["@example.com", null],
    ["dana@", null],
    ["dana..reyes@example.com", null],
    ["dana@localhost", null],
    ["", null],
    ["N/A", null],
    [null, null],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it("extracts the domain", () => {
    expect(emailDomain("dana@harbor.example.com")).toBe("harbor.example.com");
    expect(emailDomain(null)).toBeNull();
  });
});

describe("websites and company domains", () => {
  it.each([
    ["https://www.Harbor-Dental.example.com/about?x=1", "harbor-dental.example.com"],
    ["www.lumenhome.example.com", "lumenhome.example.com"],
    ["http://shop.example.org:8080/path", "shop.example.org"],
    ["https://www.Bäckerei-Müller.example/impressum", "xn--bckerei-mller-bfb28a.example"],
    ["not a url with spaces", null],
    ["dana@example.com", null],
    ["ftp://files.example.com", null],
  ])("%s -> %s", (input, domain) => {
    expect(normalizeWebsite(input).domain).toBe(domain);
  });

  it("adds a scheme to bare websites", () => {
    expect(normalizeWebsite("www.example.org/team").website).toBe("https://www.example.org/team");
  });

  it("never turns free-mail domains into company domains", () => {
    expect(companyDomainFrom({ email: "dana@gmail.com" })).toBeNull();
    expect(companyDomainFrom({ email: "dana@hotmail.co.uk" })).toBeNull();
    expect(companyDomainFrom({ website: "gmail.com" })).toBeNull();
    expect(companyDomainFrom({ email: "dana@harbor.example.com" })).toBe("harbor.example.com");
    expect(companyDomainFrom({ domain: "Harbor.example.com", email: "x@other.example.com" })).toBe(
      "harbor.example.com",
    );
    expect(isFreeMailDomain("gmx.de")).toBe(true);
    expect(isFreeMailDomain("outlook.com")).toBe(true);
    expect(isFreeMailDomain("yahoo.co.uk")).toBe(true);
    expect(isFreeMailDomain("harbor.example.com")).toBe(false);
  });
});

describe("LinkedIn URLs", () => {
  it.each([
    ["https://www.linkedin.com/in/Dana-Reyes/", "https://www.linkedin.com/in/dana-reyes"],
    ["linkedin.com/in/dana-reyes?trk=public_profile", "https://www.linkedin.com/in/dana-reyes"],
    [
      "https://de.linkedin.com/in/lukas-becker-1a2b3c4d",
      "https://www.linkedin.com/in/lukas-becker-1a2b3c4d",
    ],
    [
      "http://m.linkedin.com/in/mei-chen/details/experience/",
      "https://www.linkedin.com/in/mei-chen",
    ],
    [
      "https://www.linkedin.com/pub/jonas-larsen/2/3a4/5b6",
      "https://www.linkedin.com/in/jonas-larsen-5b63a402",
    ],
    ["https://www.linkedin.com/company/harbor-dental", null],
    ["https://example.com/in/dana", null],
    ["", null],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePersonLinkedin(input)).toBe(expected);
  });

  it("keeps company pages for companies only", () => {
    expect(normalizeCompanyLinkedin("https://www.linkedin.com/company/Harbor-Dental/about/")).toBe(
      "https://www.linkedin.com/company/harbor-dental",
    );
    expect(normalizeCompanyLinkedin("https://www.linkedin.com/in/dana")).toBeNull();
  });
});

describe("normalizeCountry", () => {
  it.each([
    ["Germany", "DE"],
    ["Deutschland", "DE"],
    ["DEU", "DE"],
    ["de", "DE"],
    ["Österreich", "AT"],
    ["United States", "US"],
    ["U.S.A.", "US"],
    ["USA", "US"],
    ["UK", "GB"],
    ["England", "GB"],
    ["United Kingdom", "GB"],
    ["España", "ES"],
    ["Côte d'Ivoire", "CI"],
    ["Czech Republic", "CZ"],
    ["The Netherlands", "NL"],
    ["Schweiz", "CH"],
    ["Atlantis", null],
    ["", null],
    [null, null],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeCountry(input)).toBe(expected);
  });
});

describe("names", () => {
  it("splits full names when parts are missing", () => {
    expect(buildNames({ full_name: "Dr. Dana Reyes, DDS" })).toEqual({
      first_name: "Dana",
      last_name: "Reyes",
      full_name: "Dr. Dana Reyes, DDS",
    });
    expect(buildNames({ first_name: "Omar", last_name: "Haddad" })).toEqual({
      first_name: "Omar",
      last_name: "Haddad",
      full_name: "Omar Haddad",
    });
    expect(buildNames({ full_name: "Cher" })).toEqual({
      first_name: "Cher",
      last_name: null,
      full_name: "Cher",
    });
    expect(buildNames({})).toEqual({ first_name: null, last_name: null, full_name: null });
  });
});

describe("small parsers", () => {
  it("parses employee counts and ranges", () => {
    expect(parseEmployees("25")).toEqual({ count: 25, range: null, estimate: 25 });
    expect(parseEmployees("11-50")).toEqual({ count: null, range: "11-50", estimate: 31 });
    expect(parseEmployees("1,001 - 5,000")).toEqual({
      count: null,
      range: "1001-5000",
      estimate: 3001,
    });
    expect(parseEmployees("10000+")).toEqual({ count: null, range: "10000+", estimate: 10000 });
    expect(parseEmployees("lots")).toEqual({ count: null, range: null, estimate: null });
  });

  it("parses booleans, tags and text", () => {
    expect(parseBoolean("Ja")).toBe(true);
    expect(parseBoolean("no")).toBe(false);
    expect(parseBoolean("maybe")).toBeNull();
    expect(normalizeTags("Dental; VIP, dental ,")).toEqual(["dental", "vip"]);
    expect(cleanText("  -  ")).toBeNull();
    expect(cleanText(" Harbor   Dental ")).toBe("Harbor Dental");
  });

  it("splits locations without guessing ambiguous codes", () => {
    expect(parseLocation("Berlin, Germany")).toEqual({
      city: "Berlin",
      region: null,
      country: "DE",
    });
    expect(parseLocation("Austin, Texas, United States")).toEqual({
      city: "Austin",
      region: "Texas",
      country: "US",
    });
    expect(parseLocation("Austin, TX")).toEqual({ city: "Austin", region: "TX", country: "US" });
    expect(parseLocation("Dover, DE")).toEqual({ city: "Dover", region: "DE", country: null });
    expect(parseLocation("Munich, DE, Germany").country).toBe("DE");
    expect(parseLocation("France")).toEqual({ city: null, region: null, country: "FR" });
  });
});
