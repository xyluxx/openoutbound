import { describe, expect, it } from "vitest";
import type { DnsResolver } from "../../core/context.js";
import { checkDomainDns } from "./dns-check.js";

const NOW = new Date("2026-09-21T16:00:00Z");

function notFound(): Error {
  return Object.assign(new Error("queryTxt ENODATA"), { code: "ENODATA" });
}

/** Resolver answering from a table: name -> TXT records (or an MX list for the domain). */
function stub(input: {
  mx?: Array<{ exchange: string; priority: number }> | Error;
  txt?: Record<string, string[] | Error>;
}): DnsResolver {
  return {
    async resolveMx() {
      if (input.mx instanceof Error) throw input.mx;
      if (!input.mx) throw notFound();
      return input.mx;
    },
    async resolveTxt(name) {
      const value = input.txt?.[name];
      if (value instanceof Error) throw value;
      if (!value) throw notFound();
      // Long TXT records arrive in 255-byte chunks.
      return value.map((record) => [record.slice(0, 20), record.slice(20)]);
    },
  };
}

const statuses = (result: Awaited<ReturnType<typeof checkDomainDns>>) =>
  Object.fromEntries(result.checks.map((check) => [check.name, check.status]));

describe("checkDomainDns", () => {
  it("is green for a well configured Google Workspace domain", async () => {
    const result = await checkDomainDns(
      "brand.example.com",
      stub({
        mx: [
          { exchange: "alt1.aspmx.l.google.com", priority: 5 },
          { exchange: "aspmx.l.google.com", priority: 1 },
        ],
        txt: {
          "brand.example.com": [
            "v=spf1 include:_spf.google.com ~all",
            "google-site-verification=x",
          ],
          "google._domainkey.brand.example.com": ["v=DKIM1; k=rsa; p=MIIBIjANBgkq"],
          "_dmarc.brand.example.com": ["v=DMARC1; p=quarantine; rua=mailto:d@brand.example.com"],
        },
      }),
      { provider: "google", now: NOW },
    );
    expect(result.overall).toBe("green");
    expect(statuses(result)).toEqual({ mx: "green", spf: "green", dkim: "green", dmarc: "green" });
    expect(result.checks[0]?.records).toEqual([
      "1 aspmx.l.google.com",
      "5 alt1.aspmx.l.google.com",
    ]);
    expect(result.checked_at).toBe(NOW.toISOString());
  });

  it("flags missing MX and SPF as red with fixes", async () => {
    const result = await checkDomainDns("bare.example.com", stub({}), {
      provider: "google",
      now: NOW,
    });
    expect(result.overall).toBe("red");
    const spf = result.checks.find((check) => check.name === "spf");
    expect(spf).toMatchObject({ status: "red" });
    expect(spf?.fix).toContain("v=spf1 include:_spf.google.com ~all");
    expect(result.checks.find((check) => check.name === "dkim")?.summary).toContain("not proof");
    expect(result.checks.find((check) => check.name === "dmarc")?.status).toBe("yellow");
  });

  it("warns on several SPF records, +all, a missing provider include and p=none", async () => {
    const result = await checkDomainDns(
      "mixed.example.com",
      stub({
        mx: [{ exchange: "mx.mixed.example.com", priority: 10 }],
        txt: {
          "mixed.example.com": ["v=spf1 include:mailgun.org +all", "v=spf1 -all"],
          "selector1._domainkey.mixed.example.com": ["v=DKIM1; p=abc"],
          "_dmarc.mixed.example.com": ["v=DMARC1; p=none"],
        },
      }),
      { provider: "microsoft", now: NOW },
    );
    const spf = result.checks.find((check) => check.name === "spf");
    expect(spf?.status).toBe("yellow");
    expect(spf?.summary).toContain("more than one SPF record");
    expect(spf?.summary).toContain("+all");
    expect(spf?.summary).toContain("include:spf.protection.outlook.com");
    expect(statuses(result)).toMatchObject({ dkim: "green", dmarc: "yellow" });
    expect(result.overall).toBe("yellow");
  });

  it("reads a server failure (SERVFAIL) as a failed lookup, not as a missing record", async () => {
    const servfail = Object.assign(new Error("queryMx ESERVFAIL"), { code: "ESERVFAIL" });
    const result = await checkDomainDns(
      "broken-dns.example.com",
      stub({ mx: servfail, txt: { "broken-dns.example.com": servfail } }),
      { now: NOW },
    );
    const mx = result.checks.find((check) => check.name === "mx");
    expect(mx).toMatchObject({ status: "yellow", lookup_failed: true });
    expect(result.checks.find((check) => check.name === "spf")).toMatchObject({
      status: "yellow",
      lookup_failed: true,
    });
  });

  it("reports DNS errors as yellow instead of failing", async () => {
    const servfail = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    const result = await checkDomainDns(
      "flaky.example.com",
      stub({
        mx: servfail,
        txt: {
          "flaky.example.com": servfail,
          "google._domainkey.flaky.example.com": servfail,
          "_dmarc.flaky.example.com": servfail,
        },
      }),
      { now: NOW },
    );
    expect(statuses(result)).toEqual({
      mx: "yellow",
      spf: "yellow",
      dkim: "yellow",
      dmarc: "yellow",
    });
    // Marked, so the daily check does not take a slow resolver for a broken record.
    expect(result.checks.every((check) => check.lookup_failed)).toBe(true);
    expect(result.checks.find((check) => check.name === "dkim")?.summary).toBe(
      "DKIM lookup failed (DNS error) for selector google.",
    );
  });
});
