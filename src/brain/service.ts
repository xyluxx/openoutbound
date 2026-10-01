import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { Clock } from "../core/clock.js";
import type {
  BrainResult,
  BrainRunOptions,
  BrainService,
  ProviderResolver,
  UsageMeter,
} from "../core/context.js";
import type { ModelTier } from "../core/enums.js";
import {
  isJobWaitError,
  isOpenOutboundError,
  JobWaitError,
  notFound,
  OpenOutboundError,
} from "../core/errors.js";
import { classifyFetchError, failureOf, isFetchError, isRetryable } from "../core/failures.js";
import { type Logger, silentLogger } from "../core/logger.js";
import { parseWorkspaceSettings, type WorkspaceSettings } from "../core/settings.js";
import type { Db } from "../db/client.js";
import { type Workspace, workspaces } from "../db/schema/index.js";
import { brainError } from "../providers/brain/errors.js";
import { createFakeBrainProvider } from "../providers/brain/fake.js";
import type { BrainProvider, BrainResponse, BrainUsage } from "../providers/types.js";
import { agentTaskIdFromWaitKey } from "./agent-tasks.js";
import {
  AGENT_BRAIN_ID,
  BRAIN_WAIT_RECHECK_MS,
  type BrainHealthReporter,
  brainConfiguredWaitKey,
  failureReason,
  isBrainDownFailure,
  isFallbackFailure,
  NO_BRAIN_PROVIDER,
  TIME_SENSITIVE_PROMPTS,
} from "./fallback.js";
import { stableHash } from "./hash.js";
import {
  isJsonObject,
  type JsonSchema,
  outputJsonSchema,
  schemaNameFor,
  withSchemaInstruction,
} from "./json-schema.js";
import { type ConcurrencyLimiter, concurrencyLaneOf, sharedBrainLimiter } from "./limiter.js";
import { describeIssues, parseJsonReply, stripNullOptionals } from "./output.js";
import { computeCostUsd } from "./pricing.js";
import type { PromptDefinition } from "./prompt.js";
import type { ServiceBrainRequest } from "./request.js";
import { brainBackoffMs, isRetryableBrainError, sleep } from "./retry.js";
import { chooseRoute, modelForTier, type RouteChoice } from "./routing.js";

/** Matches the SDK and CLI limits: deep prompts with thinking can take several minutes. */
export const DEFAULT_BRAIN_TIMEOUT_MS = 600_000;
export const DEFAULT_BRAIN_MAX_ATTEMPTS = 3;
export const DEFAULT_BRAIN_MAX_RETRY_AFTER_MS = 60_000;
export const DEFAULT_PROMPT_MAX_TOKENS = 2000;
/** Longest previous reply quoted back to the model in a repair call. */
const REPAIR_QUOTE_CHARS = 12_000;

type Lazy<T> = T | (() => T);

export interface BrainServiceDeps {
  db: Db;
  /** The calling context's provider resolver (workspace -> instance -> env). */
  providers: ProviderResolver;
  /** The calling context's usage meter (records spend, enforces the AI budget). */
  usage: UsageMeter;
  log?: Logger;
  /** The engine clock (wait times of parked jobs). Default: the system time. */
  clock?: Clock;
  /** Workspace of the calling context, used when `run()` gets no `workspaceId`. */
  workspaceId?: Lazy<string | null | undefined>;
  /**
   * Id of the running job when the service belongs to a job context. The agent brain then
   * parks the job (`JobWaitError`); without a job it throws an `approval_required` error that
   * tells the caller to finish the agent task first.
   */
  jobId?: Lazy<string | null | undefined>;
  /** Per-call timeout (each attempt). Default 10 minutes. */
  timeoutMs?: number;
  /** Attempts per call for retryable errors (429, 5xx, overloaded, network). Default 3. */
  maxAttempts?: number;
  /** A Retry-After longer than this fails right away (the job retries later). Default 60 s. */
  maxRetryAfterMs?: number;
  /** Concurrency limits; default: one registry shared by the whole process. */
  limiter?: ConcurrencyLimiter;
  /** Brain for sandbox workspaces (default: a built-in fake brain). */
  sandboxBrain?: BrainProvider;
  /** Waits between retries (tests pass a fake). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Hears when a brain goes down or answers again (the runtime opens `brain_down` problems). */
  health?: BrainHealthReporter;
}

