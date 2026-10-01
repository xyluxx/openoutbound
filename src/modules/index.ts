import type { EngineModule } from "../core/operation.js";
import { module as brain } from "./brain/index.js";
import { module as campaigns } from "./campaigns/index.js";
import { module as content } from "./content/index.js";
import { module as email } from "./email/index.js";
import { module as enrichment } from "./enrichment/index.js";
import { module as inbox } from "./inbox/index.js";
import { module as keys } from "./keys/index.js";
import { module as knowledge } from "./knowledge/index.js";
import { module as leads } from "./leads/index.js";
import { module as linkedin } from "./linkedin/index.js";
import { module as problems } from "./problems/index.js";
import { module as providersAdmin } from "./providers-admin/index.js";
import { module as relationships } from "./relationships/index.js";
import { module as reports } from "./reports/index.js";
import { module as research } from "./research/index.js";
import { module as sandbox } from "./sandbox/index.js";
import { module as signals } from "./signals/index.js";
import { module as strategy } from "./strategy/index.js";
import { module as system } from "./system/index.js";
import { module as workspaces } from "./workspaces/index.js";

/**
 * Every built-in module, in registration order. Each module only edits its own folder;
 * `system` covers jobs, approvals, audit, webhooks, notifications and agent tasks.
 */
export const modules: EngineModule[] = [
  workspaces,
  keys,
  providersAdmin,
  system,
  brain,
  knowledge,
  leads,
  enrichment,
  research,
  signals,
  email,
  linkedin,
  campaigns,
  inbox,
  content,
  reports,
  problems,
  strategy,
  relationships,
  sandbox,
];
