import { describe, expect, it } from "vitest";
import { parseWorkspaceSettings } from "../../core/settings.js";
import {
  buildRawMessage,
  buildReferences,
  newMessageIdHeader,
  type OutgoingEmail,
  replySubject,
  singleRecipient,
  unsubscribeHeaders,
} from "./compose.js";
import { buildFooter, isGdprRecipient, sourceLabel } from "./footer.js";
import { renderEmail, renderTemplate } from "./render.js";
import { unsubscribeReadiness } from "./service.js";

const settings = parseWorkspaceSettings({
  company: {
    name: "Helix Outbound",
    postal_address: "12 Harbor Road, Austin, TX 78701, USA",
  },
});
const URL = "https://engine.example.com/u/token123";

describe("renderTemplate", () => {
  it("fills variables, custom fields and fallbacks", () => {
    const result = renderTemplate(
      "Hi {{first_name|there}}, {{ company }} in {{custom.city_area}} ({{title|}}).",
      { first_name: "Dana", company: "Harbor Dental", custom: { city_area: "Austin" } },
    );
    expect(result).toEqual({ text: "Hi Dana, Harbor Dental in Austin ().", missing: [] });
    expect(renderTemplate("Hi {{first_name|there}}", { first_name: "  " }).text).toBe("Hi there");
  });

  it("reports unresolved variables and AI slots instead of guessing", () => {
    const result = renderTemplate("Hi {{first_name}}, [[ai: one line about their clinic]]", {});
    expect(result.text).toBe("Hi {{first_name}}, [[ai: one line about their clinic]]");
    expect(result.missing).toEqual(["first_name", "[[ai: one line about their clinic]]"]);
  });

  it("escapes values for HTML", () => {
    const html = renderTemplate("<p>{{company}}</p>", { company: "A&B <Dental>" }, (value) =>
      value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    );
    expect(html.text).toBe("<p>A&amp;B &lt;Dental&gt;</p>");
  });
});

describe("footer", () => {
  it("adds identity, ad disclosure and unsubscribe for US recipients", () => {
    expect(
      buildFooter(settings, {
        country: "US",
        email: "dana@harbor.example.com",
        source: "apollo",
        unsubscribeUrl: URL,
      }),
    ).toEqual({
      identity: "Helix Outbound, 12 Harbor Road, Austin, TX 78701, USA",
      adDisclosure: "This is a commercial message.",
      unsubscribeUrl: URL,
      unsubscribeByReply: false,
      sourceNotice: null,
    });
  });

  it("includes the ad disclosure when the country is unknown", () => {
    const footer = buildFooter(settings, {
      country: null,
      email: "dana@harbor.example.com",
      source: null,
      unsubscribeUrl: URL,
    });
    expect(footer.adDisclosure).toBe("This is a commercial message.");
  });

  it("adds the GDPR source notice for EU recipients and no US disclosure", () => {
    const footer = buildFooter(settings, {
      country: "de",
      email: "lukas@praxis.example.org",
      source: "google_maps",
      unsubscribeUrl: URL,
    });
    expect(footer.adDisclosure).toBeNull();
    expect(footer.sourceNotice).toBe(
      "Data source: your public business listing. We contact you based on legitimate interest (GDPR Art. 6(1)(f)); reply or use the unsubscribe link to object.",
    );
    expect(isGdprRecipient(null, "anna@firma.de")).toBe(true);
    expect(isGdprRecipient(null, "anna@firma.co.uk")).toBe(true);
    expect(isGdprRecipient("CH", "anna@firma.de")).toBe(false);
    expect(sourceLabel("csv_import")).toBe("a business contact list we compiled");
  });

  it("always keeps the unsubscribe line and postal address in prospect email", () => {
    // The two switches only apply to system and notification email.
    const off = parseWorkspaceSettings({
      company: { name: "Helix Outbound", postal_address: "12 Harbor Road" },
      compliance: {
        include_unsubscribe_link: false,
        include_postal_address: false,
        gdpr_source_notice: false,
        ad_disclosure: { countries: ["US", "CA"], text: "Advertisement." },
      },
    });
    expect(
      buildFooter(off, {
        country: "CA",
        email: "a@b.example.com",
        source: null,
        unsubscribeUrl: URL,
      }),
    ).toEqual({
      identity: "Helix Outbound, 12 Harbor Road",
      adDisclosure: "Advertisement.",
      unsubscribeUrl: URL,
      unsubscribeByReply: false,
      sourceNotice: null,
    });
  });

  it("asks recipients to reply unsubscribe when there is no public link", () => {
    const footer = buildFooter(settings, {
      country: "DE",
      email: "lukas@praxis.example.org",
      source: "apollo",
      unsubscribeUrl: null,
    });
    expect(footer).toMatchObject({ unsubscribeUrl: null, unsubscribeByReply: true });
    expect(footer.sourceNotice).toContain("reply to object.");
    const rendered = renderEmail({
      subject: "Hi",
      bodyText: "Hello",
      vars: {},
      footer,
      html: true,
    });
    expect(rendered.text).toContain('Prefer not to hear from us? Reply "unsubscribe" to opt out.');
    expect(rendered.text).not.toContain("http");
    expect(rendered.html).toContain(
      "Prefer not to hear from us? Reply &quot;unsubscribe&quot; to opt out.",
    );
    expect(rendered.html).not.toContain("<a href");
  });
});

