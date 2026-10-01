/**
 * The Agent Skill may only name MCP tools and actions that exist.
 *
 * Reads skills/openoutbound/SKILL.md and skills/openoutbound/references/*.md, except tools.md and
 * cli.md (generated from the registry by pnpm generate:reference), and checks every tool and
 * action they name against the registered tools.
 *
 * Convention for the skill's Markdown, which the matcher relies on:
 * 1. A tool is a code span with its exact MCP name: `manage_mailboxes` (no host prefix such as
 *    mcp__openoutbound__).
 * 2. An action follows its tool: `manage_mailboxes` action `resume`, `review_items` actions
 *    `list`, `get` and `decide`, or the action's code span right after the tool:
 *    `manage_mailboxes` `import_csv`.
 * 3. In a table row that starts with a tool (the tool map in SKILL.md), a list of code spans
 *    after a colon in the next cell names that tool's actions:
 *    | `manage_pipeline` | Opportunities: `list`, `create`, `won` |
 * 4. Any other code span counts as a tool name when it is one snake_case word of two or more
 *    parts whose first part is a tool verb (the first part of a registered tool name: get,
 *    manage, review and so on), unless the engine knows the word as something else: an action,
 *    a field or enum value of an operation's input or output, a setting, a built-in signal key,
 *    a campaign template key or an MCP prompt. So `import_csv` (an action), `review_level` (a
 *    field) and `event_follow_up` (a template) pass, while `manage_widgets` fails.
 * 5. Fenced code blocks are examples and are skipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildStaticRegistry } from "../../src/cli/static-registry.js";
import { campaignSettingsSchema, workspaceSettingsSchema } from "../../src/core/settings.js";
import { toJsonSchema } from "../../src/mcp/json-schema.js";
import { MCP_PROMPTS } from "../../src/mcp/prompts.js";
import { BUILTIN_TEMPLATES } from "../../src/modules/campaigns/templates.js";
import { modules } from "../../src/modules/index.js";
import { BUILTIN_KEYS } from "../../src/modules/signals/catalog.js";

const SKILL = fileURLToPath(new URL("../../skills/openoutbound/", import.meta.url));
/** Generated from the registry, so always in step with it. */
const GENERATED = new Set(["tools.md", "cli.md"]);

const registry = buildStaticRegistry(modules);
/** Tool name to its actions, or null for a tool that runs one operation. */
const TOOLS = new Map<string, readonly string[] | null>(
  registry.tools().map((tool) => [tool.name, tool.actions ? Object.keys(tool.actions) : null]),
);
const VERBS = new Set([...TOOLS.keys()].map((name) => name.split("_")[0] ?? name));

/** Property names and enum or const values anywhere in a JSON Schema. */
function schemaWords(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) schemaWords(item, into);
    return;
  }
  if (!node || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  if (schema.properties && typeof schema.properties === "object") {
    for (const key of Object.keys(schema.properties)) into.add(key);
  }
  const values = [...(Array.isArray(schema.enum) ? schema.enum : []), schema.const];
  for (const value of values) if (typeof value === "string") into.add(value);
  for (const value of Object.values(schema)) schemaWords(value, into);
}

/** Words the engine uses for something other than a tool (rule 4). */
const KNOWN = (() => {
  const words = new Set<string>();
  for (const actions of TOOLS.values()) for (const action of actions ?? []) words.add(action);
  for (const operation of registry.operations()) {
    schemaWords(toJsonSchema(registry.inputSchema(operation.id)), words);
    schemaWords(toJsonSchema(operation.output, "output"), words);
  }
  schemaWords(toJsonSchema(workspaceSettingsSchema), words);
  schemaWords(toJsonSchema(campaignSettingsSchema), words);
  for (const key of BUILTIN_KEYS) words.add(key);
  for (const template of BUILTIN_TEMPLATES) words.add(template.key);
  for (const prompt of MCP_PROMPTS) words.add(prompt.name);
  return words;
})();

