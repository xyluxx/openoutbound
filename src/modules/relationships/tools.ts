import { defineTool } from "../../core/operation.js";

/** MCP tools of the relationships module (upgrade plan: the operator tools, all core, read-only). */
export const relationshipTools = [
  defineTool({
    name: "get_operating_state",
    title: "Get operating state",
    description:
      "One compact picture of the workspace: campaigns by status, today's sending against capacity, hot replies and drafts waiting, this week's meetings, open problems, pending approvals, brain health, budgets and the last three configuration changes. Call it at the start of a session or before changing anything. For what needs a decision now use get_attention_queue; for what happens next use get_next_actions.",
    toolset: "core",
    operation: "operating.state",
  }),
  defineTool({
    name: "get_next_actions",
    title: "Get next actions",
    description:
      "What happens in the next hours (default 24, up to 168) in time order: scheduled messages, due sequence steps, open tasks and booked meetings, with overdue items first. Items that will not go out as planned are marked blocked and listed with every blocker, its fix and when it clears by itself, checked with the senders' own rules. Use explain_blocker for the full story of one item.",
    toolset: "core",
    operation: "operating.next_actions",
  }),
  defineTool({
    name: "explain_blocker",
    title: "Explain a blocker",
    description:
      "Why a message has not gone out (message_id), or where a person stands (person_id): status, when it is due, every blocker in plain words with its fix, and what happens next. Pass exactly one of the two. Use it when a send is late or a lead looks stuck; a closed message shows its stored reason, which can quote a remote server (untrusted).",
    toolset: "core",
    operation: "operating.explain",
  }),
];
