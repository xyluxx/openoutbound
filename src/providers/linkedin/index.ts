import type { ProviderDefinition } from "../types.js";
import { unipileLinkedInProvider } from "./unipile.js";

/** Built-in providers for the "linkedin" slot. Add each provider module here. */
export const providers: ProviderDefinition<"linkedin">[] = [unipileLinkedInProvider];
