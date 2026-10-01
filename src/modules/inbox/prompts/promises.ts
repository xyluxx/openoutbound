import { z } from "zod";
import { definePrompt, UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../../brain/prompt.js";

export interface PromisesVars {
  /** Our company name, for context. */
  company: string;
  channel: "email" | "linkedin";
  /** The send date (YYYY-MM-DD) in the workspace timezone, to resolve relative dates. */
  sentOn: string;
  /** Weekday of the send date, e.g. "Tuesday". */
  weekday: string;
  /** The workspace's IANA timezone. */
  timeZone: string;
  subject: string | null;
  /** Our sent reply, quoted text removed. */
  text: string;
}

/** Most promises kept from one reply. */
export const MAX_PROMISES = 3;

export const promisesOutputSchema = z.object({
  promises: z
    .array(
      z.object({
        text: z
          .string()
          .describe(
            "What we promised, as a short task in the imperative, e.g. Send the case study for dental groups",
          ),
        due: z
          .string()
          .nullable()
          .describe("YYYY-MM-DD by when we promised it; null when no time was given"),
      }),
    )
    .describe("At most 3 promises we made; empty when there are none"),
});
export type PromisesOutput = z.infer<typeof promisesOutputSchema>;

export const promisesPrompt = definePrompt({
  id: "inbox.reply.promises",
  version: 1,
  tier: "fast",
  maxTokens: 400,
  temperature: 0,
  system: (vars: PromisesVars) =>
    [
      `You read one reply that ${vars.company || "our company"} sent to a prospect and list the concrete promises WE made in it: something we said we will do or send, such as a case study, pricing, an introduction, a proposal or a call back. You have no tools: return only the JSON object the schema describes.`,
      UNTRUSTED_CONTENT_RULE,
      `Rules:
- Only our own commitments. Not the prospect's, not questions, not offers they must accept first ("happy to send more if useful"), not pleasantries ("let me know", "talk soon").
- text: one short task in the imperative, at most 15 words, e.g. "Send the pricing sheet". No names of people, no quotes.
- due: the date we promised, as YYYY-MM-DD. The reply was sent on ${vars.sentOn} (a ${vars.weekday}), timezone ${vars.timeZone}. Resolve relative dates against that day: "tomorrow" is the next day, a weekday name is the next such day after the send date, "end of the week" is that week's Friday, "next week" without a day is the Monday of next week. null when no time was given.
- At most ${MAX_PROMISES} promises; an empty list when there are none.`,
    ].join("\n\n"),
  user: (vars: PromisesVars) =>
    [
      `Channel: ${vars.channel}`,
      `Our sent reply:\n${wrapUntrusted(
        "our_sent_reply",
        `${vars.subject ? `Subject: ${vars.subject}\n\n` : ""}${vars.text}`,
      )}`,
    ].join("\n\n"),
  schema: promisesOutputSchema,
});
