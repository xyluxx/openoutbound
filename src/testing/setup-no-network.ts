/**
 * Vitest setup file (see vitest.config.ts): tests never touch the real network.
 *
 * - `fetch` to anything but localhost throws a clear error.
 * - `net` socket connections to non-local hosts throw (covers http, https, pg, SMTP, IMAP).
 * - `node:dns` queries and lookups of non-local names fail the same way (code that reads DNS
 *   records goes through ctx.dns, which tests fake).
 *
 * A test that really needs a host calls `allowNetwork("api.example.com")` (or a RegExp);
 * the allowance resets after each test.
 */
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { afterEach } from "vitest";

const STATE_KEY = Symbol.for("openoutbound.testing.network");

interface NetworkGuardState {
  allowed: Array<string | RegExp>;
  installed: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function state(): NetworkGuardState {
  const holder = globalThis as unknown as Record<symbol, NetworkGuardState | undefined>;
  let current = holder[STATE_KEY];
  if (!current) {
    current = { allowed: [], installed: false };
    holder[STATE_KEY] = current;
  }
  return current;
}

/** Allows real connections to the given hosts until the current test ends. */
export function allowNetwork(...hosts: Array<string | RegExp>): void {
  state().allowed.push(...hosts);
}

/** True when a connection to `host` is allowed right now. */
export function isHostAllowed(host: string): boolean {
  const normalized = host.toLowerCase();
  if (LOCAL_HOSTS.has(normalized) || normalized.endsWith(".localhost")) return true;
  return state().allowed.some((rule) =>
    typeof rule === "string" ? rule.toLowerCase() === normalized : rule.test(normalized),
  );
}

function blocked(target: string): Error {
  return new Error(
    `Network access blocked in tests: ${target}. Use a fake (ctx.fetch routes, ctx.dns records, provider fixtures) or call allowNetwork("<host>") in the test.`,
  );
}

/** Every `node:dns` function that can send a query (lookup and lookupService use the OS resolver). */
const DNS_FUNCTIONS = [
  "lookup",
  "lookupService",
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
  "resolveTlsa",
  "resolveTxt",
  "reverse",
] as const;

/**
 * Wraps the dns functions on the module objects and on both Resolver classes, then syncs the
 * ESM named exports (`import { lookup } from "node:dns/promises"`) with the patched objects.
 * Looking up an IP literal never leaves the machine, so `lookup` lets those through.
 */
function guardDns(): void {
  const patch = (target: object, name: string, promise: boolean) => {
    const holder = target as Record<string, unknown>;
    const original = holder[name];
    if (typeof original !== "function") return;
    holder[name] = function guardedDns(this: unknown, hostname: unknown, ...rest: unknown[]) {
      const host = String(hostname);
      const literal = name === "lookup" && net.isIP(host) !== 0;
      if (!literal && !isHostAllowed(host)) {
        const error = blocked(`dns ${host}`);
        if (promise) return Promise.reject(error);
        throw error;
      }
      return (original as (...args: unknown[]) => unknown).apply(this, [hostname, ...rest]);
    };
  };
  for (const name of DNS_FUNCTIONS) {
    patch(dns, name, false);
    patch(dns.Resolver.prototype, name, false);
    patch(dns.promises, name, true);
    patch(dns.promises.Resolver.prototype, name, true);
  }
  syncBuiltinESMExports();
}

function install(): void {
  const guard = state();
  if (guard.installed) return;
  guard.installed = true;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!isHostAllowed(url.hostname)) throw blocked(`fetch ${url.origin}`);
    return realFetch(input, init);
  }) as typeof fetch;

  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    // net.connect() passes its normalized args as one array: [options, callback].
    const [first, second] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    let host: string | undefined;
    if (typeof first === "object" && first !== null) {
      const options = first as { host?: string; path?: string };
      host = options.path ? undefined : (options.host ?? "localhost");
    } else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
      host = typeof second === "string" ? second : "localhost";
    }
    if (host !== undefined && !isHostAllowed(host)) throw blocked(`socket ${host}`);
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  guardDns();
}

install();

afterEach(() => {
  state().allowed = [];
});
