import type { ProviderDefinition } from "../types.js";
import { findymailProvider } from "./findymail.js";
import { hunterProvider } from "./hunter.js";
import { icypeasProvider } from "./icypeas.js";
import { prospeoProvider } from "./prospeo.js";

/** Built-in providers for the "email_finder" slot. Add each provider module here. */
export const providers: ProviderDefinition<"email_finder">[] = [
  icypeasProvider,
  findymailProvider,
  hunterProvider,
  prospeoProvider,
];
