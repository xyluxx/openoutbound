import { defineTool, type EngineModule } from "../../core/operation.js";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  pauseWorkspace,
  resumeWorkspace,
  updateWorkspace,
} from "./operations.js";
import { workspaceReadiness } from "./readiness.js";
import { exportSetup, importSetupOperation } from "./setup-transfer.js";
import { workspaceStatus } from "./status.js";

export const module: EngineModule = {
  name: "workspaces",
  operations: [
    listWorkspaces,
    createWorkspace,
    getWorkspace,
    updateWorkspace,
    pauseWorkspace,
    resumeWorkspace,
    workspaceStatus,
    workspaceReadiness,
    exportSetup,
    importSetupOperation,
  ],
  tools: [
    defineTool({
      name: "get_status",
      title: "Get status",
      description:
        "Setup and health check: returns the workspace setup checklist with the next step, whether email and LinkedIn can reach a real person (sending: blockers and the exact fix for each), which provider serves each slot, health warnings (paused senders, budgets, failing jobs) and how many items wait for a human. Call it first in a new workspace and after setup changes; in a running workspace start the session with manage_strategy (action get) and get_operating_state. Use get_attention_queue or review_items to see the items themselves. Read-only and cheap.",
      toolset: "core",
      operation: "workspaces.status",
    }),
    defineTool({
      name: "manage_workspaces",
      title: "Manage workspaces",
      description:
        "Lists, creates and updates workspaces (one per client or brand), pauses or resumes all sending (the kill switch) and copies a client's setup. Actions: list, create, get, update (name, timezone, settings deep-merge), pause, resume, status, readiness (can it send for real, and if not, why), export_setup (settings, offers, ICPs, signals, automations, knowledge and templates as one JSON document), import_setup (dry run by default; skips names that exist). Use pause immediately when something looks wrong; resume needs the send scope. Do not create workspaces to practice: use the sandbox.",
      toolset: "admin",
      actions: {
        list: "workspaces.list",
        create: "workspaces.create",
        get: "workspaces.get",
        update: "workspaces.update",
        pause: "workspaces.pause",
        resume: "workspaces.resume",
        status: "workspaces.status",
        readiness: "workspaces.readiness",
        export_setup: "workspaces.export_setup",
        import_setup: "workspaces.import_setup",
      },
    }),
  ],
};
