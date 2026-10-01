import { providers as brain } from "./brain/index.js";
import { providers as crm } from "./crm/index.js";
import { providers as emailFinder } from "./email-finder/index.js";
import { providers as emailVerifier } from "./email-verifier/index.js";
import { providers as leadSource } from "./lead-source/index.js";
import { providers as linkedin } from "./linkedin/index.js";
import { providers as research } from "./research/index.js";
import { providers as signals } from "./signals/index.js";
import { providers as social } from "./social/index.js";
import type { ProviderDefinition } from "./types.js";

/** Every built-in provider, grouped by slot order. Modules may contribute more (EngineModule.providers). */
export const builtinProviders: ProviderDefinition[] = [
  ...brain,
  ...leadSource,
  ...emailFinder,
  ...emailVerifier,
  ...research,
  ...signals,
  ...linkedin,
  ...social,
  ...crm,
];
