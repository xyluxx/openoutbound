import { defineTool, type EngineModule } from "../../core/operation.js";
import {
  getChange,
  getProposalOp,
  getStrategy,
  listChanges,
  listProposalsOp,
  proposeChangeOp,
  undoChangeOp,
} from "./operations.js";
import { changeApprovalResolver, followOperationApproval } from "./proposals.js";
import { reviewProposalsJob, reviewProposalsSchedule } from "./review.js";

export const manageStrategyTool = defineTool({
  name: "manage_strategy",
  title: "Strategy, changes and proposals",
  description:
    "The client's strategy page and its history. Read action get at the start of every session: it holds the offers, ICPs, voice, reply rules, booking and CRM preferences, the owner's goals and notes, active lessons, the last changes and the precedence line. Actions: get, changes (the change log, newest first), change (one change with before and after values), undo, propose (a change with reason, evidence and expected outcome; it applies at once or waits for an owner's approval), proposals, proposal (with results after review_after_days). Not for setup progress or health: use get_status.",
  toolset: "core",
  actions: {
    get: "strategy.get",
    changes: "changes.list",
    change: "changes.get",
    undo: "changes.undo",
    propose: "changes.propose",
    proposals: "proposals.list",
    proposal: "proposals.get",
  },
});

/**
 * Strategy: the strategy page every agent reads first, the change log with undo, change
 * proposals applied through the normal executor (approval kind `change`) and their results.
 * Other modules record changes through `service.ts` (`recordChange`).
 */
export const module: EngineModule = {
  name: "strategy",
  operations: [
    getStrategy,
    listChanges,
    getChange,
    undoChangeOp,
    proposeChangeOp,
    listProposalsOp,
    getProposalOp,
  ],
  tools: [manageStrategyTool],
  jobs: [reviewProposalsJob],
  schedules: [reviewProposalsSchedule],
  eventHandlers: [followOperationApproval],
  approvalResolvers: [changeApprovalResolver],
};
