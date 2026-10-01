import { defineTool, type EngineModule } from "../../core/operation.js";
import { registerSandboxBrainAnswers } from "../../sandbox/brain/answers.js";
import { providers } from "../../sandbox/providers/index.js";
import { scheduleSimulatedReply } from "../../sandbox/simulator/event-handler.js";
import {
  simulateEmailReplyJob,
  simulateLinkedInAcceptJob,
  simulateLinkedInReplyJob,
  simulateMeetingBookingJob,
  simulateMeetingNoShowJob,
} from "../../sandbox/simulator/jobs.js";
import { getSandboxStatus, seedSandbox, simulateSandbox } from "./operations.js";

// Sandbox workspaces always run on the fake brain (src/providers/brain/fake.ts); give it
// realistic, deterministic answers so campaign previews, replies, briefs and reports are not
// just the smallest schema-valid sample.
registerSandboxBrainAnswers();

export const module: EngineModule = {
  name: "sandbox",
  operations: [seedSandbox, getSandboxStatus, simulateSandbox],
  jobs: [
    simulateEmailReplyJob,
    simulateLinkedInAcceptJob,
    simulateLinkedInReplyJob,
    simulateMeetingBookingJob,
    simulateMeetingNoShowJob,
  ],
  eventHandlers: [scheduleSimulatedReply],
  providers,
  tools: [
    defineTool({
      name: "manage_sandbox",
      title: "Sandbox",
      description:
        "The practice workspaces (northwind and brightsmile): invented data, and nothing real is ever sent. Actions: status (what each one holds, pending simulated replies and prompts to try), seed (create them, or rebuild them with reset: true; needs the admin scope), simulate (in a sandbox workspace, deliver the pending simulated replies, bounces, LinkedIn acceptances and meeting bookings now instead of waiting minutes for them). For real workspaces use manage_workspaces.",
      toolset: "admin",
      actions: {
        status: "sandbox.status",
        seed: "sandbox.seed",
        simulate: "sandbox.simulate",
      },
    }),
  ],
};
