/**
 * The agent's part of the first-hour tour (docs/getting-started/first-hour.md, step 7), as the
 * MCP calls an agent makes for each prompt on that page. The sandbox tour test runs it through
 * embedded MCP; the docs test runs it through `serve` and names the steps in the page with
 * `<!-- agent: <step> -->`.
 */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import type { CliDeps } from "../../src/cli/context.js";
import type { CliIO } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/program.js";

export interface ToolResult {
  isError?: boolean;
  content: Array<{ text?: string }>;
  structuredContent?: Record<string, unknown>;
}

export type Call = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

/** What one step learns for the next: the campaign and the approval the launch created. */
export interface TourState {
  campaignId: string;
  launchApproval: string;
  /** The text the agent got back from the launch (the page quotes it). */
  launchAnswer?: string;
}

/**
 * One agent session: `openoutbound mcp --workspace northwind` with an MCP client on the other end
 * of an in-memory transport. Every tool call must succeed. Returns the session's stderr.
 */
export async function agentSession(
  deps: CliDeps,
  work: (call: Call) => Promise<void>,
): Promise<string> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  let stderr = "";
  const io: CliIO = {
    stdout: () => {},
    stderr: (text) => {
      stderr += text;
    },
    stdoutIsTTY: false,
    stderrIsTTY: false,
  };
  const code = await runCli(["mcp", "--workspace", "northwind"], {
    ...deps,
    io,
    mcpTransport: serverSide,
    waitForShutdown: async () => {
      const agent = new Client({ name: "tour-agent", version: "1.0.0" });
      await agent.connect(clientSide);
      try {
        await work(async (name, args) => {
          const result = (await agent.callTool({ name, arguments: args })) as ToolResult;
          const text = result.content.map((block) => block.text).join("\n");
          expect(result.isError, `${name}: ${text}`).toBeFalsy();
          return result;
        });
      } finally {
        await agent.close();
      }
    },
  });
  expect(code, stderr).toBe(0);
  return stderr;
}

export const TOUR_AGENT_STEPS: Record<string, (call: Call, state: TourState) => Promise<void>> = {
  /** "Show me the operating state of my OpenOutbound workspace." */
  "operating-state": async (call) => {
    const state = await call("get_operating_state", {});
    expect(JSON.stringify(state.structuredContent)).toContain("Northwind Analytics (sandbox)");
  },

  /**
   * "Enroll the best operations leads in the Signal-triggered ops outreach campaign, show me
   * the launch checklist, then launch it."
   */
  "propose-campaign": async (call, state) => {
    const campaigns = await call("get_campaigns", { action: "list" });
    const items = (campaigns.structuredContent?.items ?? []) as Array<{ id: string; name: string }>;
    state.campaignId =
      items.find((item) => item.name === "Signal-triggered ops outreach")?.id ?? "";
    expect(state.campaignId).not.toBe("");
    const people = await call("search_leads", {
      action: "people",
      query: "operations",
      has_email: true,
      limit: 3,
    });
    const ids = ((people.structuredContent?.items ?? []) as Array<{ id: string }>).map(
      (row) => row.id,
    );
    const enrolled = await call("enroll_leads", {
      action: "enroll",
      campaign_id: state.campaignId,
      person_ids: ids,
    });
    expect(enrolled.structuredContent?.enrolled).toBeGreaterThan(0);
    const checklist = await call("launch_campaign", {
      action: "launch",
      campaign_id: state.campaignId,
      dry_run: true,
    });
    expect(checklist.structuredContent?.preview).toMatchObject({ ready: true });
    // The sandbox's fake brain costs nothing: no real-looking cost in the preview.
    expect(checklist.structuredContent?.estimated_cost).toMatchObject({ usd: 0 });
    const launch = await call("launch_campaign", {
      action: "launch",
      campaign_id: state.campaignId,
    });
    expect(launch.structuredContent?.status).toBe("awaiting_approval");
    state.launchApproval = String(launch.structuredContent?.approval_id);
    state.launchAnswer = launch.content.map((block) => block.text ?? "").join(" ");
  },

  /** "What is waiting for my approval?" */
  "list-approvals": async (call, state) => {
    const waiting = await call("review_items", { action: "list" });
    expect(JSON.stringify(waiting.structuredContent)).toContain(state.launchApproval);
  },
};
