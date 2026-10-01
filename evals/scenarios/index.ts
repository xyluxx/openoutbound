/** Every eval scenario, in the order the harness runs them. */
import type { Scenario } from "../harness/types.js";
import { bookAfterProposedTime } from "./book-after-proposed-time.js";
import { campaignApproval } from "./campaign-approval.js";
import { crmDoor } from "./crm-door.js";
import { customSignal } from "./custom-signal.js";
import { findUnderBudget } from "./find-under-budget.js";
import { importAndScore } from "./import-and-score.js";
import { inboxTriage } from "./inbox-triage.js";
import { limitsAndSafety } from "./limits-and-safety.js";
import { nextActionsAndProposals } from "./next-actions-and-proposals.js";
import { privacyRequest } from "./privacy-request.js";
import { setupFromWebsite } from "./setup-from-website.js";
import { weeklyReport } from "./weekly-report.js";

// biome-ignore lint/suspicious/noExplicitAny: scenarios carry different setup data shapes
export const SCENARIOS: Scenario<any>[] = [
  setupFromWebsite,
  importAndScore,
  findUnderBudget,
  campaignApproval,
  inboxTriage,
  weeklyReport,
  customSignal,
  limitsAndSafety,
  nextActionsAndProposals,
  bookAfterProposedTime,
  crmDoor,
  privacyRequest,
];

/** Scenario by id, or undefined. */
// biome-ignore lint/suspicious/noExplicitAny: see above
export function findScenario(id: string): Scenario<any> | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}
