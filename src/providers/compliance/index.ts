import type { ProviderDefinition } from "../types.js";
import { preclearedProvider } from "./precleared.js";

/** Built-in providers for the "compliance" slot. Add each provider module here. */
export const providers: ProviderDefinition<"compliance">[] = [preclearedProvider];
