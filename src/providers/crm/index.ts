import type { ProviderDefinition } from "../types.js";
import { hubspotProvider } from "./hubspot.js";
import { pipedriveProvider } from "./pipedrive.js";
import { crmWebhookProvider } from "./webhook.js";

/** Built-in providers for the "crm" slot. Add each provider module here. */
export const providers: ProviderDefinition<"crm">[] = [
  hubspotProvider,
  pipedriveProvider,
  crmWebhookProvider,
];
