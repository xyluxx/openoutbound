/**
 * `anthropic-api` runner: a small manual tool-use loop with the official SDK. Tools are the
 * MCP tools listed from the eval endpoint (same key, same toolsets), and every tool call goes
 * back through that endpoint. Reads ANTHROPIC_API_KEY from the environment.
 *
 * Deliberate choices: the named model is evaluated as is (no fallback model, no retries on
 * refusal), thinking and effort stay at the model defaults, and the whole transcript is cached
 * with top-level automatic prompt caching.
 */
import Anthropic from "@anthropic-ai/sdk";
import { connectMcp, type McpTool } from "../mcp-client.js";
import {
  addUsage,
  type Runner,
  type RunnerInput,
  type RunnerOutput,
  type RunnerUsage,
} from "./types.js";

export const DEFAULT_API_MODEL = "claude-opus-5";
const MAX_TOKENS = 32_000;

/** USD per million tokens. Cache writes (5 minute TTL) cost 1.25x input. */
export const API_PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

/** Estimated USD for a usage total, or null for a model without a known price. */
export function estimateCost(model: string, usage: RunnerUsage): number | null {
  const price = API_PRICES[model] ?? API_PRICES[model.replace(/-\d{8}$/, "")];
  if (!price) return null;
  const usd =
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_read_tokens * price.cacheRead +
      usage.cache_creation_tokens * price.input * 1.25) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** MCP tool -> Messages API tool definition. */
export function toApiTool(tool: McpTool): Anthropic.Tool {
  const { $schema: _schema, ...schema } = tool.inputSchema;
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: { ...schema, type: "object" } as Anthropic.Tool.InputSchema,
    eager_input_streaming: true,
  };
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export const anthropicApiRunner: Runner = {
  name: "anthropic-api",
  async run(input: RunnerInput): Promise<RunnerOutput> {
    const model = input.model ?? DEFAULT_API_MODEL;
    const output: RunnerOutput = {
      finalText: "",
      turns: 0,
      usage: null,
      costUsd: null,
      toolUses: [],
      model,
      error: null,
    };
    if (!process.env.ANTHROPIC_API_KEY) {
      return {
        ...output,
        error: "ANTHROPIC_API_KEY is not set (the anthropic-api runner needs it).",
      };
    }
    const session = await connectMcp(input.mcpUrl, input.apiKey);
    output.toolUses = session.uses;
    try {
      const client = new Anthropic();
      const tools = (await session.tools()).map(toApiTool);
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: input.prompt }];
      for (;;) {
        if (output.turns >= input.maxTurns) {
          output.error = `stopped after ${input.maxTurns} turns (turn budget)`;
          break;
        }
        const response = await client.messages
          .stream(
            {
              model,
              max_tokens: MAX_TOKENS,
              tools,
              messages,
              cache_control: { type: "ephemeral" },
            },
            { signal: input.signal },
          )
          .finalMessage();
        output.turns += 1;
        output.model = response.model;
        output.usage = addUsage(output.usage, {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
          cache_creation_tokens: response.usage.cache_creation_input_tokens ?? 0,
        });
        const text = textOf(response.content);
        if (text) output.finalText = text;
        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason === "refusal") {
          output.error = "the model refused (stop_reason refusal)";
          break;
        }
        if (response.stop_reason === "max_tokens") {
          output.error = `the response hit max_tokens (${MAX_TOKENS})`;
          break;
        }
        if (response.stop_reason === "pause_turn") continue;
        if (response.stop_reason !== "tool_use") break;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          try {
            const result = await session.call(
              block.name,
              (block.input ?? {}) as Record<string, unknown>,
            );
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result.text || JSON.stringify(result.data ?? null),
              ...(result.ok ? {} : { is_error: true }),
            });
          } catch (error) {
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Tool call failed: ${error instanceof Error ? error.message : String(error)}`,
              is_error: true,
            });
          }
        }
        messages.push({ role: "user", content: results });
      }
    } catch (error) {
      output.error = input.signal.aborted
        ? "anthropic-api session timed out"
        : `anthropic-api: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      await session.close();
    }
    output.costUsd = output.usage && output.model ? estimateCost(output.model, output.usage) : null;
    return output;
  },
};
