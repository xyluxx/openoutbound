/**
 * Runs one monitor: resolves target companies (capped by budget.max_companies), runs the
 * built-in collectors and paid signal providers per company (paid calls capped per run and
 * per month, and by the workspace data budget: a call starts only when what is left covers
 * it), evaluates custom definitions over the collected evidence, records signals and stores
 * a summary on the monitor.
 *
 * A paid call that fails is a failure on the run (`failures`, status partial or failed), never
 * an empty answer. It is charged only when the provider answered (`malformed`), or for the
 * requests that answered before it failed part way (`details.partial`, whose signals are kept);
 * after a failure of the provider's account or service the run stops asking it. last_run_at,
 * the start of the window the next run looks at, moves only when the run was not stopped and
 * left no failure a later run could fix, so signals from a failed window are not skipped.
 */
import { eq } from "drizzle-orm";
import {
  answeredDespiteFailure,
  callFailure,
  stopsProvider,
  worthRetrying,
} from "../../../core/call-failure.js";
import type { OpContext } from "../../../core/context.js";
import { isOpenOutboundError } from "../../../core/errors.js";
import { type Failure, partialOf } from "../../../core/failures.js";
import { type Monitor, monitors, type SignalDefinition } from "../../../db/schema/index.js";
import type { RawSignal, SignalProvider } from "../../../providers/types.js";
import { isBuiltinCollector, loadDefinitions } from "../catalog.js";
import { type CollectorSet, defaultCollectors } from "../collectors/index.js";
import { companyDomain, matchingKeywords, PageCache } from "../collectors/pages.js";
import type { CollectorRun, EvidenceItem, RunKeywords } from "../collectors/types.js";
import {
  evaluateCustomDefinition,
  gatherSandboxUrlEvidence,
  gatherUrlEvidence,
} from "../custom-evaluation.js";
import { buildRunKeywords } from "../keywords.js";
import { storeSignal } from "../service.js";
import { nextMonitorRun } from "./schedule.js";
import { DEFAULT_MAX_COMPANIES, resolveTargets } from "./targets.js";

const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_NOTES = 25;

export type MonitorStopReason =
  | "budget_credits_run"
  | "budget_credits_month"
  | "budget_data"
  | "budget_ai"
  | "provider_failed"
  | "aborted";

/** A signal provider that failed during a run. */
export interface MonitorFailure {
  provider: string;
  failure: Failure;
  /** Companies the provider did not check because of it (failed or no longer asked). */
  companies: number;
}

export interface MonitorRunSummary {
  trigger: "manual" | "schedule";
  started_at: string;
  finished_at: string;
  companies_total: number;
  companies_checked: number;
  signals_new: number;
  signals_duplicate: number;
  signals_rejected: number;
  by_key: Record<string, number>;
  custom_evaluated: number;
  brain_calls: number;
  credits_used: number;
  /** YYYY-MM and credits spent by this monitor in that month (for max_credits_per_month). */
  month: string;
  month_credits: number;
  /** Why paid calls, AI steps or the run stopped early (null = ran fully). */
  stopped: MonitorStopReason[];
  /**
   * ok; partial: some paid calls failed; failed: every paid call failed and no built-in
   * collector ran.
   */
  status: "ok" | "partial" | "failed";
  /** ISO start of the window the run looked at: the last run that moved it. */
  since: string;
  /** Paid providers that failed, by provider and failure class. */
  failures: MonitorFailure[];
  /**
   * Whether last_run_at moved to this run. False when it was stopped or a failure a later run
   * can fix remains: the next run looks at the same window again.
   */
  window_moved: boolean;
  notes: string[];
}

export interface RunMonitorOptions {
  trigger?: "manual" | "schedule";
  collectors?: CollectorSet;
  signal?: AbortSignal;
  jobId?: string;
  onProgress?: (done: number, total: number) => Promise<void>;
}

/** Collectors and provider ids a monitor runs by default: every free web collector. */
export const DEFAULT_MONITOR_COLLECTORS = [
  "website_changes",
  "job_boards",
  "news_gdelt",
  "rss",
  "tech_detect",
] as const;

function relevantDefinitions(
  enabled: SignalDefinition[],
  monitorKeys: readonly string[],
  icpKeys: readonly string[],
): SignalDefinition[] {
  const keys = monitorKeys.length > 0 ? monitorKeys : icpKeys;
  if (keys.length === 0) return enabled;
  return enabled.filter((definition) => keys.includes(definition.key));
}

/**
 * Provider hiring and tech signals are kept only when they match the workspace's role or tool
 * keywords (when it has any): providers report every job and every detected technology.
 */
export function keepProviderSignal(signal: RawSignal, keywords: RunKeywords): boolean {
  const list =
    signal.definition_key === "hiring_relevant_roles"
      ? keywords.hiring
      : signal.definition_key === "tech_adopted" || signal.definition_key === "tech_removed"
        ? keywords.tech
        : [];
  if (list.length === 0) return true;
  return matchingKeywords(`${signal.title} ${signal.summary ?? ""}`, list).length > 0;
}

