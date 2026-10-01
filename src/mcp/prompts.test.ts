/** The MCP prompts: every session starts from the client's strategy page. */
import { describe, expect, it } from "vitest";
import { MCP_PROMPTS } from "./prompts.js";

describe("MCP prompts", () => {
  it.each(MCP_PROMPTS.map((prompt) => [prompt.name, prompt] as const))(
    "%s reads the strategy page first, then numbers its steps in order",
    (_name, prompt) => {
      const steps = prompt
        .text({ website: "https://acme.example.com" })
        .split("\n")
        .filter((line) => /^\d+\. /.test(line));
      expect(steps[0]).toBe(
        "1. Call manage_strategy action get and follow its agent_notes, voice and reply rules.",
      );
      expect(steps.map((line) => Number(line.split(".")[0]))).toEqual(
        steps.map((_line, index) => index + 1),
      );
    },
  );
});
