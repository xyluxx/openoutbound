import { z } from "zod";
import type { ModelTier } from "../../core/enums.js";
import type { BrainProvider, ProviderTestResult } from "../types.js";

/** Model ids per tier. A single model is enough: the brain uses it for every tier. */
export type BrainModels = Partial<Record<ModelTier, string>>;

/** `models` in brain provider configs. */
export const brainModelsSchema = z
  .object({
    fast: z.string().min(1).optional().describe("Model for quick, cheap tasks (classification)"),
    standard: z.string().min(1).optional().describe("Model for most tasks (drafting, research)"),
    deep: z.string().min(1).optional().describe("Model for the hardest tasks (strategy)"),
  })
  .describe("Model id per tier; one model covers every tier");

/** `max_concurrency` in brain provider configs. */
export const maxConcurrencySchema = z
  .number()
  .int()
  .min(1)
  .max(64)
  .describe("Max parallel calls to this provider");

/** Configured models over the provider defaults (empty strings are ignored). */
export function mergeModels(defaults: BrainModels, configured?: BrainModels): BrainModels {
  const merged: BrainModels = { ...defaults };
  for (const [tier, model] of Object.entries(configured ?? {})) {
    if (typeof model === "string" && model.trim()) merged[tier as ModelTier] = model.trim();
  }
  return merged;
}

/** A brain provider instance that can check its connection without spending credits. */
export interface CheckableBrainProvider extends BrainProvider {
  check?(): Promise<ProviderTestResult>;
  /**
   * Concurrency lane for the brain service (default: the provider id). Set it when one provider
   * id reaches different servers, so their limits never mix.
   */
  concurrencyKey?: string;
}

/** `ProviderDefinition.test` for brain providers: runs the instance's own cheap check. */
export async function testBrainProvider(instance: BrainProvider): Promise<ProviderTestResult> {
  const check = (instance as CheckableBrainProvider).check;
  if (!check) return { ok: true, message: `The ${instance.id} brain is configured.` };
  try {
    return await check.call(instance);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Trims a base URL and removes trailing slashes. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
