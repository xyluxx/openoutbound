import type { BrainRunOptions } from "../core/context.js";
import type { ModelTier } from "../core/enums.js";
import { OpenOutboundError } from "../core/errors.js";
import type { WorkspaceSettings } from "../core/settings.js";
import type { BrainProvider } from "../providers/types.js";
import type { PromptDefinition } from "./prompt.js";

/** Where a prompt should run, before the provider is resolved. */
export interface RouteChoice {
  tier: ModelTier;
  /** Unset = the workspace's default brain provider. */
  providerId?: string;
  /** Unset = the provider's model for the tier. */
  model?: string;
}

/**
 * Picks tier, provider and model for a prompt. Precedence, first wins:
 * 1. run options: `model` forces the model (settings are skipped), `provider` and `tier`,
 * 2. `settings.ai.task_models[<prompt id>]` (provider, model, tier),
 * 3. `settings.ai.task_models[<tier>]` (provider, model),
 * 4. the prompt's tier on the default provider with the provider's model for that tier.
 * A model from settings is only used when its entry names the chosen provider (or both name
 * none, meaning the default provider), so a model id never lands on the wrong provider.
 */
export function chooseRoute(
  prompt: Pick<PromptDefinition<unknown, unknown>, "id" | "tier">,
  options: Pick<BrainRunOptions, "tier" | "provider" | "model"> = {},
  settings: Pick<WorkspaceSettings, "ai"> | null = null,
): RouteChoice {
  if (options.model) {
    const forced: RouteChoice = { tier: options.tier ?? prompt.tier, model: options.model };
    if (options.provider) forced.providerId = options.provider;
    return forced;
  }
  const taskModels = settings?.ai.task_models ?? {};
  const promptLevel = taskModels[prompt.id];
  const tier = options.tier ?? promptLevel?.tier ?? prompt.tier;
  const tierLevel = taskModels[tier];
  const providerId = options.provider ?? promptLevel?.provider ?? tierLevel?.provider;
  const model = [promptLevel, tierLevel].find(
    (level) => level?.model && level.provider === providerId,
  )?.model;
  const choice: RouteChoice = { tier };
  if (providerId) choice.providerId = providerId;
  if (model) choice.model = model;
  return choice;
}

/** Tiers to try, in order, when a provider has no model for the requested tier. */
export const TIER_FALLBACK: Readonly<Record<ModelTier, readonly ModelTier[]>> = {
  fast: ["fast", "standard", "deep"],
  standard: ["standard", "deep", "fast"],
  deep: ["deep", "standard", "fast"],
};

/**
 * The provider's model for a tier (configured `models` merged over its defaults), falling back
 * to a neighboring tier. Throws `provider_not_configured` when the provider has no model at all.
 */
export function modelForTier(provider: BrainProvider, tier: ModelTier): string {
  for (const candidate of TIER_FALLBACK[tier]) {
    const model = provider.defaultModels[candidate];
    if (model) return model;
  }
  throw new OpenOutboundError(
    "provider_not_configured",
    `The ${provider.id} brain has no model configured for the ${tier} tier.`,
    {
      hint: `Set models in the provider config, e.g. manage_providers action set (slot brain, provider ${provider.id}, config {"models":{"standard":"<model id>"}}); one model covers every tier. Or map the tier in workspace settings ai.task_models.${tier}.model.`,
      details: { provider: provider.id, tier },
    },
  );
}
