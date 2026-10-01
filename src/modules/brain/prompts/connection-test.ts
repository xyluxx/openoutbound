import { z } from "zod";
import { definePrompt } from "../../../brain/prompt.js";

/** Vars of the connection test prompt: a random code the model must echo. */
export interface ConnectionTestVars {
  nonce: string;
}

/**
 * The tiny structured prompt behind `brain.test`: proves the brain answers, returns valid JSON
 * for a schema and actually read the input (it must echo the code).
 */
export const connectionTestPrompt = definePrompt({
  id: "brain.connection_test",
  version: 1,
  tier: "fast",
  system: () =>
    "You are checking that an AI connection works. Reply with JSON only, exactly as the schema asks.",
  user: (vars: ConnectionTestVars) =>
    `Set ok to true and set echo to this code, character for character: ${vars.nonce}`,
  schema: z.object({
    ok: z.boolean().describe("Always true"),
    echo: z.string().describe("The code from the message, unchanged"),
  }),
  maxTokens: 200,
});
