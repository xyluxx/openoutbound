import type { DnsResolver } from "../../core/context.js";
import type { MailboxProviderLabel } from "../../core/enums.js";

export type CheckStatus = "green" | "yellow" | "red";

export interface DnsCheckItem {
  name: "mx" | "spf" | "dkim" | "dmarc";
  status: CheckStatus;
  summary: string;
  /** What to change, when the status is not green. */
  fix: string | null;
  records: string[];
  /** The lookup failed (DNS error, timeout): the yellow status says nothing about the record. */
  lookup_failed?: true;
}

export interface DnsCheckResult {
  domain: string;
  checked_at: string;
  overall: CheckStatus;
  checks: DnsCheckItem[];
}

/** Common DKIM selectors probed (absence of a guess is not proof there is no DKIM). */
export const DKIM_SELECTORS = ["google", "selector1", "selector2", "default", "k1", "s1", "zoho"];

const SPF_INCLUDE: Partial<
  Record<MailboxProviderLabel, { include: RegExp; example: string; name: string }>
> = {
  google: {
    include: /include:_spf\.google\.com/i,
    example: "include:_spf.google.com",
    name: "Google",
  },
  microsoft: {
    include: /include:spf\.protection\.outlook\.com/i,
    example: "include:spf.protection.outlook.com",
    name: "Microsoft 365",
  },
  zoho: {
    include: /include:(zoho(mail)?\.[a-z.]+|zcsend\.net)/i,
    example: "include:zohomail.com (or zoho.eu for EU accounts)",
    name: "Zoho",
  },
};

/**
 * Answers that mean "no such record". A server failure (SERVFAIL, not implemented, refused,
 * timeout) says nothing about the record: it is a failed lookup (`unavailable`), shown yellow.
 */
const NOT_FOUND = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

async function txt(resolver: DnsResolver, name: string): Promise<string[] | null> {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch (error) {
    if (NOT_FOUND.has(String((error as { code?: unknown }).code))) return [];
    return null;
  }
}

const rank: Record<CheckStatus, number> = { green: 0, yellow: 1, red: 2 };

/**
 * Checks MX, SPF (present, includes the provider, one record, no +all), DKIM (probe of common
 * selectors plus the provider's) and DMARC (present, policy) for a sending domain, each green,
 * yellow or red with a fix.
 */
