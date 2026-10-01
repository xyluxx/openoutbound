/**
 * Brain wiring types. The engine builds one BrainService per context through a `BrainFactory`;
 * the default factory is the brain module's `createBrainService` (src/brain/service.ts).
 */
import type { BrainHealthReporter } from "../brain/fallback.js";
import type { Clock } from "../core/clock.js";
import type { BrainService, ProviderResolver, UsageMeter } from "../core/context.js";
import type { Logger } from "../core/logger.js";
import type { Db } from "../db/client.js";

/** What the runtime passes to the brain factory for each context. */
export interface BrainServiceDeps {
  db: Db;
  providers: ProviderResolver;
  usage: UsageMeter;
  clock?: Clock;
  log?: Logger;
  workspaceId?: string | null | (() => string | null);
  jobId?: string | null | (() => string | null | undefined);
  timeoutMs?: number;
  maxAttempts?: number;
  /** Opens and resolves `brain_down` problems (see src/runtime/brain-health.ts). */
  health?: BrainHealthReporter;
}

export type BrainFactory = (deps: BrainServiceDeps) => BrainService;
