/**
 * Brain health for the runtime: a brain that fails in a way retrying cannot fix (a rejected key,
 * a used-up quota, a missing model or CLI, a provider that is not configured) opens one
 * `brain_down` problem per provider and model; the next successful call with that provider and
 * model resolves it, so a model that fails for one task is not closed by others that work. A
 * provider that failed before a model was chosen (not configured) has one problem per provider,
 * resolved by any successful call on it. A workspace with no brain configured at all gets one
 * for provider "none", which any brain answering resolves.
 */
import {
  BRAIN_DOWN_REMEDY,
  type BrainHealthReporter,
  NO_BRAIN_PROVIDER,
} from "../brain/fallback.js";
import type { OpContext } from "../core/context.js";
import { openProblem, resolveProblemsFor } from "../modules/problems/service.js";

/** Dedupe key of a `brain_down` problem: per provider and model, or per provider without one. */
export function brainDownKey(provider: string, model: string | null = null): string {
  return model ? `brain_down:${provider}:${model}` : `brain_down:${provider}`;
}

/** Title of a `brain_down` problem. */
function downTitle(provider: string, model: string | null): string {
  if (provider === NO_BRAIN_PROVIDER) return "No AI brain is configured";
  return model
    ? `The ${provider} brain is not working with model ${model}`
    : `The ${provider} brain is not working`;
}

/**
 * A reporter bound to a context. It acts only for calls in the context's own workspace (calls
 * for another workspace, or instance-level calls, are left alone).
 */
export function createBrainHealthReporter(context: () => OpContext): BrainHealthReporter {
  const scoped = (workspaceId: string): OpContext | null => {
    const ctx = context();
    return ctx.workspace?.id === workspaceId ? ctx : null;
  };
  return {
    async down(input) {
      const ctx = scoped(input.workspaceId);
      if (!ctx) return;
      const meanwhile = input.fallback
        ? `Until it works again, the backup brain (${input.fallback}) answers the AI steps.`
        : "AI steps (writing, sorting replies, research) stop until it works again.";
      await openProblem(ctx, {
        kind: "brain_down",
        severity: "high",
        owner: "person",
        title: downTitle(input.provider, input.model),
        reason: [input.message, input.hint, meanwhile].filter(Boolean).join(" "),
        remedy: BRAIN_DOWN_REMEDY,
        data: {
          provider: input.provider,
          model: input.model,
          reason: input.reason,
          fallback: input.fallback,
        },
        dedupeKey: brainDownKey(input.provider, input.model),
      });
    },
    async up(input) {
      const ctx = scoped(input.workspaceId);
      if (!ctx) return;
      await resolveProblemsFor(
        ctx,
        { dedupeKey: brainDownKey(input.provider, input.model) },
        `The ${input.provider} brain answered again with model ${input.model}.`,
      );
      // The provider works, so a problem opened before any model was chosen is over too.
      await resolveProblemsFor(
        ctx,
        { dedupeKey: brainDownKey(input.provider) },
        `The ${input.provider} brain answered again.`,
      );
      await resolveProblemsFor(
        ctx,
        { dedupeKey: brainDownKey(NO_BRAIN_PROVIDER) },
        `A brain is configured now: ${input.provider} answered.`,
      );
    },
  };
}
