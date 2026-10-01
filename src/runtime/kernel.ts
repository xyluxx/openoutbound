/**
 * The engine's shared state. One kernel per engine; contexts (OpContext, JobContext) bind its
 * services to a workspace and a principal.
 */
import type { Clock } from "../core/clock.js";
import type { EngineConfig } from "../core/config.js";
import type { DnsResolver, SafeFetch, Vault } from "../core/context.js";
import type { Logger } from "../core/logger.js";
import type { Db } from "../db/client.js";
import type { BrainFactory } from "./brain.js";
import type { ProviderCache } from "./providers.js";
import type { RuntimeRegistry } from "./registry.js";

export interface Kernel {
  config: EngineConfig;
  db: Db;
  log: Logger;
  clock: Clock;
  registry: RuntimeRegistry;
  vault: Vault;
  /** SSRF-safe fetch for URLs that come from data. */
  safeFetch: SafeFetch;
  /** Plain fetch handed to provider instances for their own API hosts. */
  providerFetch: typeof globalThis.fetch;
  /** DNS record lookups (ctx.dns). */
  dns: DnsResolver;
  providerCache: ProviderCache;
  brainFactory: BrainFactory;
  /** Asks the worker (when running in this process) to poll now. No-op otherwise. */
  nudge(): void;
  /**
   * Keys passed to jobs.wake() lately, so a job that parks right after a wake-up sent while it
   * ran re-runs (it may have read the state just before the wake).
   */
  recentWakes: RecentKeys;
}

/**
 * A set whose entries expire after `ttlMs` (by the kernel clock). Each add gets a sequence
 * number, so a caller can ask whether a key was added after a point it marked (clocks may not
 * move between the two, in tests or within one millisecond).
 */
export class RecentKeys {
  private readonly entries = new Map<string, { expiresAt: number; seq: number }>();
  private seq = 0;

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs = 5 * 60_000,
    private readonly limit = 10_000,
  ) {}

  add(key: string): void {
    this.seq += 1;
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: this.clock.now().getTime() + this.ttlMs, seq: this.seq });
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  has(key: string): boolean {
    return this.live(key) !== undefined;
  }

  /** A point to compare later adds against (see `addedSince`). */
  mark(): number {
    return this.seq;
  }

  /** True when the key was added after `mark()` returned `since` and has not expired. */
  addedSince(key: string, since: number): boolean {
    const entry = this.live(key);
    return entry !== undefined && entry.seq > since;
  }

  private live(key: string): { expiresAt: number; seq: number } | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.clock.now().getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