export async function runMonitor(
  ctx: OpContext,
  monitor: Monitor,
  options: RunMonitorOptions = {},
): Promise<MonitorRunSummary> {
  const workspaceId = monitor.workspace_id;
  const startedAt = ctx.clock.now();
  const month = startedAt.toISOString().slice(0, 7);
  const lastResult = (monitor.last_result ?? {}) as Partial<MonitorRunSummary>;
  const summary: MonitorRunSummary = {
    trigger: options.trigger ?? "manual",
    started_at: startedAt.toISOString(),
    finished_at: startedAt.toISOString(),
    companies_total: 0,
    companies_checked: 0,
    signals_new: 0,
    signals_duplicate: 0,
    signals_rejected: 0,
    by_key: {},
    custom_evaluated: 0,
    brain_calls: 0,
    credits_used: 0,
    month,
    month_credits: lastResult.month === month ? (lastResult.month_credits ?? 0) : 0,
    stopped: [],
    status: "ok",
    since: "",
    failures: [],
    window_moved: false,
    notes: [],
  };
  const note = (text: string) => {
    if (summary.notes.length < MAX_NOTES && !summary.notes.includes(text)) summary.notes.push(text);
  };
  const stop = (reason: MonitorStopReason) => {
    if (!summary.stopped.includes(reason)) summary.stopped.push(reason);
  };

  const definitionMap = await loadDefinitions(ctx.db, workspaceId);
  const enabled = [...definitionMap.values()].filter((definition) => definition.enabled);
  const targets = await resolveTargets(
    ctx,
    workspaceId,
    monitor.target,
    monitor.budget.max_companies ?? DEFAULT_MAX_COMPANIES,
  );
  summary.companies_total = targets.total;
  const definitions = relevantDefinitions(enabled, monitor.signal_keys, targets.icpSignalKeys);
  const relevantKeys = new Set(definitions.map((definition) => definition.key));
  const customDefinitions = definitions.filter((definition) => definition.kind === "custom");
  const keywords = await buildRunKeywords(ctx, workspaceId, enabled);
  const collectors = options.collectors ?? defaultCollectors();
  const names = [...new Set(monitor.collectors)];
  // Sandbox companies are invented: never crawl the real web for them.
  const sandbox = ctx.workspace?.is_sandbox === true;
  const builtin = names
    .filter(isBuiltinCollector)
    .filter((name) => !sandbox || name === "first_party");
  if (sandbox && names.some((name) => isBuiltinCollector(name) && name !== "first_party")) {
    note(
      "Sandbox workspace: web collectors are skipped; sandbox signal providers still run and custom signals read their urls from the sandbox pages.",
    );
  }
  const providerIds = names.filter((name) => !isBuiltinCollector(name));
  const since =
    monitor.last_run_at ?? new Date(startedAt.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
  summary.since = since.toISOString();
  /** Providers this run stopped asking, with the failure of their account or service. */
  const stoppedProviders = new Map<string, Failure>();
  let answeredCalls = 0;
  const addFailure = (providerId: string, failure: Failure) => {
    const entry = summary.failures.find(
      (item) => item.provider === providerId && item.failure.class === failure.class,
    );
    if (entry) entry.companies += 1;
    else summary.failures.push({ provider: providerId, failure, companies: 1 });
  };

  const providers: SignalProvider[] = [];
  for (const id of providerIds) {
    const provider = await ctx.providers.tryGet("signals", { id });
    if (provider) providers.push(provider);
    else note(`Provider "${id}" is not configured; run manage_providers to set it up.`);
  }
  let paidAllowed = providers.length > 0;
  let aiAllowed = true;

  const record = async (signal: RawSignal, companyId: string) => {
    if (!relevantKeys.has(signal.definition_key)) return;
    try {
      const result = await storeSignal(ctx, { ...signal, companyId });
      if (result.created) {
        summary.signals_new += 1;
        summary.by_key[signal.definition_key] = (summary.by_key[signal.definition_key] ?? 0) + 1;
      } else {
        summary.signals_duplicate += 1;
      }
    } catch (error) {
      summary.signals_rejected += 1;
      note(
        `Rejected a ${signal.definition_key} signal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  let done = 0;
  for (const company of targets.companies) {
    if (options.signal?.aborted) {
      stop("aborted");
      break;
    }
    const pages = new PageCache(ctx.fetch, options.signal);
    const run: CollectorRun = { ctx, company, definitions, since, keywords, pages };
    if (options.signal) run.signal = options.signal;
    const evidence: EvidenceItem[] = [];

    for (const name of builtin) {
      try {
        const output = await collectors[name].collect(run);
        summary.brain_calls += output.brainCalls;
        evidence.push(...output.evidence);
        for (const text of output.notes) note(`${company.name}: ${text}`);
        for (const signal of output.signals) await record(signal, company.id);
      } catch (error) {
        if (isOpenOutboundError(error) && error.code === "budget_exceeded") {
          aiAllowed = false;
          stop("budget_ai");
        }
        note(
          `${company.name}: ${name} failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }

    for (const provider of paidAllowed ? providers : []) {
      const stoppedBy = stoppedProviders.get(provider.id);
      if (stoppedBy) {
        addFailure(provider.id, stoppedBy);
        continue;
      }
      const credits = provider.creditsPerCall ?? 1;
      if (
        monitor.budget.max_credits_per_run !== undefined &&
        summary.credits_used + credits > monitor.budget.max_credits_per_run
      ) {
        stop("budget_credits_run");
        paidAllowed = false;
        break;
      }
      if (
        monitor.budget.max_credits_per_month !== undefined &&
        summary.month_credits + credits > monitor.budget.max_credits_per_month
      ) {
        stop("budget_credits_month");
        paidAllowed = false;
        break;
      }
      const keys = provider.supportedSignals.filter((key) => relevantKeys.has(key));
      if (keys.length === 0) continue;
      // Pre-spend check: the call starts only when what is left of the data budget covers it.
      try {
        await ctx.usage.assertCanSpend(workspaceId, "data", credits);
      } catch (error) {
        if (!isOpenOutboundError(error) || error.code !== "budget_exceeded") throw error;
        note(`${error.message} Paid signal providers stopped for the rest of this run.`);
        stop("budget_data");
        paidAllowed = false;
        break;
      }
      // Providers bill calls they answered, also when they found nothing; not refused calls.
      let billed = 0;
      try {
        const collectOptions: { since: Date; signalKeys: string[] } = { since, signalKeys: keys };
        const found = await provider.collect(
          {
            company: {
              id: company.id,
              name: company.name,
              domain: companyDomain(company),
              linkedin_url: company.linkedin_url,
            },
          },
          collectOptions,
        );
        billed = credits;
        answeredCalls += 1;
        for (const signal of found) {
          if (keepProviderSignal(signal, keywords)) await record(signal, company.id);
        }
      } catch (error) {
        const failure = callFailure(error, provider.id);
        // A check of several paid requests that failed part way hands back the signals and the
        // credits of the requests that answered: they are kept and charged, and the failure
        // still holds the window, so the next run asks this company again.
        const partial = partialOf<RawSignal>(error);
        const spent = partial?.credits ?? 0;
        billed = answeredDespiteFailure(failure) ? Math.max(credits, spent) : spent;
        if (partial) {
          answeredCalls += 1;
          for (const signal of partial.items) {
            if (keepProviderSignal(signal, keywords)) await record(signal, company.id);
          }
        }
        addFailure(provider.id, failure);
        if (stopsProvider(failure)) {
          stoppedProviders.set(provider.id, failure);
          stop("provider_failed");
        }
        const kept = partial
          ? ` Kept the ${partial.items.length} ${partial.items.length === 1 ? "signal" : "signals"} it returned first.`
          : "";
        note(
          `${company.name}: ${provider.id} failed (${failure.class}): ${error instanceof Error ? error.message : String(error)}${kept}`,
        );
      }
      if (billed > 0) {
        summary.credits_used += billed;
        summary.month_credits += billed;
        await ctx.usage.record({
          workspaceId,
          slot: "signals",
          provider: provider.id,
          operation: "monitors.run",
          credits: billed,
          jobId: options.jobId ?? null,
        });
      }
    }

    for (const definition of aiAllowed ? customDefinitions : []) {
      try {
        const urlEvidence = sandbox
          ? await gatherSandboxUrlEvidence(ctx, definition, company)
          : await gatherUrlEvidence(pages, definition, company, []);
        const result = await evaluateCustomDefinition(ctx, {
          company,
          definition,
          evidence: [...evidence, ...urlEvidence],
        });
        summary.brain_calls += result.brainCalls;
        if (result.brainCalls > 0) summary.custom_evaluated += 1;
        if (result.status === "discarded")
          note(`${company.name}: ${definition.key} answer discarded (${result.reason})`);
        if (result.signal) await record(result.signal, company.id);
      } catch (error) {
        if (isOpenOutboundError(error) && error.code === "budget_exceeded") {
          aiAllowed = false;
          stop("budget_ai");
        }
        note(
          `${company.name}: ${definition.key} evaluation failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }

    done += 1;
    summary.companies_checked = done;
    await options.onProgress?.(done, targets.companies.length);
  }

  const finishedAt = ctx.clock.now();
  summary.finished_at = finishedAt.toISOString();
  if (summary.failures.length > 0) {
    summary.status = answeredCalls === 0 && builtin.length === 0 ? "failed" : "partial";
  }
  summary.window_moved =
    !summary.stopped.includes("aborted") &&
    !summary.failures.some((item) => worthRetrying(item.failure));
  // A monitor removed during the run simply updates nothing.
  await ctx.db
    .update(monitors)
    .set({
      ...(summary.window_moved ? { last_run_at: startedAt } : {}),
      last_result: summary as unknown as Record<string, unknown>,
      next_run_at: nextMonitorRun(monitor.schedule, ctx.workspace?.timezone ?? "UTC", finishedAt),
    })
    .where(eq(monitors.id, monitor.id));
  return summary;
}
