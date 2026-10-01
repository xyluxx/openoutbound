import type { EngineModule } from "../../core/operation.js";
import { wakeOnHoldChange } from "./events.js";
import { relationshipOperations } from "./operations.js";
import { STUCK_CHECK_JOB, stuckCheckJob } from "./stuck.js";
import { relationshipTools } from "./tools.js";

/**
 * Relationships: one view per person (state, next action, blockers, stuck), the send gate the
 * senders and the views share (`gate.ts`, `service.ts`), the stuck rules (job every 15 minutes)
 * and the operator tools get_operating_state, get_next_actions and explain_blocker. A changed
 * company hold wakes the sends waiting for it.
 */
export const module: EngineModule = {
  name: "relationships",
  operations: relationshipOperations,
  tools: relationshipTools,
  jobs: [stuckCheckJob],
  eventHandlers: [wakeOnHoldChange],
  schedules: [
    { name: STUCK_CHECK_JOB, cron: "*/15 * * * *", job: STUCK_CHECK_JOB, perWorkspace: true },
  ],
};