export async function checkDomainDns(
  domain: string,
  resolver: DnsResolver,
  options: { provider?: MailboxProviderLabel; now: Date },
): Promise<DnsCheckResult> {
  const checks: DnsCheckItem[] = [];

  // MX
  let mx: Array<{ exchange: string; priority: number }> | null;
  try {
    mx = await resolver.resolveMx(domain);
  } catch (error) {
    mx = NOT_FOUND.has(String((error as { code?: unknown }).code)) ? [] : null;
  }
  if (mx === null) {
    checks.push({
      name: "mx",
      status: "yellow",
      summary: "MX lookup failed (DNS error).",
      fix: "Check again in a few minutes.",
      records: [],
      lookup_failed: true,
    });
  } else if (mx.length === 0) {
    checks.push({
      name: "mx",
      status: "red",
      summary: "No MX records: replies to this domain cannot be delivered.",
      fix: `Add the MX records from your mail provider for ${domain}.`,
      records: [],
    });
  } else {
    checks.push({
      name: "mx",
      status: "green",
      summary: `${mx.length} MX record(s).`,
      fix: null,
      records: [...mx]
        .sort((a, b) => a.priority - b.priority)
        .map((r) => `${r.priority} ${r.exchange}`),
    });
  }

  // SPF
  const rootTxt = await txt(resolver, domain);
  const spf = (rootTxt ?? []).filter((record) => /^v=spf1(\s|$)/i.test(record.trim()));
  const provider = options.provider ? SPF_INCLUDE[options.provider] : undefined;
  if (rootTxt === null) {
    checks.push({
      name: "spf",
      status: "yellow",
      summary: "TXT lookup failed (DNS error).",
      fix: "Check again in a few minutes.",
      records: [],
      lookup_failed: true,
    });
  } else if (spf.length === 0) {
    checks.push({
      name: "spf",
      status: "red",
      summary: "No SPF record.",
      fix: `Add a TXT record on ${domain}: "v=spf1 ${provider?.example ?? "include:<your provider>"} ~all".`,
      records: [],
    });
  } else {
    const problems: string[] = [];
    if (spf.length > 1) problems.push("more than one SPF record (SPF fails: merge them into one)");
    if (spf.some((record) => /(^|\s)\+all(\s|$)/i.test(record))) {
      problems.push('"+all" lets anyone send as this domain (use ~all or -all)');
    }
    if (provider && !spf.some((record) => provider.include.test(record))) {
      problems.push(`it does not include ${provider.name} (add ${provider.example})`);
    }
    checks.push({
      name: "spf",
      status: problems.length > 0 ? "yellow" : "green",
      summary:
        problems.length > 0 ? `SPF record found, but ${problems.join("; ")}.` : "SPF record found.",
      fix:
        problems.length > 0 ? `Fix the SPF TXT record on ${domain}: ${problems.join("; ")}.` : null,
      records: spf,
    });
  }

  // DKIM
  const selectors = [
    ...new Set([
      ...(options.provider === "microsoft" ? ["selector1", "selector2"] : []),
      ...DKIM_SELECTORS,
    ]),
  ];
  const found: string[] = [];
  const unanswered: string[] = [];
  for (const selector of selectors) {
    const records = await txt(resolver, `${selector}._domainkey.${domain}`);
    if (records === null) unanswered.push(selector);
    if (records?.some((record) => /v=DKIM1|(^|;)\s*p=/i.test(record))) found.push(selector);
  }
  if (found.length > 0) {
    checks.push({
      name: "dkim",
      status: "green",
      summary: `DKIM key found (selector ${found.join(", ")}).`,
      fix: null,
      records: found,
    });
  } else if (unanswered.length > 0) {
    checks.push({
      name: "dkim",
      status: "yellow",
      summary: `DKIM lookup failed (DNS error) for selector ${unanswered.join(", ")}.`,
      fix: "Check again in a few minutes.",
      records: [],
      lookup_failed: true,
    });
  } else {
    checks.push({
      name: "dkim",
      status: "yellow",
      summary: `No DKIM key at the common selectors (${selectors.join(", ")}). This is a guess, not proof: your provider may use another selector.`,
      fix: "Turn on DKIM signing in your mail admin console (2048-bit key) and publish the TXT record it shows.",
      records: [],
    });
  }

  // DMARC
  const dmarcTxt = await txt(resolver, `_dmarc.${domain}`);
  const dmarc = (dmarcTxt ?? []).filter((record) => /^v=DMARC1/i.test(record.trim()));
  if (dmarcTxt === null) {
    checks.push({
      name: "dmarc",
      status: "yellow",
      summary: "DMARC lookup failed (DNS error).",
      fix: "Check again in a few minutes.",
      records: [],
      lookup_failed: true,
    });
  } else if (dmarc.length === 0) {
    checks.push({
      name: "dmarc",
      status: "yellow",
      summary: "No DMARC record.",
      fix: `Add a TXT record on _dmarc.${domain}: "v=DMARC1; p=none; rua=mailto:dmarc@${domain}", then move to p=quarantine once reports are clean.`,
      records: [],
    });
  } else {
    const policy = dmarc[0]?.match(/(?:^|;)\s*p\s*=\s*([a-z]+)/i)?.[1]?.toLowerCase() ?? null;
    const multiple = dmarc.length > 1;
    const weak = policy === null || policy === "none";
    checks.push({
      name: "dmarc",
      status: multiple || weak ? "yellow" : "green",
      summary: multiple
        ? "More than one DMARC record (receivers ignore them all)."
        : weak
          ? `DMARC policy is ${policy ?? "missing"} (monitoring only).`
          : `DMARC policy p=${policy}.`,
      fix: multiple
        ? `Keep a single TXT record on _dmarc.${domain}.`
        : weak
          ? "Move to p=quarantine once DMARC reports show your mail passes SPF or DKIM alignment."
          : null,
      records: dmarc,
    });
  }

  const overall = checks.reduce<CheckStatus>(
    (worst, check) => (rank[check.status] > rank[worst] ? check.status : worst),
    "green",
  );
  return { domain, checked_at: options.now.toISOString(), overall, checks };
}