describe("renderEmail", () => {
  const footer = buildFooter(settings, {
    country: "US",
    email: "dana@harbor.example.com",
    source: "apollo",
    unsubscribeUrl: URL,
  });

  it("renders plain text with signature and footer (golden)", () => {
    const rendered = renderEmail({
      subject: "Quick question, {{first_name}}",
      bodyText:
        "Hi {{first_name}},\r\n\r\nSaw that {{company}} opened a second clinic.\n\nWorth a chat?",
      vars: { first_name: "Dana", company: "Harbor Dental" },
      signature: "Sam Carter\nHelix Outbound",
      footer,
    });
    expect(rendered.html).toBeNull();
    expect(rendered.missing).toEqual([]);
    expect(rendered.subject).toBe("Quick question, Dana");
    expect(rendered.text).toMatchInlineSnapshot(`
      "Hi Dana,

      Saw that Harbor Dental opened a second clinic.

      Worth a chat?

      Sam Carter
      Helix Outbound

      Helix Outbound, 12 Harbor Road, Austin, TX 78701, USA
      This is a commercial message.
      Prefer not to hear from us? Unsubscribe: https://engine.example.com/u/token123"
    `);
  });

  it("does not repeat a signature the body already has", () => {
    const rendered = renderEmail({
      subject: "Hi",
      bodyText: "Hello\n\nSam Carter",
      vars: {},
      signature: "Sam Carter",
      footer: {},
    });
    expect(rendered.text).toBe("Hello\n\nSam Carter");
  });

  it("only builds HTML when asked or when an HTML body exists", () => {
    const base = { subject: "Hi", bodyText: "Line one\nline two", vars: {}, footer };
    expect(renderEmail(base).html).toBeNull();
    const html = renderEmail({ ...base, html: true }).html ?? "";
    expect(html).toContain("Line one<br>line two");
    expect(html).toContain(`<a href="${URL}">`);
    expect(html).not.toMatch(/<img|track|pixel/i);
    const custom = renderEmail({ ...base, bodyHtml: "<p>Hi {{first_name|there}}</p>" }).html;
    expect(custom).toContain("<p>Hi there</p>");
  });
});

