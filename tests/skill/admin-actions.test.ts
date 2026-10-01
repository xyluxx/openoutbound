/**
 * The Agent Skill never presents an action that needs the admin scope (which agent keys lack by
 * default) as something the agent simply does: each mention says the scope is needed, and the
 * Skill names the command the human runs instead.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SKILL = readFileSync(
  fileURLToPath(new URL("../../skills/openoutbound/SKILL.md", import.meta.url)),
  "utf8",
);

/** The sentences of a text that mention a word. */
function sentencesWith(text: string, word: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.includes(word));
}

describe("the Skill and admin-only actions", () => {
  it("leaves importing a setup to the human, who runs the CLI command", () => {
    const mentions = sentencesWith(SKILL, "`import_setup`");
    expect(mentions.length).toBeGreaterThan(0);
    for (const sentence of mentions) expect(sentence).toContain("`admin` scope");
    expect(SKILL).toContain("`openoutbound workspaces import-setup`");
  });
});
