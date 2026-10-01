/**
 * Setting hints: an agent asks the human, or suggests the change with a proposal the owner
 * judges. A budget is only ever raised by the human.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { askToChangeSetting, askToChangeSettingAfter, askToRaiseBudget } from "./setting-hints.js";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** Every engine source file, tests left out. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("setting hints", () => {
  it("ask the human, and name the proposal that suggests the change", () => {
    expect(askToChangeSetting({ "company.postal_address": "<postal address>" })).toBe(
      'Ask the human to change settings.company.postal_address (openoutbound workspaces update); to suggest it, use manage_strategy action propose (operation workspaces.update, input {"settings":{"company":{"postal_address":"<postal address>"}}}).',
    );
    expect(
      askToChangeSettingAfter("If reps agree", {
        "company.name": "<company name>",
        "settings.company.website": "https://www.example.com",
        "crm.skip_owned_accounts": false,
      }),
    ).toBe(
      'If reps agree: ask the human to change settings.company.name, settings.company.website and settings.crm.skip_owned_accounts (openoutbound workspaces update); to suggest it, use manage_strategy action propose (operation workspaces.update, input {"settings":{"company":{"name":"<company name>","website":"https://www.example.com"},"crm":{"skip_owned_accounts":false}}}).',
    );
  });

  it("never tell an agent to raise or propose its own budget", () => {
    const hint = askToRaiseBudget("ai.monthly_budget_usd");
    expect(hint).toBe(
      "ask the human to raise settings.ai.monthly_budget_usd (openoutbound workspaces update)",
    );
    expect(askToRaiseBudget("settings.data.monthly_credit_budget")).toBe(
      "ask the human to raise settings.data.monthly_credit_budget (openoutbound workspaces update)",
    );
    expect(hint).not.toMatch(/manage_strategy|manage_workspaces|propose/);
  });

  it("are the only way the engine words a settings change: no hint names manage_workspaces update", () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /manage_workspaces \(?action update/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
