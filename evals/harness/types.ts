/**
 * Scenario contract for the eval harness. A scenario prepares a fresh sandbox (`setup`), gives an
 * agent a task (`prompt`), and judges the result with named checks on database state, the
 * operations the agent ran through MCP and its final answer (`assertions`). `script` is the
 * known-good path the offline `scripted` runner replays through the same MCP endpoint.
 */

import type { OpContext } from "../../src/core/context.js";
import type { Scope } from "../../src/core/enums.js";
import type { Db } from "../../src/db/client.js";
import type { RuntimeEngine } from "../../src/runtime/create-engine.js";
import type { EvalApis } from "./eval-apis.js";
import type { EvalBrain } from "./eval-brain.js";
import type { EvalWeb } from "./eval-web.js";

/** Options for admin calls made by setups and assertions (never visible to the agent). */
export interface AdminCallOptions {
  /** Workspace id or slug. */
  workspace?: string;
  dryRun?: boolean;
}

/** What a scenario setup can use. Setup runs before the agent connects, as the local admin. */
export interface SetupApi {
  engine: RuntimeEngine;
  db: Db;
  /** Calls an operation as the local admin (every scope). */
  call<T = unknown>(operationId: string, input?: unknown, options?: AdminCallOptions): Promise<T>;
  /** `sandbox.seed` with reset: fresh northwind and brightsmile workspaces. */
  seedSandbox(): Promise<SeededSandbox>;
  /** Engine context acting as the system in a workspace, for direct service calls. */
  context(workspace: string): Promise<OpContext>;
  /** Runs every due job now (event handlers, classification, simulations). */
  runJobs(): Promise<number>;
  /** Pages served to the engine's fetch (company websites for crawling). */
  web: EvalWeb;
  /** Provider APIs served to the engine's provider fetch (fake Apollo and the like). */
  apis: EvalApis;
  /** The deterministic brain behind the engine's own AI calls. */
  brain: EvalBrain;
}

export interface SeededSandbox {
  /** slug -> workspace id */
  workspaces: Record<string, string>;
}

/** What setup hands back: the workspace the agent works in, plus data for prompt and checks. */
export interface SetupResult<D = Record<string, unknown>> {
  /** Workspace slug or id. The agent's API key is bound to it. */
  workspace: string;
  data?: D;
}

/** One operation the agent ran through the MCP endpoint, recorded by the engine wrapper. */
export interface OperationCall {
  seq: number;
  operation: string;
  /** MCP tool and action that map to the operation (null when unknown). */
  tool: string | null;
  action: string | null;
  input: Record<string, unknown>;
  /** dry_run as the agent sent it (undefined when not sent). */
  dry_run: boolean | undefined;
  reason: string | undefined;
  outcome: "ok" | "dry_run" | "awaiting_approval" | "job" | "error";
  error_code: string | null;
  error_message: string | null;
  output: unknown;
  started_at: string;
  duration_ms: number;
}

/** A tool call as the runner saw it (includes calls rejected before reaching an operation). */
export interface RunnerToolUse {
  name: string;
  args_summary: string;
  is_error: boolean;
  error_code: string | null;
}

/** What assertions can look at after the agent finished. */
export interface AssertContext<D = Record<string, unknown>> {
  engine: RuntimeEngine;
  db: Db;
  workspaceId: string;
  data: D;
  /** Operations the agent ran through MCP, in order. */
  calls: OperationCall[];
  /** Tool calls as reported by the runner. */
  toolUses: RunnerToolUse[];
  /** The agent's final answer to the user. */
  finalText: string;
  /** Calls an operation as the local admin in the scenario workspace (read-only use). */
  call<T = unknown>(operationId: string, input?: unknown, options?: AdminCallOptions): Promise<T>;
}

/** A check returns true/false, a failure message (string), or an explicit outcome. */
export type CheckValue = boolean | string | { passed: boolean; detail?: string };

export interface Check<D = Record<string, unknown>> {
  name: string;
  run(context: AssertContext<D>): CheckValue | Promise<CheckValue>;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

/** The result of one tool call as the scripted agent sees it. */
export interface ToolResult {
  ok: boolean;
  /** structuredContent (the operation output), or the error payload on failure. */
  // biome-ignore lint/suspicious/noExplicitAny: scripts read tool outputs dynamically
  data: any;
  text: string;
  error: { code: string; message: string; hint?: string } | null;
}

/** The scripted agent: a known-good path through the same MCP endpoint a model would use. */
export interface ScriptAgent<D = Record<string, unknown>> {
  data: D;
  /** Calls a tool; never throws for tool errors (inspect `ok` and `error`). */
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Calls a tool and throws when it fails (for steps that must succeed). */
  // biome-ignore lint/suspicious/noExplicitAny: scripts read tool outputs dynamically
  ok(tool: string, args?: Record<string, unknown>): Promise<any>;
  /** Polls get_job until the job finishes; returns the job output. Throws on failure or timeout. */
  // biome-ignore lint/suspicious/noExplicitAny: job results are dynamic
  waitForJob(jobId: string, options?: { timeoutMs?: number }): Promise<any>;
}

export interface Scenario<D = Record<string, unknown>> {
  /** Stable kebab-case id, also the results file name. */
  id: string;
  title: string;
  /** The task given to the agent (a function when it depends on setup data). */
  prompt: string | ((data: D) => string);
  setup(api: SetupApi): Promise<SetupResult<D>>;
  assertions: Check<D>[];
  /** What a good run looks like, for human review of transcripts. */
  rubric: string[];
  /** Turn budget for model runners. */
  maxTurns: number;
  /** MCP toolsets the agent sees (comma list), e.g. "core" or "core,leads". */
  toolsets: string;
  /** API key scopes. Default: agent defaults read, write, send, spend (no approve, no admin). */
  scopes?: Scope[];
  /** Known-good path for the scripted runner; returns the final answer text. */
  script(agent: ScriptAgent<D>): Promise<string>;
}

/** Declares a scenario (typed identity helper). */
export function defineScenario<D = Record<string, unknown>>(scenario: Scenario<D>): Scenario<D> {
  return scenario;
}

/** Declares a named check. */
export function check<D = Record<string, unknown>>(name: string, run: Check<D>["run"]): Check<D> {
  return { name, run };
}
