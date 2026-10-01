import { defineTool, type EngineModule } from "../../core/operation.js";
import { enrichJob, findContactsJob } from "./jobs.js";
import { enrichmentOperations } from "./operations.js";

export const enrichLeadsTool = defineTool({
  name: "enrich_leads",
  title: "Enrich leads",
  description:
    "Finds and verifies email addresses: enrich runs the waterfall (existing address check, the company website, then the configured email finders, then the verifier) as a background job, verify re-checks up to 25 stored addresses now, and find_contacts crawls company websites to fill company details and create the decision makers named there. Use it after import_leads or find_leads when people lack verified emails, or for local businesses imported without people. People we may never email (suppressed, customers, consent-required countries) are skipped for free. Not for searching new leads (use find_leads); finders and verifiers spend credits, so start with dry_run.",
  toolset: "leads",
  actions: {
    enrich: "enrichment.enrich",
    verify: "enrichment.verify",
    find_contacts: "enrichment.find_contacts",
  },
});

export const module: EngineModule = {
  name: "enrichment",
  operations: enrichmentOperations,
  tools: [enrichLeadsTool],
  jobs: [enrichJob, findContactsJob],
};
