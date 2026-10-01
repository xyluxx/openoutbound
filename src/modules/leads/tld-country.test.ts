import { describe, expect, it } from "vitest";
import { countryFromDomain, countryFromEmail } from "./tld-country.js";

describe("countryFromEmail", () => {
  it.each([
    ["dana@praxis-sonnenweg.de", "DE"],
    ["x@kanzlei.at", "AT"],
    ["x@studio.it", "IT"],
    ["x@clinica.es", "ES"],
    ["x@tandarts.nl", "NL"],
    ["x@klinik.dk", "DK"],
    ["x@gabinet.pl", "PL"],
    ["x@praktijk.be", "BE"],
    ["x@clinic.ca", "CA"],
    ["x@clinic.com.au", "AU"],
    ["x@clinic.au", "AU"],
    ["x@studio.co.uk", "GB"],
    ["x@council.uk", "GB"],
    ["x@cabinet.fr", "FR"],
    ["X@Praxis.DE", "DE"],
  ])("%s gives %s", (email, country) => {
    expect(countryFromEmail(email)).toBe(country);
  });

  it("keeps generic and brand-style TLDs unknown", () => {
    for (const email of [
      "a@shop.com",
      "a@charity.org",
      "a@isp.net",
      "a@startup.io",
      "a@brand.co",
      "a@lab.ai",
      "a@me.me",
      "a@stream.tv",
      "a@bit.ly",
      "a@agency.eu",
      "a@shop.store",
    ]) {
      expect(countryFromEmail(email), email).toBeNull();
    }
    expect(countryFromEmail(null)).toBeNull();
    expect(countryFromEmail("not-an-email")).toBeNull();
    expect(countryFromDomain("clinic.de.")).toBe("DE");
    expect(countryFromDomain("")).toBeNull();
  });
});
