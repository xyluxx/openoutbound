import { defineTool, type EngineModule } from "../../core/operation.js";
import { linkedinActionJob } from "./action-job.js";
import { linkedinOperations } from "./operations.js";
import { syncAccountJob, syncWorkspaceJob, webhookEventJob } from "./sync.js";
import { unipileRoutes } from "./webhook.js";

export const manageLinkedIn = defineTool({
  name: "manage_linkedin",
  title: "LinkedIn accounts",
  description:
    "Manages the LinkedIn accounts that run LinkedIn campaign steps (visits, invites, messages, likes, comments) with engine-enforced safety: daily and weekly caps, ramp for new accounts, working hours, random gaps and restriction handling. Actions: list (accounts, caps, today's usage), connect (hosted login link; needs accept_risk from the human), update (limits, hours, timezone, premium, ramp), pause, resume (humans only for restricted accounts), remove, sync (pull accepted invites and replies now), relations (who is invited or connected). Do not use it to send one-off messages; LinkedIn actions run only as campaign steps. LinkedIn's terms forbid automation, so never connect an account without the human's explicit consent.",
  toolset: "core",
  actions: {
    list: "linkedin.accounts.list",
    connect: "linkedin.accounts.connect",
    update: "linkedin.accounts.update",
    pause: "linkedin.accounts.pause",
    resume: "linkedin.accounts.resume",
    remove: "linkedin.accounts.remove",
    sync: "linkedin.accounts.sync",
    relations: "linkedin.relations.list",
  },
});

export const module: EngineModule = {
  name: "linkedin",
  operations: linkedinOperations,
  tools: [manageLinkedIn],
  jobs: [linkedinActionJob, syncWorkspaceJob, syncAccountJob, webhookEventJob],
  schedules: [
    {
      name: "linkedin.sync",
      cron: "*/15 * * * *",
      job: "linkedin.sync_workspace",
      perWorkspace: true,
    },
  ],
  httpRoutes: [unipileRoutes],
};
