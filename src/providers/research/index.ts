import type { ProviderDefinition } from "../types.js";
import { builtinResearchProvider } from "./builtin.js";
import { exaProvider } from "./exa.js";
import { firecrawlProvider } from "./firecrawl.js";
import { parallelProvider } from "./parallel.js";
import { tavilyProvider } from "./tavily.js";

/** Built-in providers for the "research" slot. The sandbox module adds its own. */
export const providers: ProviderDefinition<"research">[] = [
  parallelProvider,
  exaProvider,
  tavilyProvider,
  firecrawlProvider,
  builtinResearchProvider,
];
