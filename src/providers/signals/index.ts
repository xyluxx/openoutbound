import type { ProviderDefinition } from "../types.js";
import { crustdataProvider } from "./crustdata.js";
import { predictleadsProvider } from "./predictleads.js";
import { webhookSignalsProvider } from "./webhook.js";

/** Built-in providers for the "signals" slot. Add each provider module here. */
export const providers: ProviderDefinition<"signals">[] = [
  predictleadsProvider as ProviderDefinition<"signals">,
  crustdataProvider as ProviderDefinition<"signals">,
  webhookSignalsProvider as ProviderDefinition<"signals">,
];
