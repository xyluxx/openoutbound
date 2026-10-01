import type { z } from "zod";
import type { ModelTier } from "../core/enums.js";
import type { BrainRequest } from "../providers/types.js";

/**
 * What the brain service hands to providers: the plug-in `BrainRequest` plus context the
 * built-in providers use (the fake brain answers from the zod schema and the vars; Anthropic and
 * OpenAI pick a reasoning effort per tier). Plug-in providers can ignore the extra fields.
 */
export interface ServiceBrainRequest extends BrainRequest {
  tier?: ModelTier;
  /** The prompt's zod output schema. */
  outputSchema?: z.ZodType;
  /** The prompt vars. */
  vars?: unknown;
  promptVersion?: number;
  /** 1 for the first call, 2 for the repair call. */
  attempt?: number;
  /**
   * Set for time-sensitive prompts on the agent brain when a backup brain is set: after
   * `limitMs` (`ai.agent_timeout_minutes`) the agent brain closes its open task as expired and
   * fails with reason `timeout`, so the backup brain answers.
   */
  agentTimeout?: { limitMs: number; fallback: string };
}

/** The service extras of a request, when it came from the brain service. */
export function requestExtras(request: BrainRequest): Partial<ServiceBrainRequest> {
  return request as Partial<ServiceBrainRequest>;
}

/** The last user message of a request (the prompt a provider should answer). */
export function lastUserMessage(request: BrainRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}

/**
 * Renders the conversation as one text, for brains that take a single prompt (CLI brains).
 * A single user message is returned as is.
 */
export function renderTranscript(request: BrainRequest): string {
  const [first, ...rest] = request.messages;
  if (!first) return "";
  if (rest.length === 0 && first.role === "user") return first.content;
  return request.messages
    .map((message) =>
      message.role === "user"
        ? `<user_message>\n${message.content}\n</user_message>`
        : `<your_previous_reply>\n${message.content}\n</your_previous_reply>`,
    )
    .join("\n\n");
}
