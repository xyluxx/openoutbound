/**
 * Checks that written CLI commands parse with the real commander program (commands, flags,
 * choices) without running anything, so docs, examples and hints stay in step with the CLI.
 *
 *   const check = createCommandChecker();
 *   check("openoutbound approvals list --workspace northwind"); // null: it parses
 *   check("openoutbound approvals list --wrokspace northwind"); // "error: unknown option ..."
 */
import { type Command, CommanderError } from "commander";
import { createCliContext } from "../cli/context.js";
import type { CliIO } from "../cli/io.js";
import { buildProgram } from "../cli/program.js";
import { buildStaticRegistry } from "../cli/static-registry.js";
import { modules } from "../modules/index.js";

/** Ways a written command starts: the installed binary, the package script, node and the entry point. */
const PREFIXES: RegExp[] = [
  /^openoutbound(?=\s|$)/,
  /^(?:pnpm|npm run|yarn) openoutbound(?: --)?(?=\s|$)/,
  /^(?:docker compose exec \S+ )?node \S*dist\/cli\/main\.js["']?(?=\s|$)/,
];

/** The arguments after the CLI itself, or null when the line is not a CLI command. */
export function cliArguments(line: string): string[] | null {
  const text = line.trim().replace(/^\$\s+/, "");
  for (const prefix of PREFIXES) {
    const match = prefix.exec(text);
    if (match) return shellWords(text.slice(match[0].length));
  }
  return null;
}

/** Shell operators that end the command: pipes, redirects, `&&`, `;`. */
const COMMAND_END = /^(?:\||\|\||&&|;|>|>>|2>|2>&1|&>)$/;

/**
 * Splits a shell command line into words, up to the first pipe, redirect or `&&`: single and
 * double quotes, backslash escapes, a trailing `# comment`, and `<placeholder words>` kept as
 * one word.
 */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  let quote: "'" | '"' | null = null;
  const finish = (): boolean => {
    if (!started) return true;
    if (!quoted && COMMAND_END.test(current)) return false;
    words.push(current);
    current = "";
    started = false;
    quoted = false;
    return true;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      quoted = true;
    } else if (char === "\\" && i + 1 < text.length) {
      current += text[++i];
      started = true;
    } else if (char === "<" && !started && text.indexOf(">", i) > i + 1) {
      const end = text.indexOf(">", i);
      current += text.slice(i, end + 1);
      i = end;
      started = true;
    } else if (/\s/.test(char)) {
      if (!finish()) return words;
    } else if (char === "#" && !started) {
      break;
    } else {
      current += char;
      started = true;
    }
  }
  finish();
  return words;
}

/** Leaf commands get an action that does nothing; groups keep none, so unknown subcommands fail. */
function silence(command: Command): void {
  if (command.commands.length === 0) command.action(() => {});
  for (const child of command.commands) silence(child);
}

const OK_CODES = new Set(["commander.helpDisplayed", "commander.help", "commander.version"]);

export interface CommandChecker {
  /** Commander's error message for the command, or null when it parses. */
  (command: string | string[]): string | null;
  /** Whether the command at these words takes the flag (`--json`, `--no-worker`). */
  hasOption(words: readonly string[], flag: string): boolean;
}

/** A checker over one real program built from the built-in modules. */
export function createCommandChecker(): CommandChecker {
  const io: CliIO = {
    stdout: () => {},
    stderr: () => {},
    stdoutIsTTY: false,
    stderrIsTTY: false,
  };
  const cwd = process.cwd();
  const ctx = createCliContext({}, io, {}, cwd, { dir: cwd, source: "default" });
  const program = buildProgram(ctx, buildStaticRegistry(modules), () => {});
  // Not the program itself: with an action of its own it would take unknown commands as operands.
  for (const child of program.commands) silence(child);

  const check = ((command: string | string[]) => {
    const args = typeof command === "string" ? cliArguments(command) : command;
    if (!args) return `not a CLI command: ${String(command)}`;
    try {
      program.parse(args, { from: "user" });
      return null;
    } catch (error) {
      if (error instanceof CommanderError) return OK_CODES.has(error.code) ? null : error.message;
      throw error;
    } finally {
      resetValues(program);
    }
  }) as CommandChecker;

  check.hasOption = (words, flag) => {
    let command: Command | undefined = program;
    for (const word of words) {
      command = command?.commands.find((child) => child.name() === word);
    }
    const options = [...(command?.options ?? []), ...program.options];
    return options.some((option) => option.long === flag);
  };
  return check;
}

/** Commander keeps option values between parses: clear them so one command never leaks into the next. */
function resetValues(command: Command): void {
  for (const option of command.options) {
    command.setOptionValueWithSource(option.attributeName(), undefined, "default");
  }
  for (const child of command.commands) resetValues(child);
}
