/**
 * The eval world has no DNS. Engine code that reads DNS records does it through ctx.dns (the
 * tech_detect signal collector reads MX and TXT records, the mailbox DNS check reads MX, SPF,
 * DKIM and DMARC), and the eval engine keeps the default ctx.dns: the system resolver, a
 * `node:dns` Resolver. So while an eval environment is open, every query method of that
 * Resolver class fails with ENOTFOUND, the same answer an invented domain gets. Fetching needs
 * no DNS here: the eval web and the provider APIs are routed fakes. Nothing leaves the machine
 * and runs stay deterministic. Reference counted: the real methods come back when the last
 * environment closes.
 */
import { Resolver } from "node:dns/promises";

const QUERY_METHODS = [
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
] as const;

let installs = 0;
const saved = new Map<string, unknown>();

function notFound(hostname: unknown): Promise<never> {
  const error = new Error(`queryA ENOTFOUND ${String(hostname)} (no DNS in evals)`) as Error & {
    code: string;
    hostname: string;
  };
  error.code = "ENOTFOUND";
  error.hostname = String(hostname);
  return Promise.reject(error);
}

/** Turns DNS off for Resolver instances; returns the function that turns it back on. */
export function installEvalDns(): () => void {
  const prototype = Resolver.prototype as unknown as Record<string, unknown>;
  if (installs === 0) {
    for (const method of QUERY_METHODS) {
      saved.set(method, prototype[method]);
      prototype[method] = notFound;
    }
  }
  installs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installs -= 1;
    if (installs === 0) {
      for (const [method, original] of saved) prototype[method] = original;
      saved.clear();
    }
  };
}
