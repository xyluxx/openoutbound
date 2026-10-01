/**
 * An MCP client on the eval endpoint (Streamable HTTP with the agent's bearer key), used by the
 * scripted runner and the Anthropic API runner. Model CLIs connect on their own with the same
 * URL and key.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { VERSION } from "../../src/core/version.js";
import type { RunnerToolUse, ToolResult } from "./types.js";

export interface McpTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

export interface McpSession {
  tools(): Promise<McpTool[]>;
  /** Calls a tool; tool errors come back as `ok: false`, protocol failures throw. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Every call so far, as the client saw it. */
  uses: RunnerToolUse[];
  close(): Promise<void>;
}

interface RawToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

/** Normalizes a CallToolResult into data, text and the OpenOutbound error (when any). */
export function toToolResult(raw: RawToolResult): ToolResult {
  const text = (raw.content ?? [])
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
  const structured = raw.structuredContent as Record<string, unknown> | undefined;
  if (raw.isError) {
    const payload = (structured?.error ?? null) as ToolResult["error"];
    const code = payload?.code ?? /^Error \(([a-z_]+)\)/.exec(text)?.[1] ?? "unknown";
    return {
      ok: false,
      data: structured ?? null,
      text,
      error: {
        code,
        message: payload?.message ?? text,
        ...(payload?.hint ? { hint: payload.hint } : {}),
      },
    };
  }
  return { ok: true, data: structured ?? null, text, error: null };
}

/** One-line summary of tool arguments for reports (long strings clipped). */
export function summarizeArgs(args: Record<string, unknown> | undefined, max = 240): string {
  if (!args || Object.keys(args).length === 0) return "{}";
  const clip = (value: unknown): unknown => {
    if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 57)}...` : value;
    if (Array.isArray(value)) {
      return value.length > 5
        ? [...value.slice(0, 5).map(clip), `+${value.length - 5} more`]
        : value.map(clip);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clip(inner)]));
    }
    return value;
  };
  const text = JSON.stringify(clip(args));
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export async function connectMcp(url: string, apiKey: string): Promise<McpSession> {
  const client = new Client({ name: "openoutbound-evals", version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  await client.connect(transport);
  const uses: RunnerToolUse[] = [];
  return {
    uses,
    async tools() {
      const listed = await client.listTools();
      return listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
    },
    async call(name, args = {}) {
      const raw = (await client.callTool({ name, arguments: args })) as RawToolResult;
      const result = toToolResult(raw);
      uses.push({
        name,
        args_summary: summarizeArgs(args),
        is_error: !result.ok,
        error_code: result.error?.code ?? null,
      });
      return result;
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}
