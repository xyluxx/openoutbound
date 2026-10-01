import type { ProviderDefinition } from "../types.js";
import { apolloProvider } from "./apollo.js";
import { googleMapsProvider } from "./google-maps.js";

/** Built-in providers for the "lead_source" slot. Add each provider module here. */
export const providers: ProviderDefinition<"lead_source">[] = [apolloProvider, googleMapsProvider];
