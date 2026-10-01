import { defineTool } from "../../core/operation.js";

/** MCP tools of the problems module (upgrade plan: resolve_exception in core). */
export const problemTools = [
  defineTool({
    name: "resolve_exception",
    title: "List, read, resolve or snooze problems",
    description:
      "Closes the loop on a problem from get_attention_queue (privacy request, unknown send, stuck relationship, meeting to book, outage). Do the remedy the problem names first, then resolve it with a short note: when the problem is about a person you get their fresh relationship view (next action and anything still blocking). Snooze it until a time when it has to wait. A send_unknown problem closes when you settle its message with manage_messages action resolve_unknown, not here. Actions: list (status, kinds, person_id; open problems by default), get (problem_id; the facts a remedy refers to, in data), resolve (problem_id, resolution), snooze (problem_id, until). Not for approvals: use review_items.",
    toolset: "core",
    actions: {
      list: "problems.list",
      get: "problems.get",
      resolve: "problems.resolve",
      snooze: "problems.snooze",
    },
  }),
];
