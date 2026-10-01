import type { EngineModule } from "../../core/operation.js";
import { dnsDailyJob, dnsDailySchedule } from "./dns-daily-job.js";
import { HEALTH_JOB, healthJob } from "./health-job.js";
import { mailboxLimitsResolver } from "./limits-approval.js";
import { registerOAuthRoutes } from "./oauth-routes.js";
import { mailboxOperations, manageMailboxesTool } from "./operations/index.js";
import { RECONCILE_JOB, reconcileSendsJob } from "./reconcile-job.js";
import { sendEmailJob } from "./send-job.js";
import { SYNC_ALL_JOB, syncAllJob, syncMailboxJob } from "./sync-job.js";
import { registerUnsubscribeRoutes } from "./unsubscribe-routes.js";

export const module: EngineModule = {
  name: "email",
  operations: mailboxOperations,
  tools: [manageMailboxesTool],
  jobs: [sendEmailJob, syncAllJob, syncMailboxJob, healthJob, dnsDailyJob, reconcileSendsJob],
  schedules: [
    { name: "email.sync_mailboxes", cron: "*/5 * * * *", job: SYNC_ALL_JOB, perWorkspace: true },
    { name: "email.health_check", cron: "7 * * * *", job: HEALTH_JOB, perWorkspace: true },
    dnsDailySchedule,
    {
      name: "email.reconcile_sends",
      cron: "*/10 * * * *",
      job: RECONCILE_JOB,
      perWorkspace: true,
    },
  ],
  httpRoutes: [registerUnsubscribeRoutes, registerOAuthRoutes],
  approvalResolvers: [mailboxLimitsResolver],
};
