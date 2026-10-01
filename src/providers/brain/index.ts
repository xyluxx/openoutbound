import type { ProviderDefinition } from "../types.js";
import { agentBrainProvider } from "./agent.js";
import { anthropicBrainProvider } from "./anthropic.js";
import { claudeCliBrainProvider } from "./claude-cli.js";
import { codexCliBrainProvider } from "./codex-cli.js";
import { fakeBrainProvider } from "./fake.js";
import { geminiBrainProvider } from "./gemini.js";
import { openaiBrainProvider } from "./openai.js";
import { openaiCompatibleBrainProvider } from "./openai-compatible.js";
import { openrouterBrainProvider } from "./openrouter.js";

/**
 * Built-in providers for the "brain" slot, in default priority order: API-key providers first
 * (they also resolve from env vars), then local servers, the user's own CLIs, the connected
 * agent, and the fake brain for sandbox workspaces.
 */
export const providers: ProviderDefinition<"brain">[] = [
  anthropicBrainProvider,
  openaiBrainProvider,
  openrouterBrainProvider,
  geminiBrainProvider,
  openaiCompatibleBrainProvider,
  claudeCliBrainProvider,
  codexCliBrainProvider,
  agentBrainProvider,
  fakeBrainProvider,
];
