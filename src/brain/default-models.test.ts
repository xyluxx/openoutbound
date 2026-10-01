/**
 * Any one AI key is enough (README, .env.example): with only that key in the environment,
 * every prompt and every tier routes to a model of that provider.
 */
import { describe, expect, it } from "vitest";
import { MODEL_TIERS } from "../core/enums.js";
import { connectionTestPrompt } from "../modules/brain/prompts/connection-test.js";
import {
  checkPrompt,
  fillSlotsPrompt,
  teachPrompt,
  writeEmailPrompt,
  writeLinkedInPrompt,
} from "../modules/campaigns/writing/prompts.js";
import { draftPostPrompt } from "../modules/content/prompts/draft-post.js";
import { teamExtractionPrompt } from "../modules/enrichment/prompts/team.js";
import { checkReplyPrompt } from "../modules/inbox/prompts/check.js";
import { classifyReplyPrompt } from "../modules/inbox/prompts/classify.js";
import { draftReplyPrompt } from "../modules/inbox/prompts/draft.js";
import { bootstrapPrompt } from "../modules/knowledge/prompts/bootstrap.js";
import { icpRefinePrompt } from "../modules/leads/prompts/icp-refine.js";
import { importMappingPrompt } from "../modules/leads/prompts/import-mapping.js";
import { reportSummaryPrompt } from "../modules/reports/prompts/summary.js";
import { briefPrompt } from "../modules/research/prompts/brief.js";
import { classifyItems } from "../modules/signals/prompts/classify-items.js";
import { classifyWebsiteChange } from "../modules/signals/prompts/classify-website-change.js";
import { evaluateCustomSignal } from "../modules/signals/prompts/evaluate-custom.js";
import { OPENAI_DEFAULT_MODELS } from "../providers/brain/openai.js";
import {
  GEMINI_DEFAULT_MODELS,
  OPENROUTER_DEFAULT_MODELS,
} from "../providers/brain/openai-compatible.js";
import { createTestEngine } from "../testing/engine.js";
import type { PromptDefinition } from "./prompt.js";
import type { BrainServiceWithRoute } from "./service.js";

/** Every prompt the engine runs. */
const PROMPTS: Array<PromptDefinition<never, unknown>> = [
  writeEmailPrompt,
  writeLinkedInPrompt,
  fillSlotsPrompt,
  checkPrompt,
  teachPrompt,
  draftPostPrompt,
  teamExtractionPrompt,
  checkReplyPrompt,
  classifyReplyPrompt,
  draftReplyPrompt,
  bootstrapPrompt,
  icpRefinePrompt,
  importMappingPrompt,
  reportSummaryPrompt,
  briefPrompt,
  classifyItems,
  classifyWebsiteChange,
  evaluateCustomSignal,
  connectionTestPrompt,
] as Array<PromptDefinition<never, unknown>>;

describe.each([
  { env: "OPENAI_API_KEY", provider: "openai", models: OPENAI_DEFAULT_MODELS },
  { env: "OPENROUTER_API_KEY", provider: "openrouter", models: OPENROUTER_DEFAULT_MODELS },
  { env: "GEMINI_API_KEY", provider: "gemini", models: GEMINI_DEFAULT_MODELS },
])("with only $env set", ({ env, provider, models }) => {
  it("routes every prompt and every tier to the provider's default model", async () => {
    const engine = await createTestEngine({ config: { env: { [env]: "test-key-not-real" } } });
    try {
      const workspace = (await engine.call("workspaces.create", { name: "Acme" })) as {
        id: string;
      };
      const ctx = await engine.systemContext(workspace.id);
      const brain = ctx.brain as BrainServiceWithRoute;
      for (const prompt of PROMPTS) {
        const route = await brain.route(prompt);
        expect(route.provider.id, prompt.id).toBe(provider);
        expect(route.model, prompt.id).toBe(models[prompt.tier]);
      }
      for (const tier of MODEL_TIERS) {
        const route = await brain.route(connectionTestPrompt, { tier });
        expect(route.model, tier).toBe(models[tier]);
      }
    } finally {
      await engine.close();
    }
  });
});
