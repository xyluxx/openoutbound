/**
 * Fake ctx.dns for tests: answers from records set per name; every other name fails with
 * ENOTFOUND, like an invented domain on real DNS. Records every name looked up.
 *
 *   ctx.dns.set("acme.example.com", { mx: ["aspmx.l.google.com"], txt: ["v=spf1 -all"] });
 */
import type { DnsResolver } from "../core/context.js";

export interface FakeDnsRecords {
  /** MX hosts, in priority order. */
  mx?: string[];
  /** TXT records, one string each. */
  txt?: string[];
}

export interface FakeDns extends DnsResolver {
  /** Sets (replaces) the records a name answers with. */
  set(name: string, records: FakeDnsRecords): void;
  /** Names looked up, in call order (`mx:<name>` or `txt:<name>`). */
  readonly lookups: string[];
}

function notFound(query: string, name: string): Error {
  return Object.assign(new Error(`${query} ENOTFOUND ${name}`), {
    code: "ENOTFOUND",
    hostname: name,
  });
}

export function createFakeDns(initial: Record<string, FakeDnsRecords> = {}): FakeDns {
  const records = new Map<string, FakeDnsRecords>();
  const key = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");
  for (const [name, value] of Object.entries(initial)) records.set(key(name), value);
  const lookups: string[] = [];
  return {
    lookups,
    set(name, value) {
      records.set(key(name), value);
    },
    async resolveMx(domain) {
      lookups.push(`mx:${key(domain)}`);
      const found = records.get(key(domain));
      if (!found?.mx) throw notFound("queryMx", domain);
      return found.mx.map((exchange, index) => ({ exchange, priority: (index + 1) * 10 }));
    },
    async resolveTxt(name) {
      lookups.push(`txt:${key(name)}`);
      const found = records.get(key(name));
      if (!found?.txt) throw notFound("queryTxt", name);
      return found.txt.map((record) => [record]);
    },
  };
}
