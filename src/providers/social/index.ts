import type { ProviderDefinition } from "../types.js";
import { linkedinOfficialProvider } from "./linkedin-official.js";
import { unipileSocialProvider } from "./unipile.js";

/** Built-in providers for the "social" slot. Add each provider module here. */
export const providers: ProviderDefinition<"social">[] = [
  linkedinOfficialProvider,
  unipileSocialProvider,
];
