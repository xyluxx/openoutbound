import { onEvent } from "../../core/events.js";
import { companyHoldKey } from "./checks-common.js";

/**
 * A company hold that changed (set, moved or released) wakes the sends the gate parked for it:
 * they look again at once and go when the hold is over, or wait for the new end.
 */
export const wakeOnHoldChange = onEvent(
  "company.hold_changed",
  "relationships.wake_on_hold_change",
  async (ctx, event) => {
    await ctx.jobs.wake(companyHoldKey(event.data.company_id));
  },
);