/** Where a prompt would run. */
export interface BrainRoute {
  provider: BrainProvider;
  tier: ModelTier;
  model: string;
}

/** The brain service plus route inspection (used by `brain.test`) and the readiness check. */
export interface BrainServiceWithRoute extends BrainService {
  /** Resolves provider, tier and model for a prompt without calling a model. */
  route<V, T>(prompt: PromptDefinition<V, T>, options?: BrainRunOptions): Promise<BrainRoute>;
  /**
   * Checks, without calling a model, that a call of `prompt` would reach a brain: its route, or
   * the backup brain when the main one is not configured. When neither is configured it does
   * what `run` does: reports the brain down and throws the same error, which in a job is the
   * `JobWaitError` on `brain:configured:<workspace id>`. Other route problems are left to `run`.
   */
  ready<V, T>(prompt: PromptDefinition<V, T>, options?: BrainRunOptions): Promise<void>;
}

/**
 * Lets a job wait for a brain before it pays for anything the brain call needs (web searches,
 * provider calls): throws what `ctx.brain.run(prompt)` would throw when the workspace has no
 * brain configured, in a job the `JobWaitError` that parks it until one is set. A brain service
 * without the check (a test fake) counts as ready.
 */
export async function assertBrainReady<V, T>(
  brain: BrainService,
  prompt: PromptDefinition<V, T>,
  options: BrainRunOptions = {},
): Promise<void> {
  const check = (brain as Partial<BrainServiceWithRoute>).ready;
  if (typeof check === "function") await check.call(brain, prompt, options);
}

let defaultSandboxBrain: BrainProvider | undefined;

/** The workspace a call runs for, with its settings (null for instance-level calls). */
interface Target {
  workspaceId: string | null;
  workspace: Workspace | null;
  settings: WorkspaceSettings | null;
}

/** Where a call goes: its workspace, its route choice, the backup brain and a forced route. */
interface CallPlan {
  target: Target;
  choice: RouteChoice;
  backup: string | null;
  /** The caller named the provider or model: no backup, no `brain_down` report, no wait. */
  forced: boolean;
}

/** `ai.agent_timeout_minutes` when a call has no workspace settings. */
const DEFAULT_AGENT_TIMEOUT_MINUTES = parseWorkspaceSettings({}).ai.agent_timeout_minutes;

interface CallScope {
  provider: BrainProvider;
  model: string;
  promptId: string;
  workspaceId: string | null;
  jobId: string | undefined;
  signal: AbortSignal | undefined;
}

type CheckResult<T> = { ok: true; data: T } | { ok: false; problems: string[] };

/**
 * Creates the BrainService (spec 11.2): resolves provider and model by tier and workspace
 * overrides, renders the prompt, asks for schema-constrained JSON (native structured output,
 * JSON mode or prompt instructions), validates with zod, runs one repair call with the
 * validation errors, records usage and cost, enforces the monthly AI budget before every call,
 * limits concurrency per provider, applies a timeout and retries rate limits and server errors
 * with backoff (honoring Retry-After). Build one per context; limits are shared process-wide.
 */
