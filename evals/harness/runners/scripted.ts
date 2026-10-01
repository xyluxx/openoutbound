/**
 * Offline runner: replays the scenario's known-good tool sequence through the same MCP HTTP
 * endpoint and API key a model would use, so a scripted pass proves that the tools, scopes,
 * approvals, setups and assertions work end to end without any model.
 */
import { connectMcp, type McpSession } from "../mcp-client.js";
import type { ScriptAgent, ToolResult } from "../types.js";
import type { Runner, RunnerInput, RunnerOutput } from "./types.js";

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

function describeFailure(tool: string, result: ToolResult): string {
  const hint = result.error?.hint ? ` Hint: ${result.error.hint}` : "";
  return `${tool} failed (${result.error?.code ?? "unknown"}): ${result.error?.message ?? result.text}${hint}`;
}

/** The ScriptAgent a scenario script drives. */
export function scriptAgent(
  session: McpSession,
  data: Record<string, unknown>,
  signal?: AbortSignal,
): ScriptAgent {
  const call = (tool: string, args: Record<string, unknown> = {}) => {
    if (signal?.aborted) throw new Error("The scripted run was aborted (timeout).");
    return session.call(tool, args);
  };
  return {
    data,
    call,
    async ok(tool, args = {}) {
      const result = await call(tool, args);
      if (!result.ok) throw new Error(describeFailure(tool, result));
      return result.data;
    },
    async waitForJob(jobId, options = {}) {
      const deadline = Date.now() + (options.timeoutMs ?? 30_000);
      for (;;) {
        const result = await call("get_job", { job_id: jobId });
        if (!result.ok) throw new Error(describeFailure("get_job", result));
        const job = result.data as { status: string; result?: unknown; error?: unknown };
        if (TERMINAL_JOB_STATUSES.has(job.status)) {
          if (job.status !== "succeeded") {
            throw new Error(`Job ${jobId} ended ${job.status}: ${JSON.stringify(job.error)}`);
          }
          return job.result;
        }
        if (Date.now() > deadline) throw new Error(`Job ${jobId} still ${job.status} after wait.`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}

export const scriptedRunner: Runner = {
  name: "scripted",
  async run(input: RunnerInput): Promise<RunnerOutput> {
    const session = await connectMcp(input.mcpUrl, input.apiKey);
    let finalText = "";
    let error: string | null = null;
    try {
      finalText = await input.scenario.script(scriptAgent(session, input.data, input.signal));
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      await session.close();
    }
    return {
      finalText,
      turns: session.uses.length,
      usage: null,
      costUsd: null,
      toolUses: session.uses,
      model: null,
      error,
    };
  },
};
