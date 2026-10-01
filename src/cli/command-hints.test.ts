/**
 * Hints and docs must use the current CLI syntax. `providers` subcommands take flags only
 * (`providers set --slot research --provider exa`); the old positional form
 * (`providers set research exa`) no longer parses.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLOTS } from "../providers/types.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SCANNED = ["src", "docs", "skills", "evals", "examples", "README.md", "AGENTS.md"];
const EXTENSIONS = /\.(ts|mjs|js|md|json|txt)$/;

/** `providers <verb>` followed by a positional value: a slot, a placeholder or a template. */
const STALE_PROVIDERS_COMMAND = new RegExp(
  String.raw`\bproviders (?:catalog|list|remove|set|test) +(?:${SLOTS.join("|")}|<|\$\{|\{)`,
);

function files(path: string): string[] {
  const full = join(ROOT, path);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(full);
  } catch {
    return [];
  }
  if (stat.isFile()) return EXTENSIONS.test(path) ? [full] : [];
  return readdirSync(full).flatMap((name) =>
    name === "node_modules" ? [] : files(join(path, name)),
  );
}

describe("CLI command hints", () => {
  it("never use the old positional providers syntax", () => {
    const stale: string[] = [];
    for (const file of SCANNED.flatMap(files)) {
      if (file === SELF) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (STALE_PROVIDERS_COMMAND.test(line)) {
            stale.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 160)}`);
          }
        });
    }
    expect(stale, "use `providers <verb> --slot <slot> --provider <id>`").toEqual([]);
  });

  it("the check catches the old form", () => {
    expect(STALE_PROVIDERS_COMMAND.test("`openoutbound providers set email_verifier <id>`")).toBe(
      true,
    );
    expect(STALE_PROVIDERS_COMMAND.test(`openoutbound providers test \${slot} \${id}`)).toBe(true);
    expect(
      STALE_PROVIDERS_COMMAND.test("`openoutbound providers set --slot research --provider exa`"),
    ).toBe(false);
    expect(STALE_PROVIDERS_COMMAND.test("add the models with `providers set` as above")).toBe(
      false,
    );
  });
});