describe("headers", () => {
  it("builds List-Unsubscribe with one-click only for https", () => {
    expect(unsubscribeHeaders(URL, "sam@brand.example.com")).toEqual({
      "List-Unsubscribe": `<${URL}>, <mailto:sam@brand.example.com?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(unsubscribeHeaders("http://localhost:7331/u/x", null)).toEqual({
      "List-Unsubscribe": "<http://localhost:7331/u/x>",
    });
    expect(unsubscribeHeaders(null, null)).toEqual({});
    // No public link: the mailto stays, One-Click goes.
    expect(unsubscribeHeaders(null, "sam@brand.example.com")).toEqual({
      "List-Unsubscribe": "<mailto:sam@brand.example.com?subject=unsubscribe>",
    });
  });

  it("allows one-click only from a public https base URL", () => {
    expect(unsubscribeReadiness({ baseUrl: "https://engine.example.com" })).toEqual({
      one_click: true,
      reason: null,
    });
    for (const baseUrl of [
      "http://localhost:7331",
      "http://engine.example.com",
      "https://localhost:7331",
      "https://10.0.0.5",
      "https://engine.internal",
      "not a url",
    ]) {
      const readiness = unsubscribeReadiness({ baseUrl });
      expect(readiness.one_click, baseUrl).toBe(false);
      expect(readiness.reason).toContain("OPENOUTBOUND_BASE_URL");
    }
  });

  it("accepts exactly one plain recipient address", () => {
    expect(singleRecipient(" Dana@Harbor.Example.com ")).toBe("dana@harbor.example.com");
    expect(singleRecipient("o'neil@harbor.example.com")).toBe("o'neil@harbor.example.com");
    for (const value of [
      "dana@harbor.example.com, lee@harbor.example.com",
      "dana@harbor.example.com;lee@harbor.example.com",
      "dana@harbor.example.com lee@harbor.example.com",
      "Dana <dana@harbor.example.com>",
      '"Dana" <dana@harbor.example.com>',
      "dana@harbor.example.com (Dana)",
      "dana@lee@harbor.example.com",
      "group: dana@harbor.example.com;",
      "dana@localhost",
      "dana@harbor..example.com",
      "@harbor.example.com",
      "",
      null,
    ]) {
      expect(singleRecipient(value), String(value)).toBeNull();
    }
  });

  it("threads replies without stacking prefixes", () => {
    expect(replySubject("Quick question")).toBe("Re: Quick question");
    expect(replySubject("RE: Re: AW: Quick question")).toBe("Re: Quick question");
    expect(replySubject(null)).toBe("Re:");
    expect(buildReferences(["<a@x>", "<b@x>", "<a@x>"])).toEqual(["<a@x>", "<b@x>"]);
    const long = Array.from({ length: 14 }, (_, i) => `<${i}@x>`);
    const refs = buildReferences(long);
    expect(refs).toHaveLength(10);
    expect(refs[0]).toBe("<0@x>");
    expect(refs.at(-1)).toBe("<13@x>");
  });

  it("puts the Message-ID on the mailbox domain", () => {
    expect(newMessageIdHeader("Sam@Brand.Example.com", new Date("2026-09-21T15:00:00Z"))).toMatch(
      /^<[0-9a-z]+\.[0-9a-f]{20}@brand\.example\.com>$/,
    );
  });

  it("produces the expected RFC 5322 source (golden)", async () => {
    const email: OutgoingEmail = {
      from: { name: "Sam Carter", address: "sam@brand.example.com" },
      to: ["dana@harbor.example.com"],
      subject: "Re: Quick question",
      text: "Hi Dana,\n\nFollowing up on my note.\n\nSam",
      messageId: "<mf0x1.aaaaaaaaaaaaaaaaaaaa@brand.example.com>",
      date: new Date("2026-09-21T15:00:00Z"),
      inReplyTo: "<first.bbbbbbbbbbbbbbbbbbbb@brand.example.com>",
      references: ["<first.bbbbbbbbbbbbbbbbbbbb@brand.example.com>"],
      headers: unsubscribeHeaders(URL, "sam@brand.example.com"),
    };
    const raw = await buildRawMessage(email, { baseBoundary: "golden" });
    expect(raw).not.toMatch(/^Precedence:/im);
    expect(raw).not.toMatch(/^X-Mailer:/im);
    expect(raw.replaceAll("\r\n", "\n")).toMatchInlineSnapshot(`
      "List-Unsubscribe: <https://engine.example.com/u/token123>,
       <mailto:sam@brand.example.com?subject=unsubscribe>
      List-Unsubscribe-Post: List-Unsubscribe=One-Click
      From: Sam Carter <sam@brand.example.com>
      To: dana@harbor.example.com
      In-Reply-To: <first.bbbbbbbbbbbbbbbbbbbb@brand.example.com>
      References: <first.bbbbbbbbbbbbbbbbbbbb@brand.example.com>
      Subject: Re: Quick question
      Message-ID: <mf0x1.aaaaaaaaaaaaaaaaaaaa@brand.example.com>
      Date: Mon, 21 Sep 2026 15:00:00 +0000
      Content-Transfer-Encoding: 7bit
      MIME-Version: 1.0
      Content-Type: text/plain; charset=utf-8

      Hi Dana,

      Following up on my note.

      Sam
      "
    `);
  });
});
