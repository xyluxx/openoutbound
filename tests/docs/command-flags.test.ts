/**
 * Every CLI command written in the README, the docs and the examples parses with the real
 * commander program: no unknown command, flag or choice. Commands in code blocks and in inline
 * code, `claude mcp add` / `codex mcp add` lines and the `args` of the agent config examples.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type CommandChecker,
  cliArguments,
  createCommandChecker,
  shellWords,
} from "../../src/testing/cli-commands.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function files(path: string, pattern: RegExp): string[] {
  const full = join(ROOT, path);
  const stat = statSync(full);
  if (stat.isFile()) return pattern.test(path) ? [full] : [];
  return readdirSync(full).flatMap((name) => files(join(path, name), pattern));
}

interface Written {
  /** file:line */
  where: string;
  text: string;
  args: string[];
}

/** The engine's arguments in an agent launch line: `... mcp add openoutbound -- node <main.js> ...`. */
function agentLaunchArguments(line: string): string[] | null {
  const match = /\b(?:claude|codex) mcp add .*?-- (node \S*dist\/cli\/main\.js["']?.*)$/.exec(line);
  return match?.[1] ? cliArguments(match[1]) : null;
}

/** Commands in Markdown: code block lines and inline code spans. */
function markdownCommands(file: string): Written[] {
  const found: Written[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  let fence: string | null = null;
  let pending = "";
  lines.forEach((raw, index) => {
    const where = `${relative(ROOT, file).replaceAll("\\", "/")}:${index + 1}`;
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (marker) {
      fence = fence ? null : (marker[1] as string);
      return;
    }
    if (fence) {
      // Shell continuation lines join the next line.
      const line = `${pending}${raw.trim()}`;
      if (line.endsWith("\\")) {
        pending = `${line.slice(0, -1)} `;
        return;
      }
      pending = "";
      const args = cliArguments(line) ?? agentLaunchArguments(line);
      if (args) found.push({ where, text: line, args });
      return;
    }
    for (const span of raw.matchAll(/`([^`]+)`/g)) {
      const text = span[1] as string;
      const args = cliArguments(text) ?? agentLaunchArguments(text);
      if (args) found.push({ where, text, args });
    }
  });
  return found;
}

/** The `args` arrays of JSON and TOML agent configs that start the engine. */
function configCommands(file: string): Written[] {
  const text = readFileSync(file, "utf8");
  const where = (offset: number) =>
    `${relative(ROOT, file).replaceAll("\\", "/")}:${text.slice(0, offset).split("\n").length}`;
  const found: Written[] = [];
  // JSON and TOML both write the array as a JSON-style list, on one line or several.
  for (const match of text.matchAll(/"?args"?\s*[:=]\s*(\[[^\]]*\])/g)) {
    // TOML allows a comma after the last item; JSON does not.
    const list = JSON.parse((match[1] as string).replace(/,\s*\]$/, "]")) as string[];
    const entry = list.findIndex((arg) => /dist\/cli\/main\.js$/.test(arg));
    if (entry === -1) continue;
    found.push({
      where: where(match.index ?? 0),
      text: list.join(" "),
      args: list.slice(entry + 1),
    });
  }
  return found;
}

/** Placeholders that stand for a command word cannot be checked: `openoutbound <command>`. */
function checkable(args: string[]): boolean {
  const firstWord = args.find((arg) => !arg.startsWith("-"));
  return !args.includes("...") && !(firstWord?.startsWith("<") ?? false);
}

/**
 * Commands of modules that are not built in, with the page that defines them: the custom
 * module guide builds a `gifts` module step by step.
 */
const DEFINED_ON_THE_PAGE: Record<string, string[]> = {
  "docs/extending/custom-modules.md": ["gifts"],
};

function definedOnThePage(entry: Written): boolean {
  const file = entry.where.slice(0, entry.where.lastIndexOf(":"));
  const firstWord = entry.args.find((arg) => !arg.startsWith("-")) ?? "";
  return DEFINED_ON_THE_PAGE[file]?.includes(firstWord) ?? false;
}

/**
 * A synopsis such as `openoutbound serve [--port] [--host]`: the command without the optional
 * parts parses, and every flag in brackets exists on that command.
 */
function checkSynopsis(check: CommandChecker, entry: Written): string | null {
  const text = entry.args.join(" ");
  const optional = [...text.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1] as string);
  const base = text
    .replace(/\s*\[[^\]]*\]/g, "")
    .split(" ")
    .filter(Boolean);
  const error = check(base);
  if (error) return error;
  const words = base.filter((word) => !word.startsWith("-"));
  for (const part of optional) {
    const flag = /--[a-z-]+/.exec(part)?.[0];
    if (flag && !check.hasOption(words, flag)) return `no option ${flag} on "${words.join(" ")}"`;
  }
  return null;
}

describe("commands written in the docs", () => {
  const written = [
    ...files("README.md", /\.md$/),
    ...files("docs", /\.md$/),
    ...files("examples", /\.md$/),
  ].flatMap(markdownCommands);
  const configs = files("examples", /\.(json|toml)$/).flatMap(configCommands);

  it("finds the commands it checks", () => {
    expect(written.length).toBeGreaterThan(100);
    expect(
      written.some((entry) => entry.where.startsWith("docs/getting-started/first-hour.md")),
    ).toBe(true);
    expect(configs.map((entry) => entry.where)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^examples\/agents\/claude-desktop\.json/),
        expect.stringMatching(/^examples\/agents\/codex-config\.toml/),
      ]),
    );
  });

  it("parse with the real CLI: no unknown command, flag or choice", () => {
    const check = createCommandChecker();
    const failures: string[] = [];
    for (const entry of [...written, ...configs]) {
      if (!checkable(entry.args) || definedOnThePage(entry)) continue;
      // Optional parts in brackets, outside quotes: `serve [--port] [--host]`.
      const synopsis = /\s\[--[a-z]/.test(entry.text);
      const error = synopsis ? checkSynopsis(check, entry) : check(entry.args);
      if (error) failures.push(`${entry.where}: ${entry.text}\n    ${error}`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("agent configs start the engine with --home and the sandbox workspace", () => {
    for (const entry of configs) {
      expect(entry.args, entry.where).toContain("--home");
      expect(entry.args.join(" "), entry.where).toContain("mcp --workspace northwind");
    }
  });
});

describe("the command checker", () => {
  const check = createCommandChecker();

  it("accepts real commands, flags in either place and placeholders as values", () => {
    expect(check("openoutbound approvals list --workspace northwind --kind message")).toBeNull();
    expect(check("node dist/cli/main.js --workspace northwind sandbox simulate")).toBeNull();
    expect(
      check(
        "openoutbound approvals decide --workspace northwind --approval-id <approval id> --decision approve",
      ),
    ).toBeNull();
    expect(check("openoutbound sandbox --reset")).toBeNull();
    expect(check("openoutbound doctor --workspace acme   # one workspace in detail")).toBeNull();
  });

  it("names the unknown command, flag or choice", () => {
    expect(check("openoutbound approvals lists")).toContain("unknown command");
    expect(check("openoutbound approvals list --wrokspace northwind")).toContain(
      "unknown option '--wrokspace'",
    );
    expect(check("openoutbound approvals decide --approval-id apr_1 --decision maybe")).toContain(
      "maybe",
    );
  });

  it("splits shell words like a shell", () => {
    expect(
      shellWords(`--settings '{"a": 1}' --name "Harbor Dental" <company name> # note`),
    ).toEqual(["--settings", '{"a": 1}', "--name", "Harbor Dental", "<company name>"]);
    expect(shellWords("leads export --json | jq -r .content > leads.csv")).toEqual([
      "leads",
      "export",
      "--json",
    ]);
  });
});
