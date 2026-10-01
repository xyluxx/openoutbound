/**
 * ctx.dns in production: the system resolver with a short timeout, so a slow DNS server cannot
 * hold up a monitor run. Tests replace it (EngineInternals.dns, createTestContext's fake).
 */
import { Resolver } from "node:dns/promises";
import type { DnsResolver } from "../core/context.js";

export function createSystemDns(options: { timeoutMs?: number; tries?: number } = {}): DnsResolver {
  const resolver = new Resolver({ timeout: options.timeoutMs ?? 3000, tries: options.tries ?? 1 });
  return {
    resolveMx: (domain) => resolver.resolveMx(domain),
    resolveTxt: (name) => resolver.resolveTxt(name),
  };
}
