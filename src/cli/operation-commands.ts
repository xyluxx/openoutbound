import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type Command, Option } from "commander";
import { OpenOutboundError } from "../core/errors.js";
import { RESERVED_INPUT_FIELDS } from "../core/operation.js";
import { coerceField, type FieldInfo, fieldsOf, parseJson } from "../http/coerce.js";
import type { Catalog, OperationInfo } from "../mcp/catalog.js";
import { commandPrefix } from "./command-prefix.js";
import { type CliContext, resolveBridge } from "./context.js";
import { failedOutcome, renderHuman } from "./output.js";

/** Flags every operation command understands besides its own fields. */
export interface CommonFlags {
  workspace?: string;
  dryRun?: boolean;
  reason?: string;
  idempotencyKey?: string;
  url?: string;
  apiKey?: string;
  json?: boolean;
  input?: string;
}

const RESERVED = new Set<string>(RESERVED_INPUT_FIELDS);
/** response_format stays a normal flag; the others map to CommonFlags. */
RESERVED.delete("response_format");

export function flagName(field: string): string {
  return field.replaceAll("_", "-");
}

function describeField(field: FieldInfo): string {
  const parts = [field.description ?? ""];
  if (field.kind === "array") parts.push("(repeat the flag or use a comma list)");
  if (field.kind === "object" || field.kind === "any") parts.push("(JSON or @file.json)");
  if (field.required) parts.push("(required)");
  return parts.filter(Boolean).join(" ");
}

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** The first example as a command line with one flag per field. */
export function exampleLine(operation: OperationInfo): string | null {
  const example = operation.examples[0]?.input;
  if (!example || typeof example !== "object") return null;
  const parts = [`openoutbound ${operation.cli.join(" ")}`];
  for (const [key, value] of Object.entries(example as Record<string, unknown>)) {
    const flag = `--${flagName(key)}`;
    if (value === true) parts.push(flag);
    else if (value === false) parts.push(`--no-${flagName(key)}`);
    else if (Array.isArray(value) && value.every((v) => typeof v !== "object")) {
      parts.push(`${flag} ${quote(value.join(","))}`);
    } else if (value !== null && typeof value === "object") {
      parts.push(`${flag} ${quote(JSON.stringify(value))}`);
    } else if (value !== null && value !== undefined) {
      parts.push(`${flag} ${quote(String(value))}`);
    }
  }
  return parts.join(" ");
}

function quote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Reads `--input` (inline JSON or @file.json, relative to where the user ran the command). */
export function readJsonArgument(raw: string, cwd: string, name: string): unknown {
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    let text: string;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      throw new OpenOutboundError("validation_failed", `Cannot read ${name} file ${absolute}.`, {
        hint: `Check the path after "@" (relative paths start from ${cwd}).`,
      });
    }
    // Windows PowerShell 5.1 writes a byte order mark first (Set-Content -Encoding UTF8).
    return parseJson(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, name, "a JSON document");
  }
  return parseJson(raw, name, "JSON");
}

interface Generated {
  operation: OperationInfo;
  fields: Map<string, FieldInfo>;
}

/** One line per command group for `--help`, keyed by its CLI path. */
export const GROUP_DESCRIPTIONS: Record<string, string> = {
  "agent-tasks": "Work the engine hands to your agent when the agent is the brain",
  approvals: "Approve or reject what waits for a human (launches, replies, spend)",
  attention: "What needs a human now: replies, approvals, warnings, setup",
  audit: "Who did what, when and why",
  brain: "The AI model that writes, classifies and checks: status and test",
  campaigns: "Create, preview, launch, pause and track campaigns",
  changes: "The change log: what changed, who changed it and why; undo and propose changes",
  companies: "Companies: search, add, edit and score",
  crm: "Push the pipeline to HubSpot, Pipedrive or a webhook",
  enrichment: "Find and verify contact details for leads",
  events: "The change feed: what happened since a cursor, with named consumers",
  icps: "Ideal customer profiles: who to target and how fit is scored",
  imports: "Import leads from a file or a lead source",
  jobs: "Background jobs: progress, failures and cancel",
  keys: "API keys for agents, apps and people",
  knowledge: "What the AI may say: facts, proof, objections, voice and rules",
  "knowledge-gaps": "Questions the AI could not answer from the knowledge base",
  leads: "People: search, add, edit, score and forget",
  linkedin: "LinkedIn accounts, invites, messages and safety limits",
  "linkedin accounts": "Connected LinkedIn accounts, their limits and health",
  "linkedin relations": "Who is invited, connected or withdrawn per account",
  lists: "Static and smart lead lists",
  mailboxes: "Sending mailboxes: connect, DNS checks, limits and health",
  meetings: "Meetings: record, reschedule, cancel, held and no-show, and the booking webhook",
  messages: "Drafted, scheduled and sent messages",
  notifications: "Where alerts go: email, Slack or a webhook",
  offers: "What you sell, for campaigns to write from",
  operating: "Run the day: the workspace state, what happens next and why something is blocked",
  opportunities: "Pipeline: interested, meeting booked, won and lost",
  posts: "LinkedIn posts: draft, schedule and publish",
  "posts accounts": "Accounts that publish posts",
  problems: "Problems that need a person or the agent: list, resolve and snooze",
  proposals: "Changes agents proposed, their approvals and whether they helped",
  providers: "Plug in providers: brain, mail, lead sources, research, signals, LinkedIn, CRM",
  reports: "Reports on campaigns, channels, signals, senders and AI cost",
  "reports schedules": "Reports delivered on a schedule",
  research: "Sourced research briefs on companies and people",
  sandbox: "Practice workspaces with fake data: nothing real is sent",
  "saved-searches": "Lead searches that can run again on a schedule",
  signals: "Buying signals: feed, custom definitions, monitors and automations",
  "signals automations": "Rules that act when a signal fires (for example, enroll)",
  "signals definitions": "Signal types to watch, including your own custom signals",
  "signals monitors": "Scheduled checks of companies for new signals",
  "signals webhook-tokens": "Secret URLs other tools can push signals to",
  strategy: "The strategy page: what decides a client's outreach, read it first",
  suppressions: "Do-not-contact list: emails, domains, people and companies",
  tasks: "To-dos for humans: calls, emails and reviews",
  threads: "Inbox: conversations, classification and replies",
  webhooks: "Outgoing webhooks for engine events",
  workspaces: "Workspaces (one per client or brand): settings, status, pause",
};

