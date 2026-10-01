import { defineTool, type EngineModule } from "../../core/operation.js";
import {
  listProviders,
  providerCatalog,
  removeProvider,
  setProvider,
  testProvider,
} from "./operations.js";

export const module: EngineModule = {
  name: "providers-admin",
  operations: [providerCatalog, listProviders, setProvider, removeProvider, testProvider],
  tools: [
    defineTool({
      name: "manage_providers",
      title: "Manage providers",
      description:
        "Shows and configures the plug-ins behind each slot (AI brain, lead sources, email finders and verifiers, research, signals, LinkedIn, social, CRM). Actions: catalog (every provider, docs link, secrets it needs, configured or not), list (what serves each slot and why), set (store secrets encrypted, config, priority), remove, test (cheap live check). Secret values are write-only: they are never returned. Env vars such as ANTHROPIC_API_KEY also work without set.",
      toolset: "admin",
      actions: {
        catalog: "providers.catalog",
        list: "providers.list",
        set: "providers.set",
        remove: "providers.remove",
        test: "providers.test",
      },
    }),
  ],
};