export function createBrainService(deps: BrainServiceDeps): BrainServiceWithRoute {
  const log = deps.log ?? silentLogger();
  const limiter = deps.limiter ?? sharedBrainLimiter;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_BRAIN_TIMEOUT_MS;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_BRAIN_MAX_ATTEMPTS);
  const maxRetryAfterMs = deps.maxRetryAfterMs ?? DEFAULT_BRAIN_MAX_RETRY_AFTER_MS;
  const wait = deps.sleep ?? sleep;

  async function loadWorkspace(workspaceId: string | null): Promise<Workspace | null> {
    if (!workspaceId) return null;
    const [row] = await deps.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!row) throw notFound("Workspace", workspaceId);
    return row;
  }

  function settingsOf(workspace: Workspace | null): WorkspaceSettings | null {
    if (!workspace) return null;
    try {
      return parseWorkspaceSettings(workspace.settings);
    } catch (error) {
      log.warn(
        { workspace_id: workspace.id, err: (error as Error).message },
        "invalid workspace settings; the brain uses defaults",
      );
      return parseWorkspaceSettings({});
    }
  }

  async function resolveProvider(
    providerId: string | undefined,
    workspace: Workspace | null,
    settings: WorkspaceSettings | null,
  ): Promise<BrainProvider> {
    if (workspace?.is_sandbox && !settings?.sandbox.use_real_brain) {
      if (deps.sandboxBrain) return deps.sandboxBrain;
      defaultSandboxBrain ??= createFakeBrainProvider();
      return defaultSandboxBrain;
    }
    try {
      return providerId
        ? await deps.providers.get("brain", { id: providerId })
        : await deps.providers.get("brain");
    } catch (error) {
      if (isOpenOutboundError(error) && error.code === "provider_not_configured") {
        throw new OpenOutboundError(
          "provider_not_configured",
          providerId
            ? `The brain provider "${providerId}" is not configured for this workspace.`
            : "No AI brain is configured for this workspace.",
          {
            hint: "Configure one with manage_providers (action set, slot brain): anthropic, openai, openrouter, gemini, openai_compatible (local models), claude_cli, codex_cli or agent (your connected agent does the AI work). Or set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or GEMINI_API_KEY.",
            details: { slot: "brain", ...(providerId ? { provider: providerId } : {}) },
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  async function targetOf(options: BrainRunOptions): Promise<Target> {
    const workspaceId =
      options.workspaceId !== undefined ? options.workspaceId : (read(deps.workspaceId) ?? null);
    const workspace = await loadWorkspace(workspaceId);
    return { workspaceId, workspace, settings: settingsOf(workspace) };
  }

  async function resolveRoute(choice: RouteChoice, target: Target): Promise<BrainRoute> {
    const provider = await resolveProvider(choice.providerId, target.workspace, target.settings);
    const model = choice.model ?? modelForTier(provider, choice.tier);
    return { provider, tier: choice.tier, model };
  }

  async function route<V, T>(
    prompt: PromptDefinition<V, T>,
    options: BrainRunOptions = {},
  ): Promise<BrainRoute> {
    const target = await targetOf(options);
    return resolveRoute(chooseRoute(prompt, options, target.settings), target);
  }

  /**
   * The backup brain of a call (`ai.fallback_provider`), or null: calls that force a provider or
   * model or ask for no fallback (test_brain) and sandbox workspaces on the built-in fake brain
   * never fall back.
   */
  function backupOf(options: BrainRunOptions, target: Target): string | null {
    if (options.provider || options.model || options.noFallback) return null;
    if (target.workspace?.is_sandbox && !target.settings?.sandbox.use_real_brain) return null;
    return target.settings?.ai.fallback_provider?.trim() || null;
  }

  /** How long a time-sensitive prompt may wait for the agent brain before the backup answers. */
  function agentTimeoutOf(
    promptId: string,
    main: BrainRoute,
    backup: string | null,
    target: Target,
  ): ServiceBrainRequest["agentTimeout"] {
    if (main.provider.id !== AGENT_BRAIN_ID || !backup || backup === AGENT_BRAIN_ID) return;
    if (!TIME_SENSITIVE_PROMPTS.has(promptId)) return;
    const minutes = target.settings?.ai.agent_timeout_minutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES;
    return { limitMs: minutes * 60_000, fallback: backup };
  }

  /**
   * Runs a prompt on the workspace brain. When the main brain fails on its side after its own
   * retries (auth, rate limits, quota, overload, plan limits, server errors, timeouts, not
   * configured) and `ai.fallback_provider` names another provider, the same call runs once on
   * that backup brain, with the same schema, validation and repair. Failures that retrying cannot
   * fix are reported to `deps.health` (the `brain_down` problem of that provider and model); every
   * success reports its provider and model as up again.
   */
  async function run<V, T>(
    prompt: PromptDefinition<V, T>,
    vars: V,
    options: BrainRunOptions = {},
  ): Promise<BrainResult<T>> {
    const startedAt = performance.now();
    const plan = await planOf(prompt, options);
    const { target, choice, backup, forced } = plan;
    let main: BrainRoute | null = null;
    try {
      main = await resolveRoute(choice, target);
      const agentTimeout = agentTimeoutOf(prompt.id, main, backup, target);
      const result = await attempt(prompt, vars, options, target.workspaceId, main, startedAt, {
        ...(agentTimeout ? { agentTimeout } : {}),
      });
      await reportUp(target.workspaceId, main.provider.id, main.model);
      return result;
    } catch (error) {
      if (!isFallbackFailure(error)) throw error;
      // Not configured, in a job, with no backup to answer: report it, then park the job.
      const failed = await reportMainDown(plan, main, error);
      if (!backup || backup === failed) throw waitForBrain(error, options, forced, target);
      log.warn(
        {
          prompt_id: prompt.id,
          provider: failed,
          fallback: backup,
          reason: failureReason(error),
        },
        `the ${failed ?? "main"} brain failed; running the call once on the backup brain ${backup}`,
      );
      let fallbackRoute: BrainRoute | null = null;
      try {
        fallbackRoute = await resolveRoute(backupChoiceOf(prompt, options, plan, backup), target);
        const result = await attempt(
          prompt,
          vars,
          options,
          target.workspaceId,
          fallbackRoute,
          startedAt,
        );
        await reportUp(target.workspaceId, backup, fallbackRoute.model);
        return result;
      } catch (backupError) {
        throw await backupFailed(plan, options, error, backup, fallbackRoute, backupError);
      }
    }
  }

  /**
   * The readiness check (see `BrainServiceWithRoute.ready`): the route `run` would take, resolved
   * without a call. Only a brain that is not configured, with no configured backup brain, stops
   * here, with `run`'s report and error.
   */
  async function ready<V, T>(
    prompt: PromptDefinition<V, T>,
    options: BrainRunOptions = {},
  ): Promise<void> {
    const plan = await planOf(prompt, options);
    const { target, backup, forced } = plan;
    try {
      await resolveRoute(plan.choice, target);
      return;
    } catch (error) {
      if (!isOpenOutboundError(error) || error.code !== "provider_not_configured") return;
      const failed = await reportMainDown(plan, null, error);
      if (!backup || backup === failed) throw waitForBrain(error, options, forced, target);
      try {
        await resolveRoute(backupChoiceOf(prompt, options, plan, backup), target);
      } catch (backupError) {
        throw await backupFailed(plan, options, error, backup, null, backupError);
      }
    }
  }

  /** Where a call of `prompt` goes, before any provider is resolved. */
  async function planOf<V, T>(
    prompt: PromptDefinition<V, T>,
    options: BrainRunOptions,
  ): Promise<CallPlan> {
    const target = await targetOf(options);
    return {
      target,
      choice: chooseRoute(prompt, options, target.settings),
      backup: backupOf(options, target),
      forced: Boolean(options.provider || options.model),
    };
  }

  /**
   * Reports a main brain whose failure retrying cannot fix (`brain_down`) and returns its
   * provider id: null when the workspace names none, which means no brain is configured at all
   * (one problem, no model).
   */
  async function reportMainDown(
    plan: CallPlan,
    main: BrainRoute | null,
    error: OpenOutboundError,
  ): Promise<string | null> {
    const failed = main?.provider.id ?? plan.choice.providerId ?? providerOf(error);
    if (!plan.forced && isBrainDownFailure(error)) {
      const model = failed ? (main?.model ?? plan.choice.model ?? null) : null;
      await reportDown(
        plan.target.workspaceId,
        failed ?? NO_BRAIN_PROVIDER,
        model,
        error,
        plan.backup === failed ? null : plan.backup,
      );
    }
    return failed;
  }

  function backupChoiceOf<V, T>(
    prompt: PromptDefinition<V, T>,
    options: BrainRunOptions,
    plan: CallPlan,
    backup: string,
  ): RouteChoice {
    return chooseRoute(
      prompt,
      { ...(options.tier ? { tier: options.tier } : {}), provider: backup },
      plan.target.settings,
    );
  }

  /** What a call throws when the backup brain failed too (reported when it is down). */
  async function backupFailed(
    plan: CallPlan,
    options: BrainRunOptions,
    error: OpenOutboundError,
    backup: string,
    backupRoute: BrainRoute | null,
    backupError: unknown,
  ): Promise<unknown> {
    if (isBrainDownFailure(backupError)) {
      await reportDown(
        plan.target.workspaceId,
        backup,
        backupRoute?.model ?? null,
        backupError,
        null,
      );
    }
    return waitForBrain(bothFailed(error, backupError, backup), options, plan.forced, plan.target);
  }

  /**
   * A job that needs a brain the workspace does not have (none configured, or the configured
   * one is missing its key) waits instead of failing: `JobWaitError` on
   * `brain:configured:<workspace id>` uses no attempt, and `providers.set` for the brain slot
   * wakes it. Outside jobs, and for a provider the caller forced, the error stays as it is.
   */
  function waitForBrain(
    error: unknown,
    options: BrainRunOptions,
    forced: boolean,
    target: Target,
  ): unknown {
    if (forced || !target.workspaceId) return error;
    if (!isOpenOutboundError(error) || error.code !== "provider_not_configured") return error;
    if (!(options.jobId ?? read(deps.jobId))) return error;
    log.warn(
      { workspace_id: target.workspaceId, err: error.message },
      "no brain is configured; the job waits until one is set",
    );
    const now = deps.clock?.now().getTime() ?? Date.now();
    return new JobWaitError(
      brainConfiguredWaitKey(target.workspaceId),
      new Date(now + BRAIN_WAIT_RECHECK_MS),
    );
  }

  /** One route: the first call, validation and one repair call. */
  async function attempt<V, T>(
    prompt: PromptDefinition<V, T>,
    vars: V,
    options: BrainRunOptions,
    workspaceId: string | null,
    { provider, tier, model }: BrainRoute,
    startedAt: number,
    extras: Pick<ServiceBrainRequest, "agentTimeout"> = {},
  ): Promise<BrainResult<T>> {
    const jobId = options.jobId ?? read(deps.jobId) ?? undefined;
    const jsonSchema = outputJsonSchema(prompt.schema);
    const rendered = prompt.system(vars);
    const system =
      provider.capabilities.structuredOutput === "native"
        ? rendered
        : withSchemaInstruction(rendered, jsonSchema);
    const taskKey = options.taskKey ?? `${prompt.id}:v${prompt.version}:${stableHash(vars, 24)}`;
    const request: ServiceBrainRequest = {
      system,
      messages: [{ role: "user", content: prompt.user(vars) }],
      jsonSchema,
      schemaName: schemaNameFor(prompt.id),
      model,
      maxTokens: options.maxTokens ?? prompt.maxTokens ?? DEFAULT_PROMPT_MAX_TOKENS,
      metadata: {
        promptId: prompt.id,
        taskKey,
        ...(workspaceId ? { workspaceId } : {}),
      },
      tier,
      outputSchema: prompt.schema,
      vars,
      promptVersion: prompt.version,
      attempt: 1,
      ...extras,
    };
    const temperature = options.temperature ?? prompt.temperature;
    if (temperature !== undefined) request.temperature = temperature;

    const scope: CallScope = {
      provider,
      model,
      promptId: prompt.id,
      workspaceId,
      jobId,
      signal: options.signal,
    };
    const finish = (output: T, responses: BrainResponse[], repaired: boolean): BrainResult<T> => {
      const last = responses[responses.length - 1] as BrainResponse;
      return {
        output,
        text: last.text || JSON.stringify(output),
        provider: provider.id,
        model: last.model || model,
        usage: sumUsage(responses),
        repaired,
        durationMs: Math.round(performance.now() - startedAt),
      };
    };

    const first = await call(scope, request);
    const firstCheck = await check(prompt.schema, jsonSchema, first);
    if (firstCheck.ok) return finish(firstCheck.data, [first], false);

    log.info(
      { prompt_id: prompt.id, provider: provider.id, model, problems: firstCheck.problems },
      "brain output invalid; running one repair call",
    );
    const repair: ServiceBrainRequest = {
      ...request,
      attempt: 2,
      messages: [
        ...request.messages,
        { role: "assistant", content: quoteReply(first) },
        { role: "user", content: repairInstruction(firstCheck.problems) },
      ],
      metadata: { ...request.metadata, promptId: prompt.id, taskKey: `${taskKey}:repair` },
    };
    const second = await call(scope, repair);
    const secondCheck = await check(prompt.schema, jsonSchema, second);
    if (secondCheck.ok) return finish(secondCheck.data, [first, second], true);

    throw brainError(
      { label: provider.id, providerId: provider.id, model },
      `The ${provider.id} brain (${model}) returned output that does not match the ${prompt.id} schema, even after a repair attempt.`,
      {
        reason: "invalid_output",
        retryable: false,
        hint: `Retry later, or route ${prompt.id} to a stronger model with workspace settings ai.task_models["${prompt.id}"].`,
        extra: { prompt_id: prompt.id, problems: secondCheck.problems },
      },
    );
  }

  /** One provider call with budget check, concurrency limit, timeout, retries and metering. */
  async function call(scope: CallScope, request: ServiceBrainRequest): Promise<BrainResponse> {
    const { provider } = scope;
    if (scope.workspaceId) await deps.usage.assertBudget(scope.workspaceId, "ai");
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await limiter.run(
          concurrencyLaneOf(provider),
          provider.capabilities.maxConcurrency,
          () => generateWithTimeout(scope, request),
          scope.signal,
        );
        const usage = normalizeUsage(response.usage, response.model || scope.model);
        const normalized: BrainResponse = { ...response, usage };
        await record(scope, response.model || scope.model, usage);
        return normalized;
      } catch (error) {
        if (isJobWaitError(error)) throw agentWait(scope, error);
        const failure = annotate(
          scope.signal?.aborted && !isOpenOutboundError(error)
            ? cancelledError(scope, scope.signal.reason)
            : toBrainFailure(scope, error),
          scope,
        );
        const spent = usageFromDetails(failure.details?.usage);
        if (spent) await record(scope, scope.model, normalizeUsage(spent, scope.model));
        if (scope.signal?.aborted) throw failure;
        if (attempt >= maxAttempts || !isRetryableBrainError(failure)) throw failure;
        const retryAfterMs =
          failure.retryAfterSeconds !== undefined ? failure.retryAfterSeconds * 1000 : undefined;
        if (retryAfterMs !== undefined && retryAfterMs > maxRetryAfterMs) throw failure;
        const delay = Math.max(retryAfterMs ?? 0, brainBackoffMs(attempt));
        log.warn(
          {
            prompt_id: scope.promptId,
            provider: provider.id,
            attempt,
            delay_ms: delay,
            reason: failure.details?.reason,
          },
          "brain call failed; retrying",
        );
        await wait(delay, scope.signal).catch(() => {
          throw failure;
        });
      }
    }
  }

  async function generateWithTimeout(
    scope: CallScope,
    request: ServiceBrainRequest,
  ): Promise<BrainResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, timeoutMs);
    const onCallerAbort = () => controller.abort(scope.signal?.reason);
    scope.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (scope.signal?.aborted) controller.abort(scope.signal.reason);
    try {
      const guard = new Promise<never>((_, reject) => {
        const fail = () =>
          reject(
            timedOut
              ? timeoutError(scope, timeoutMs)
              : cancelledError(scope, controller.signal.reason),
          );
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener("abort", fail, { once: true });
      });
      return await Promise.race([
        scope.provider.generate({ ...request, signal: controller.signal }),
        guard,
      ]);
    } finally {
      clearTimeout(timer);
      scope.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  async function record(scope: CallScope, model: string, usage: BrainUsage): Promise<void> {
    try {
      await deps.usage.record({
        workspaceId: scope.workspaceId,
        slot: "brain",
        provider: scope.provider.id,
        operation: scope.promptId,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens ?? 0,
        costUsd: usage.costUsd ?? null,
        jobId: scope.jobId ?? null,
      });
    } catch (error) {
      log.error(
        { prompt_id: scope.promptId, err: (error as Error).message },
        "could not record brain usage",
      );
    }
  }

  async function reportDown(
    workspaceId: string | null,
    provider: string,
    model: string | null,
    error: OpenOutboundError,
    fallback: string | null,
  ): Promise<void> {
    if (!deps.health || !workspaceId) return;
    try {
      await deps.health.down({
        workspaceId,
        provider,
        model,
        reason: failureReason(error),
        message: error.message,
        hint: error.hint ?? null,
        fallback,
      });
    } catch (caught) {
      log.error({ provider, err: (caught as Error).message }, "could not report the brain as down");
    }
  }

  async function reportUp(
    workspaceId: string | null,
    provider: string,
    model: string,
  ): Promise<void> {
    if (!deps.health || !workspaceId) return;
    try {
      await deps.health.up({ workspaceId, provider, model });
    } catch (caught) {
      log.error({ provider, err: (caught as Error).message }, "could not report the brain as up");
    }
  }

  function agentWait(scope: CallScope, error: JobWaitError): Error {
    if (scope.jobId) return error;
    const taskId = agentTaskIdFromWaitKey(error.waitFor) ?? error.waitFor;
    return new OpenOutboundError(
      "approval_required",
      `This step waits for the connected agent to complete agent task ${taskId} (prompt ${scope.promptId}).`,
      {
        hint: `Read the task with get_agent_tasks (action get, task_id ${taskId}), write JSON that matches its output_schema, send it with submit_agent_task, then repeat this call.`,
        details: { agent_task_id: taskId, wait_for: error.waitFor, prompt_id: scope.promptId },
      },
    );
  }

  return { run, route, ready };
}

function read<T>(value: Lazy<T> | undefined): T | undefined {
  return typeof value === "function" ? (value as () => T)() : value;
}

/** The provider named in an error's details (a route that failed before a provider was known). */
function providerOf(error: unknown): string | null {
  const provider = isOpenOutboundError(error) ? error.details?.provider : undefined;
  return typeof provider === "string" ? provider : null;
}

/**
 * The error of a call whose main and backup brains both failed: it names both, keeps the main
 * failure's details and is retryable when either failure is. Waits (the backup is the agent
 * brain) and failures that are not about the provider pass through unchanged.
 */
function bothFailed(main: OpenOutboundError, backup: unknown, backupId: string): unknown {
  if (!isOpenOutboundError(backup)) return backup;
  if (backup.code !== "provider_error" && backup.code !== "provider_not_configured") return backup;
  const retryable = isRetryable(main) || isRetryable(backup);
  const mainFailure = failureOf(main);
  const retryAfters = [main.retryAfterSeconds, backup.retryAfterSeconds].filter(
    (value): value is number => value !== undefined,
  );
  const code =
    main.code === "provider_not_configured" && backup.code === "provider_not_configured"
      ? "provider_not_configured"
      : "provider_error";
  const hint = main.hint ?? backup.hint;
  return new OpenOutboundError(
    code,
    `${main.message} The backup brain (${backupId}) also failed: ${backup.message}`,
    {
      ...(hint !== undefined ? { hint } : {}),
      details: {
        ...main.details,
        retryable,
        ...(mainFailure ? { failure: { ...mainFailure, retryable } } : {}),
        fallback_provider: backupId,
        fallback_reason: failureReason(backup),
      },
      ...(retryAfters.length > 0 ? { retryAfterSeconds: Math.min(...retryAfters) } : {}),
      cause: main,
    },
  );
}

async function check<T>(
  schema: z.ZodType<T>,
  jsonSchema: JsonSchema,
  response: BrainResponse,
): Promise<CheckResult<T>> {
  const raw = response.json !== undefined ? response.json : parseJsonReply(response.text);
  if (raw === undefined) {
    return { ok: false, problems: ["The reply was not valid JSON."] };
  }
  const result = await schema.safeParseAsync(stripNullOptionals(raw, jsonSchema));
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, problems: describeIssues(result.error.issues) };
}

function quoteReply(response: BrainResponse): string {
  const text = response.text || (response.json !== undefined ? JSON.stringify(response.json) : "");
  if (!text) return "(empty reply)";
  return text.length > REPAIR_QUOTE_CHARS ? `${text.slice(0, REPAIR_QUOTE_CHARS)} [cut]` : text;
}

function repairInstruction(problems: string[]): string {
  return [
    "Your previous reply does not match the required output format:",
    ...problems.map((problem) => `- ${problem}`),
    "Reply again with the complete, corrected JSON object only. Keep everything that was already correct.",
  ].join("\n");
}

function normalizeUsage(usage: BrainUsage | undefined, model: string): BrainUsage {
  const inputTokens = count(usage?.inputTokens);
  const outputTokens = count(usage?.outputTokens);
  const cachedTokens = Math.min(count(usage?.cachedTokens), inputTokens);
  const costUsd =
    usage?.costUsd !== undefined
      ? usage.costUsd
      : computeCostUsd(model, {
          uncachedInputTokens: inputTokens - cachedTokens,
          outputTokens,
          cacheReadTokens: cachedTokens,
        });
  return { inputTokens, outputTokens, cachedTokens, costUsd };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function sumUsage(responses: BrainResponse[]): BrainResult<unknown>["usage"] {
  let costUsd: number | null = null;
  const total = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  for (const response of responses) {
    total.inputTokens += count(response.usage.inputTokens);
    total.outputTokens += count(response.usage.outputTokens);
    total.cachedTokens += count(response.usage.cachedTokens);
    const cost = response.usage.costUsd;
    if (typeof cost === "number") costUsd = Math.round(((costUsd ?? 0) + cost) * 1e6) / 1e6;
  }
  return { ...total, costUsd };
}

function usageFromDetails(value: unknown): BrainUsage | undefined {
  if (!isJsonObject(value)) return undefined;
  const usage: BrainUsage = {
    inputTokens: count(value.inputTokens),
    outputTokens: count(value.outputTokens),
    cachedTokens: count(value.cachedTokens),
  };
  if (typeof value.costUsd === "number" || value.costUsd === null) {
    usage.costUsd = value.costUsd as number | null;
  }
  return usage.inputTokens + usage.outputTokens > 0 ? usage : undefined;
}

/** Turns anything a provider threw into a provider error (plug-ins may throw plain errors). */
function toBrainFailure(scope: CallScope, error: unknown): OpenOutboundError {
  if (isOpenOutboundError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  const network = isFetchError(error);
  const context = { label: scope.provider.id, providerId: scope.provider.id };
  return brainError(
    context,
    `The ${scope.provider.id} brain failed: ${message.replace(/\s+/g, " ").slice(0, 300)}`,
    {
      reason: network ? classifyFetchError(error) : "provider_failure",
      retryable: network,
      hint: network
        ? "Check the network connection; OpenOutbound retries network errors automatically."
        : "Check the brain provider settings with manage_providers (action test).",
      cause: error,
    },
  );
}

/** Adds provider, model and prompt id to an error's details (for doors and logs). */
function annotate(error: OpenOutboundError, scope: CallScope): OpenOutboundError {
  const details = {
    provider: scope.provider.id,
    model: scope.model,
    prompt_id: scope.promptId,
    ...error.details,
  };
  return new OpenOutboundError(error.code, error.message, {
    details,
    status: error.status,
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
    ...(error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
    cause: error.cause ?? error,
  });
}

function timeoutError(scope: CallScope, timeoutMs: number): OpenOutboundError {
  return brainError(
    { label: scope.provider.id, providerId: scope.provider.id },
    `The ${scope.provider.id} brain did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
    {
      reason: "timeout",
      retryable: true,
      hint: "OpenOutbound retries timeouts automatically. If this keeps happening, pick a faster model for this task (workspace settings ai.task_models) or check the provider status.",
    },
  );
}

function cancelledError(scope: CallScope, reason: unknown): OpenOutboundError {
  return brainError(
    { label: scope.provider.id, providerId: scope.provider.id },
    `The call to the ${scope.provider.id} brain was cancelled.`,
    {
      reason: "aborted",
      retryable: false,
      hint: "The caller or the job was stopped; run it again when needed.",
      cause: reason,
    },
  );
}