function findOrCreateGroup(parent: Command, name: string): Command {
  const existing = parent.commands.find((command) => command.name() === name);
  if (existing) return existing;
  const path = [...ancestorNames(parent), name].join(" ");
  return parent.command(name).description(GROUP_DESCRIPTIONS[path] ?? `${name} commands`);
}

/** Names of the groups above this command, outermost first (the program itself excluded). */
function ancestorNames(command: Command): string[] {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name());
  }
  return names;
}

/**
 * Adds one command per operation at its CLI path (`leads import`), with flags generated from
 * the input schema: snake_case -> --kebab-case, booleans as --flag/--no-flag, arrays repeatable
 * or comma lists, objects as JSON. Plus the common flags (--workspace, --dry-run, --reason,
 * --idempotency-key, --input, --json, --url, --api-key) unless an input field uses the name.
 */
export function addOperationCommands(
  program: Command,
  catalog: Catalog,
  ctx: CliContext,
  setExitCode: (code: number) => void,
): void {
  for (const operation of catalog.operations) {
    const words = operation.cli;
    if (words.length === 0) continue;
    let parent = program;
    for (const word of words.slice(0, -1)) parent = findOrCreateGroup(parent, word);
    const name = words.at(-1) as string;
    if (parent.commands.some((command) => command.name() === name)) {
      ctx.io.stderr(
        ctx.err.dim(`Skipping ${operation.id}: the command "${words.join(" ")}" already exists.\n`),
      );
      continue;
    }
    const leaf = parent.command(name, { isDefault: operation.id === "sandbox.seed" });
    const generated = defineOperationCommand(leaf, operation);
    leaf.action(async () => {
      const code = await runOperationCommand(ctx, generated, leaf.opts(), program.opts());
      setExitCode(code);
    });
  }
}

function defineOperationCommand(leaf: Command, operation: OperationInfo): Generated {
  leaf.description(operation.summary);
  const example = exampleLine(operation);
  leaf.addHelpText(
    "after",
    `\n${operation.description}${example ? `\n\nExample:\n  ${example}` : ""}\n`,
  );
  const fields = new Map<string, FieldInfo>();
  const flagNames = new Set<string>();
  for (const field of fieldsOf(operation.input_schema)) {
    if (RESERVED.has(field.name)) continue;
    const flag = flagName(field.name);
    flagNames.add(flag);
    let option: Option;
    if (field.kind === "boolean") {
      option = new Option(`--${flag}`, describeField(field));
      leaf.addOption(option);
      leaf.addOption(new Option(`--no-${flag}`, `Set ${field.name} to false`));
    } else {
      const placeholder =
        field.kind === "number" || field.kind === "integer"
          ? "<number>"
          : field.kind === "object" || field.kind === "any"
            ? "<json>"
            : "<value>";
      option = new Option(`--${flag} ${placeholder}`, describeField(field));
      if (field.kind === "array") option.argParser(collect);
      else if (field.enum && field.kind === "string") option.choices(field.enum);
      leaf.addOption(option);
    }
    fields.set(option.attributeName(), field);
  }
  const common: Array<[string, string, string]> = [];
  if (operation.workspace !== "none") {
    common.push([
      "workspace",
      "--workspace <id|slug>",
      "Workspace (default OPENOUTBOUND_WORKSPACE)",
    ]);
  }
  if (operation.dry_run !== "none") {
    common.push([
      "dry-run",
      "--dry-run",
      operation.dry_run === "default"
        ? "Preview only (the default for this command)"
        : "Preview without writing, sending or spending",
    ]);
    common.push(["no-dry-run", "--no-dry-run", "Apply for real"]);
  } else if (!flagNames.has("dry-run")) {
    // Hidden: the engine answers a dry run it cannot do with `unsupported`, as on every door.
    leaf.addOption(new Option("--dry-run", "Preview (this command has none)").hideHelp());
    leaf.addOption(new Option("--no-dry-run", "Apply for real").hideHelp());
  }
  common.push(["reason", "--reason <text>", "Why, in one sentence (audit log)"]);
  if (operation.effect !== "read") {
    common.push(["idempotency-key", "--idempotency-key <key>", "Makes retries safe"]);
  }
  common.push(
    ["input", "--input <json|@file>", "The whole input as JSON (flags override its fields)"],
    ["json", "--json", "Print raw JSON"],
    ["url", "--url <url>", "Call a running server instead (bridge mode; env OPENOUTBOUND_URL)"],
    ["api-key", "--api-key <key>", "API key for bridge mode (env OPENOUTBOUND_API_KEY)"],
  );
  for (const [flag, spec, description] of common) {
    const base = flag.startsWith("no-") ? flag.slice(3) : flag;
    if (flagNames.has(base) || flagNames.has(flag)) continue;
    leaf.addOption(new Option(spec, description));
  }
  return { operation, fields };
}

