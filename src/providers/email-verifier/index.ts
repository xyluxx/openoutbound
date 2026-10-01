import type { ProviderDefinition } from "../types.js";
import { millionVerifierProvider } from "./millionverifier.js";
import { reoonProvider } from "./reoon.js";

/** Built-in providers for the "email_verifier" slot. Add each provider module here. */
export const providers: ProviderDefinition<"email_verifier">[] = [
  millionVerifierProvider,
  reoonProvider,
];