const NAME = "[a-z][a-z0-9_]*";
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
/** A registered tool never continues an action list: "`a` action `x` and `b` action `y`" is two pairs. */
const NOT_A_TOOL = `(?!(?:${[...TOOLS.keys()].join("|")})\`)`;
const LIST = `\`${NAME}\`(?:(?:\\s*,\\s*|,?\\s+(?:and|or)\\s+)\`${NOT_A_TOOL}${NAME}\`)*`;
/** Rule 2: after a tool, optionally "action" or "actions", then one or more action spans. */
const AFTER_TOOL = new RegExp(`^\\s+(?:actions?\\s+)?(${LIST})`);
/** Rule 3: a colon, then the action spans. */
const AFTER_COLON = new RegExp(`:\\s*(${LIST})`);
const SPAN = /`([^`\n]+)`/g;

function looksLikeTool(word: string): boolean {
  if (TOOLS.has(word)) return true;
  return SNAKE.test(word) && VERBS.has(word.split("_")[0] ?? "") && !KNOWN.has(word);
}

const spansIn = (text: string): string[] => [...text.matchAll(SPAN)].map((match) => match[1] ?? "");

/** Blank out fenced code blocks, keeping line numbers (rule 5). */
function withoutFences(text: string): string[] {
  let fenced = false;
  return text.split(/\r?\n/).map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return "";
    }
    return fenced ? "" : line;
  });
}

interface Scan {
  tools: string[];
  /** "tool action" pairs. */
  actions: string[];
  problems: string[];
}

function scan(file: string, text: string): Scan {
  const result: Scan = { tools: [], actions: [], problems: [] };
  withoutFences(text).forEach((line, index) => {
    const at = `${file}:${index + 1}`;
    const pairs: Array<{ tool: string; action: string }> = [];
    const actionSpans = new Set<number>();
    for (const match of line.matchAll(SPAN)) {
      const tool = match[1] ?? "";
      if (!looksLikeTool(tool)) continue;
      const after = AFTER_TOOL.exec(line.slice((match.index ?? 0) + match[0].length));
      if (!after) continue;
      for (const action of spansIn(after[1] ?? "")) pairs.push({ tool, action });
      const start = (match.index ?? 0) + match[0].length + (after.index ?? 0);
      for (const span of line.slice(start, start + after[0].length).matchAll(SPAN)) {
        actionSpans.add(start + (span.index ?? 0));
      }
    }
    const cells = line.trim().startsWith("|") ? line.split(/(?<!\\)\|/).map((c) => c.trim()) : [];
    const rowTool = /^`([a-z][a-z0-9_]*)`$/.exec(cells[1] ?? "")?.[1];
    if (rowTool && looksLikeTool(rowTool)) {
      const listed = AFTER_COLON.exec(cells[2] ?? "");
      for (const action of spansIn(listed?.[1] ?? "")) pairs.push({ tool: rowTool, action });
      if (listed) {
        const start = line.indexOf(cells[2] ?? "") + (listed.index ?? 0);
        for (const span of line.slice(start, start + listed[0].length).matchAll(SPAN)) {
          actionSpans.add(start + (span.index ?? 0));
        }
      }
    }
    for (const { tool, action } of pairs) {
      const actions = TOOLS.get(tool);
      if (actions === undefined) continue; // reported below as an unknown tool
      result.actions.push(`${tool} ${action}`);
      if (actions === null) {
        result.problems.push(`${at}: ${tool} has no actions (it runs one operation): ${action}`);
      } else if (!actions.includes(action)) {
        result.problems.push(
          `${at}: ${tool} has no action ${action} (actions: ${actions.join(", ")})`,
        );
      }
    }
    for (const match of line.matchAll(SPAN)) {
      const word = match[1] ?? "";
      if (actionSpans.has(match.index ?? 0) || !looksLikeTool(word)) continue;
      result.tools.push(word);
      if (!TOOLS.has(word)) {
        result.problems.push(
          `${at}: ${word} is not a registered MCP tool (see references/tools.md)`,
        );
      }
    }
  });
  return result;
}

function skillFiles(): Array<{ name: string; text: string }> {
  const references = readdirSync(join(SKILL, "references"))
    .filter((name) => name.endsWith(".md") && !GENERATED.has(name))
    .sort()
    .map((name) => `references/${name}`);
  return ["SKILL.md", ...references].map((name) => ({
    name,
    text: readFileSync(join(SKILL, name), "utf8"),
  }));
}

describe("skill tool names", () => {
  it("names only registered tools and actions", () => {
    const files = skillFiles();
    expect(files.map((file) => file.name)).toContain("references/playbook-replies.md");
    expect(files.map((file) => file.name)).not.toContain("references/tools.md");
    const scans = files.map((file) => scan(file.name, file.text));
    expect(scans.flatMap((result) => result.problems)).toEqual([]);
    // The matcher really reads the skill: the tool map and the inline pairs.
    expect(new Set(scans.flatMap((result) => result.tools)).size).toBeGreaterThanOrEqual(20);
    expect(scans.flatMap((result) => result.actions)).toEqual(
      expect.arrayContaining([
        "review_items decide",
        "manage_mailboxes check_dns",
        "manage_sandbox simulate",
        "manage_icp create",
      ]),
    );
  });

  it("fails on an invented tool name or action", () => {
    const text = [
      "Call `manage_widgets` first, then `get_statuss`.",
      "Resume with `manage_mailboxes` action `explode`.",
      "Use `review_items` actions `list`, `approve_all` and `get`.",
      "| `manage_pipeline` | Opportunities: `list`, `archive` | Tasks live in `manage_tasks` | x |",
      "Run `get_report` action `summary`.",
      "Read `manage_strategy` action `get` and `manage_crm` action `explode`.",
    ].join("\n");
    expect(scan("invented.md", text).problems).toEqual([
      "invented.md:1: manage_widgets is not a registered MCP tool (see references/tools.md)",
      "invented.md:1: get_statuss is not a registered MCP tool (see references/tools.md)",
      expect.stringMatching(/^invented\.md:2: manage_mailboxes has no action explode \(actions: /),
      expect.stringMatching(/^invented\.md:3: review_items has no action approve_all /),
      expect.stringMatching(/^invented\.md:4: manage_pipeline has no action archive /),
      "invented.md:5: get_report has no actions (it runs one operation): summary",
      expect.stringMatching(/^invented\.md:6: manage_crm has no action explode /),
    ]);
  });

  it("leaves ordinary code words and examples alone", () => {
    const text = [
      "Pass `dry_run` and `next_cursor`; mailboxes come in through `import_csv`.",
      "Set `review_level` and `reply_delay_minutes`; template `event_follow_up`.",
      "Signals such as `review_activity` and `event_attendance`; the `list_id` field.",
      "Hosts show `mcp__openoutbound__get_status`; the `daily_review` prompt.",
      "```text",
      "`manage_nothing` inside an example",
      "```",
    ].join("\n");
    expect(scan("plain.md", text)).toEqual({ tools: [], actions: [], problems: [] });
  });
});