async function runOperationCommand(
  ctx: CliContext,
  generated: Generated,
  local: Record<string, unknown>,
  global: Record<string, unknown>,
): Promise<number> {
  const { operation, fields } = generated;
  const flag = <T>(name: keyof CommonFlags): T | undefined =>
    (fields.has(name) ? undefined : (local[name] as T | undefined)) ??
    (global[name] as T | undefined);
  const flags: CommonFlags = {
    workspace: flag<string>("workspace") ?? ctx.setting("OPENOUTBOUND_WORKSPACE"),
    dryRun: flag<boolean>("dryRun"),
    reason: flag<string>("reason"),
    idempotencyKey: flag<string>("idempotencyKey"),
    url: flag<string>("url"),
    apiKey: flag<string>("apiKey"),
    json: flag<boolean>("json") === true,
    input: flag<string>("input"),
  };

  let input: Record<string, unknown> = {};
  if (flags.input !== undefined) {
    const parsed = readJsonArgument(flags.input, ctx.cwd, "--input");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new OpenOutboundError("validation_failed", "--input must be a JSON object.", {
        hint: `For example --input '{"limit": 10}' or --input @input.json`,
      });
    }
    input = { ...(parsed as Record<string, unknown>) };
  }
  for (const [attribute, field] of fields) {
    const value = local[attribute];
    if (value === undefined) continue;
    if (typeof value === "boolean") input[field.name] = value;
    else if (Array.isArray(value)) input[field.name] = coerceField(value as string[], field);
    else if (
      typeof value === "string" &&
      (field.kind === "object" || field.kind === "any") &&
      value.startsWith("@")
    ) {
      input[field.name] = readJsonArgument(value, ctx.cwd, `--${flagName(field.name)}`);
    } else input[field.name] = coerceField([String(value)], field);
  }

  const options = {
    ...(flags.workspace ? { workspace: flags.workspace } : {}),
    ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun } : {}),
    ...(flags.reason ? { reason: flags.reason } : {}),
    ...(flags.idempotencyKey ? { idempotencyKey: flags.idempotencyKey } : {}),
  };
  let output: unknown;
  const bridge = await resolveBridge(ctx, { url: flags.url, apiKey: flags.apiKey }, "admin");
  if (bridge) {
    output = await bridge.client.call(operation.id, input, options);
  } else {
    const engine = await ctx.createEngine();
    try {
      output = await engine.call(operation.id, input, {
        ...options,
        principal: engine.localPrincipal("admin", "cli"),
      });
    } finally {
      await engine.close();
    }
  }

  const context = {
    command: operation.cli.join(" "),
    dryRunMode: operation.dry_run,
    operationId: operation.id,
    prefix: commandPrefix(ctx),
    ...(flags.workspace ? { workspace: flags.workspace } : {}),
  };
  // A result that reports a failure (a mailbox login test that failed) exits 1 after printing.
  const failed = failedOutcome(output, context);
  if (flags.json) {
    ctx.io.stdout(`${JSON.stringify(output ?? null, null, 2)}\n`);
  } else {
    const human = renderHuman(output, ctx.out, context);
    if (human.stdout) ctx.io.stdout(human.stdout);
    for (const hint of human.hints) ctx.io.stderr(`${ctx.err.dim(hint)}\n`);
  }
  if (!failed) return 0;
  ctx.io.stderr(`${ctx.err.red(failed)}\n`);
  return 1;
}
