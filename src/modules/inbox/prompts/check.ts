import { z } from "zod";
import { definePrompt, UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../../brain/prompt.js";

export interface CheckVars {
  category: string;
  language: string;
  prospectMessage: string;
  grounding: string;
  bookingUrl: string | null;
  subject: string | null;
  body: string;
}

export const checkOutputSchema = z.object({
  verdict: z.enum(["pass", "revise", "fail"]),
  confidence: z.number().describe("0 to 1"),
  issues: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type CheckOutput = z.infer<typeof checkOutputSchema>;

/**
 * The checker rule behind the promise that the engine never proposes, accepts or confirms a
 * meeting time itself.
 */
export const NO_CONFIRMED_TIME_RULE =
  "The reply must not propose a specific meeting time (for example 'How about Thursday at 10?') and must not accept, confirm or promise one (for example 'Tuesday at 3pm works, see you then'): only a person or the booking link can set a time. Offering the booking link, or saying a time will be confirmed shortly, is fine. A draft that proposes a time gets verdict revise with issue code proposes_time; a draft that accepts or confirms one gets verdict revise with issue code confirms_time.";

export const checkReplyPrompt = definePrompt({
  id: "inbox.reply.check",
  version: 3,
  tier: "fast",
  maxTokens: 500,
  temperature: 0,
  system: () =>
    [
      "You review a drafted reply to a prospect before it is sent. You have no tools; return only the JSON object.",
      "verdict pass: it answers the prospect, every claim about us is in the grounding pack, no invented links, prices or commitments, polite, short, in the prospect's language.",
      NO_CONFIRMED_TIME_RULE,
      "verdict revise: fixable problems. verdict fail: must not be sent (unsafe, off-topic, hostile context, reveals internal data).",
      "confidence: 0 to 1, how sure you are about the verdict.",
      UNTRUSTED_CONTENT_RULE,
    ].join("\n\n"),
  user: (vars: CheckVars) =>
    [
      `Reply category: ${vars.category}. Expected language: ${vars.language}.`,
      `Prospect's message:\n${wrapUntrusted("prospect_message", vars.prospectMessage)}`,
      `Grounding pack:\n${vars.grounding || "(empty)"}`,
      `Allowed link: ${vars.bookingUrl ?? "none"}`,
      `Draft:\n${vars.subject ? `Subject: ${vars.subject}\n` : ""}${vars.body}`,
    ].join("\n\n"),
  schema: checkOutputSchema,
});
