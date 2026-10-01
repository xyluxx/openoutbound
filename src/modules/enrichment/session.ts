/**
 * One enrichment run: resolves the configured finders and verifier once, checks before every
 * paid call that the data budget still has room for it, records usage per call and turns
 * provider failures into failure records instead of failing the whole run (the waterfall moves
 * on to the next provider). After a failure of a provider's account or of the whole provider
 * (rejected key, no credits, rate limit, server trouble) the run stops calling it: the people
 * after that get the same failure without a call.
 */
import { callFailure, stopsProvider } from "../../core/call-failure.js";
import type { OpContext } from "../../core/context.js";
import { OpenOutboundError } from "../../core/errors.js";
import type { Failure } from "../../core/failures.js";
import { parseWorkspaceSettings, type WorkspaceSettings } from "../../core/settings.js";
import type { Workspace } from "../../db/schema/index.js";
import type {
  EmailFinderProvider,
  EmailVerifierProvider,
  FindEmailInput,
  FindEmailResult,
  VerifyEmailResult,
} from "../../providers/types.js";
import { CrawlCache } from "./crawler.js";

/** Pseudo finder id for the website contact crawler in `settings.data.enrichment.finders`. */
export const WEBSITE_FINDER = "website";

/** Credits one finder or verifier call costs at most: the pre-spend check needs this much left. */
export const CALL_CREDITS = 1;

export interface SessionOptions {
  /** Operation or job name recorded with usage rows. */
  operation: string;
  jobId?: string | null;
}

export class EnrichmentSession {
  readonly workspace: Workspace;
  readonly settings: WorkspaceSettings;
  readonly crawls: CrawlCache;
  /** Set once the workspace data budget is used up; later paid calls are skipped. */
  budgetExceeded = false;
  creditsUsed = 0;
  private verifierLookup: Promise<EmailVerifierProvider | null> | null = null;
  private readonly finders = new Map<string, Promise<EmailFinderProvider | null>>();
  /** Providers this run stopped calling, with the failure that stopped them. */
  private readonly stopped = new Map<string, Failure>();

  constructor(
    readonly ctx: OpContext,
    readonly options: SessionOptions,
  ) {
    if (!ctx.workspace) {
      throw new OpenOutboundError("validation_failed", "Enrichment needs a workspace.", {
        hint: "Pass `workspace` (id or slug), or use a workspace API key.",
      });
    }
    this.workspace = ctx.workspace;
    this.settings = parseWorkspaceSettings(ctx.workspace.settings);
    this.crawls = new CrawlCache(ctx);
  }

  /** The configured verifier (settings.data.enrichment.verifier, else the default one). */
  verifier(): Promise<EmailVerifierProvider | null> {
    if (!this.verifierLookup) {
      const id = this.settings.data.enrichment.verifier;
      this.verifierLookup = this.ctx.providers
        .tryGet("email_verifier", id ? { id } : undefined)
        .catch(() => null);
    }
    return this.verifierLookup;
  }

  finder(id: string): Promise<EmailFinderProvider | null> {
    let lookup = this.finders.get(id);
    if (!lookup) {
      lookup = this.ctx.providers.tryGet("email_finder", { id }).catch(() => null);
      this.finders.set(id, lookup);
    }
    return lookup;
  }

  /**
   * Finder ids in waterfall order: settings.data.enrichment.finders when set, else every
   * enabled finder. The website crawler runs first (free, and a published address is legal
   * evidence) unless the list places "website" elsewhere; it is dropped when turned off.
   */
  async finderOrder(): Promise<string[]> {
    const configured = this.settings.data.enrichment.finders;
    let order =
      configured.length > 0
        ? [...configured]
        : (await this.ctx.providers.list("email_finder")).map((f) => f.id);
    order = [...new Set(order)];
    if (!order.includes(WEBSITE_FINDER)) order.unshift(WEBSITE_FINDER);
    if (!this.settings.data.enrichment.website_crawler) {
      order = order.filter((id) => id !== WEBSITE_FINDER);
    }
    return order;
  }

  /**
   * False (and `budgetExceeded`) when the monthly data budget has less than one call's worth
   * (CALL_CREDITS) left, so a run never ends above the budget.
   */
  async canSpend(): Promise<boolean> {
    if (this.budgetExceeded) return false;
    try {
      await this.ctx.usage.assertCanSpend(this.workspace.id, "data", CALL_CREDITS);
      return true;
    } catch (error) {
      if (error instanceof OpenOutboundError && error.code === "budget_exceeded") {
        this.budgetExceeded = true;
        return false;
      }
      throw error;
    }
  }

  private async record(
    slot: "email_finder" | "email_verifier",
    provider: string,
    credits: number,
  ): Promise<void> {
    if (!(credits > 0)) return;
    this.creditsUsed += credits;
    await this.ctx.usage.record({
      slot,
      provider,
      operation: this.options.operation,
      credits,
      jobId: this.options.jobId ?? null,
    });
  }

  /** Notes a failed call; a failure of the account or the provider stops later calls to it. */
  private failed(provider: string, error: unknown): Failure {
    const failure = callFailure(error, provider);
    if (stopsProvider(failure)) this.stopped.set(provider, failure);
    return failure;
  }

  /**
   * Verifies one address. `result` is null when no verifier is configured, the budget is used
   * up (`error`) or the call failed (`failure`).
   */
  async verify(email: string): Promise<{
    result: VerifyEmailResult | null;
    provider: string | null;
    error?: string;
    failure?: Failure;
  }> {
    const verifier = await this.verifier();
    if (!verifier) return { result: null, provider: null, error: "no_verifier" };
    const stopped = this.stopped.get(verifier.id);
    if (stopped) return { result: null, provider: verifier.id, failure: stopped };
    if (!(await this.canSpend()))
      return { result: null, provider: verifier.id, error: "budget_exceeded" };
    try {
      const result = await verifier.verify(email);
      await this.record("email_verifier", verifier.id, result.creditsUsed);
      return { result, provider: verifier.id };
    } catch (error) {
      return { result: null, provider: verifier.id, failure: this.failed(verifier.id, error) };
    }
  }

  /**
   * Runs one finder. `result` is null when it is not configured, the budget is used up
   * (`error`) or the call failed (`failure`).
   */
  async find(
    id: string,
    input: FindEmailInput,
  ): Promise<{ result: FindEmailResult | null; error?: string; failure?: Failure }> {
    const finder = await this.finder(id);
    if (!finder) return { result: null, error: "not_configured" };
    const stopped = this.stopped.get(finder.id);
    if (stopped) return { result: null, failure: stopped };
    if (!(await this.canSpend())) return { result: null, error: "budget_exceeded" };
    try {
      const result = await finder.findEmail(input);
      await this.record("email_finder", finder.id, result.creditsUsed);
      return { result };
    } catch (error) {
      return { result: null, failure: this.failed(finder.id, error) };
    }
  }
}
