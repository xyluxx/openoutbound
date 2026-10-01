import { describe, expect, it } from "vitest";
import { addressFromLines, extractBusinessDetails } from "./business.js";

describe("extractBusinessDetails", () => {
  it("reads schema.org JSON-LD first", () => {
    const html = `<html><head><title>Home | Something Else</title>
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
        {"@type":"WebSite","name":"Site name"},
        {"@type":["Dentist","LocalBusiness"],"name":"Brightsmile Dental Studio","telephone":"+1 512-555-0101",
         "address":{"@type":"PostalAddress","streetAddress":"100 Sample Ave","addressLocality":"Austin","addressRegion":"TX","postalCode":"78701","addressCountry":"US"}}
      ]}</script></head><body><p>Welcome</p></body></html>`;
    expect(extractBusinessDetails(html, "https://brightsmile.test/")).toEqual({
      name: "Brightsmile Dental Studio",
      address: "100 Sample Ave, 78701 Austin",
      city: "Austin",
      postal_code: "78701",
      region: "TX",
      country: "US",
      phone: "+1 512-555-0101",
      source_url: "https://brightsmile.test/",
    });
  });

  it("falls back to og:site_name, the title, tel: links and address blocks", () => {
    const html = `<html><head><title>Startseite - Zahnarztpraxis Sonnenweg</title></head>
      <body><a href="tel:%2B49%2030%201234567">Call</a>
      <address>Sonnenweg 12<br>10115 Berlin</address></body></html>`;
    expect(extractBusinessDetails(html, "https://sonnenweg.test/kontakt")).toMatchObject({
      name: "Zahnarztpraxis Sonnenweg",
      phone: "+49 30 1234567",
      address: "Sonnenweg 12, 10115 Berlin",
      city: "Berlin",
      postal_code: "10115",
    });
    const withSiteName = `<html><head><meta property="og:site_name" content="Hillside Dental Care">
      <title>Contact us | Hillside</title></head><body></body></html>`;
    expect(extractBusinessDetails(withSiteName, "https://hillside.test/").name).toBe(
      "Hillside Dental Care",
    );
  });

  it("ignores broken JSON-LD and too short phone numbers", () => {
    const html = `<html><head><script type="application/ld+json">{not json</script>
      <title>Lakeview Orthodontics</title></head><body><a href="tel:123">x</a></body></html>`;
    expect(extractBusinessDetails(html, "https://lakeview.test/")).toMatchObject({
      name: "Lakeview Orthodontics",
      phone: null,
      address: null,
    });
  });
});

describe("addressFromLines", () => {
  it("reads European and US address lines", () => {
    expect(
      addressFromLines(
        "Impressum\nPraxis Dr. Jens Mueller\nHauptstrasse 5a\n80331 Muenchen\nTel 089 1234",
      ),
    ).toEqual({
      address: "Hauptstrasse 5a, 80331 Muenchen",
      postal_code: "80331",
      city: "Muenchen",
    });
    expect(addressFromLines("Visit us\n22 Sample St\nAustin, TX 78702")).toEqual({
      address: "22 Sample St, Austin, TX 78702",
      city: "Austin",
      region: "TX",
      postal_code: "78702",
      country: "US",
    });
    expect(addressFromLines("No address here")).toEqual({});
  });
});
