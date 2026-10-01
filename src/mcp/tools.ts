import type { CallOptions } from "../core/engine.js";
import { TOOLSETS, type Toolset } from "../core/enums.js";
import { OpenOutboundError } from "../core/errors.js";
import { operationAnnotations, RESERVED_INPUT_FIELDS } from "../core/operation.js";
import type { Catalog, OperationInfo, ToolInfo } from "./catalog.js";
import {
  type JsonSchema,
  schemaProperties,
  schemaRequired,
  stableStringify,
} from "./json-schema.js";

/** MCP tool annotations (spec 9.1). */
export interface ToolAnnotationHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** A tool ready to register: advertised schema plus what the call path needs. */
export interface McpToolSpec {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  inputSchema: JsonSchema;
  annotations: ToolAnnotationHints;
  /** action -> operation (composite tools), or null for single-operation tools. */
  actions: Record<string, OperationInfo> | null;
  operation: OperationInfo | null;
}

/** Options the MCP door passes to the engine besides the principal. */
export type McpCallOptions = Omit<CallOptions, "principal" | "signal">;

export interface PreparedCall {
  operation: OperationInfo;
  action: string | null;
  input: Record<string, unknown>;
  options: McpCallOptions;
}

/**
 * Resolves requested toolset names to the set of toolsets to expose: `all` expands to every
 * toolset, `agent_brain` is added when a workspace uses the agent brain. Throws an actionable
 * error on unknown names.
 */
export function resolveToolsets(
  requested: string | readonly string[] | undefined,
  options: { agentBrain?: boolean } = {},
): Set<Toolset> {
  const names = (typeof requested === "string" ? requested.split(",") : (requested ?? ["core"]))
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const selected = new Set<Toolset>();
  const unknown: string[] = [];
  for (const name of names.length > 0 ? names : ["core"]) {
    if (name === "all") {
      for (const toolset of TOOLSETS) selected.add(toolset);
    } else if ((TOOLSETS as readonly string[]).includes(name)) {
      selected.add(name as Toolset);
    } else {
      unknown.push(name);
    }
  }
  if (unknown.length > 0) {
    throw new OpenOutboundError("validation_failed", `Unknown toolset(s): ${unknown.join(", ")}.`, {
      hint: `Use a comma list of: ${[...TOOLSETS, "all"].join(", ")} (for example --toolsets core,leads).`,
      details: { unknown },
    });
  }
  if (options.agentBrain) selected.add("agent_brain");
  return selected;
}

/**
 * Builds the MCP tool specs for the selected toolsets. Composite tools get one flattened input
 * object: `action` plus the union of their operations' fields (a field is required only when
 * every action requires it). Tools that reference unknown operations are reported in
 * `problems` and skipped (or trimmed to the actions that exist).
 */
export function buildToolSpecs(
  catalog: Catalog,
  toolsets: ReadonlySet<Toolset>,
): { specs: McpToolSpec[]; problems: string[] } {
  const operations = new Map(catalog.operations.map((operation) => [operation.id, operation]));
  const specs: McpToolSpec[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const tool of catalog.tools) {
    if (!toolsets.has(tool.toolset)) continue;
    if (seen.has(tool.name)) {
      problems.push(`Tool ${tool.name} is defined twice; the first definition wins.`);
      continue;
    }
    seen.add(tool.name);
    const spec = buildToolSpec(tool, operations, problems);
    if (spec) specs.push(spec);
  }
  return { specs, problems };
}

function buildToolSpec(
  tool: ToolInfo,
  operations: Map<string, OperationInfo>,
  problems: string[],
): McpToolSpec | null {
  if (!tool.actions) {
    const operation = tool.operation ? operations.get(tool.operation) : undefined;
    if (!operation) {
      problems.push(`Tool ${tool.name} references unknown operation ${tool.operation}; skipped.`);
      return null;
    }
    return {
      name: tool.name,
      title: tool.title,
      description: describeTool(tool, [[null, operation]]),
      toolset: tool.toolset,
      inputSchema: closeObject(operation.input_schema),
      annotations: operationAnnotations(operation),
      actions: null,
      operation,
    };
  }
  const actions: Array<[string, OperationInfo]> = [];
  for (const [action, operationId] of Object.entries(tool.actions)) {
    const operation = operations.get(operationId);
    if (operation) actions.push([action, operation]);
    else problems.push(`Tool ${tool.name} action ${action}: unknown operation ${operationId}.`);
  }
  if (actions.length === 0) {
    problems.push(`Tool ${tool.name} has no usable actions; skipped.`);
    return null;
  }
  return {
    name: tool.name,
    title: tool.title,
    description: describeTool(tool, actions),
    toolset: tool.toolset,
    inputSchema: flattenActions(actions),
    annotations: combineAnnotations(actions.map(([, operation]) => operation)),
    actions: Object.fromEntries(actions),
    operation: null,
  };
}

/**
 * `{ action, ...union of fields }` with per-action notes in descriptions. What each action does
 * is listed once, in the tool description (`describeTool`); the `action` field only points there.
 */
export function flattenActions(actions: Array<[string, OperationInfo]>): JsonSchema {
  const actionNames = actions.map(([action]) => action);
  interface Variant {
    schema: JsonSchema;
    actions: string[];
  }
  const fields = new Map<string, { variants: Map<string, Variant>; actions: string[] }>();
  const requiredCount = new Map<string, number>();
  const defs: Record<string, unknown> = {};

  for (const [action, operation] of actions) {
    const schema = operation.input_schema;
    if (schema.$defs && typeof schema.$defs === "object") {
      for (const [name, def] of Object.entries(schema.$defs as Record<string, unknown>)) {
        defs[name] ??= def;
      }
    }
    for (const [name, property] of Object.entries(schemaProperties(schema))) {
      let field = fields.get(name);
      if (!field) {
        field = { variants: new Map(), actions: [] };
        fields.set(name, field);
      }
      field.actions.push(action);
      // Schemas that differ only in their description are the same field.
      const { description: _description, ...shape } = property;
      const key = stableStringify(shape);
      const variant = field.variants.get(key);
      if (variant) {
        variant.actions.push(action);
        if (!describe(variant.schema) && describe(property)) variant.schema = property;
      } else field.variants.set(key, { schema: property, actions: [action] });
    }
    for (const name of schemaRequired(schema)) {
      requiredCount.set(name, (requiredCount.get(name) ?? 0) + 1);
    }
  }

  const properties: Record<string, JsonSchema> = {
    action: {
      type: "string",
      enum: actionNames,
      description: ACTION_FIELD_DESCRIPTION,
    },
  };
  for (const [name, field] of fields) {
    const usedByAll = field.actions.length === actionNames.length;
    const prefix = usedByAll ? "" : `Used by: ${field.actions.join(", ")}. `;
    const variants = [...field.variants.values()];
    if (variants.length === 1) {
      const only = variants[0] as Variant;
      properties[name] = withDescription(only.schema, `${prefix}${describe(only.schema)}`);
    } else {
      properties[name] = {
        anyOf: variants.map((variant) =>
          withDescription(
            variant.schema,
            `For ${variant.actions.join(", ")}: ${describe(variant.schema)}`,
          ),
        ),
        description: `${prefix}Meaning depends on the action.`.trim(),
      };
    }
  }
  const required = [
    "action",
    ...[...requiredCount.entries()]
      .filter(([name, count]) => count === actionNames.length && name !== "action")
      .map(([name]) => name),
  ];
  const result: JsonSchema = {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
  if (Object.keys(defs).length > 0) result.$defs = defs;
  return result;
}

/** The `action` field of a composite tool: the tool description lists what each action does. */
export const ACTION_FIELD_DESCRIPTION = "What to do: see Actions in the tool description.";

function closeObject(schema: JsonSchema): JsonSchema {
  return { ...schema, type: "object", additionalProperties: false };
}

function describe(schema: JsonSchema): string {
  return typeof schema.description === "string" ? schema.description : "";
}

function withDescription(schema: JsonSchema, description: string): JsonSchema {
  const text = description.trim();
  if (!text) {
    const { description: _drop, ...rest } = schema;
    return rest;
  }
  return { ...schema, description: text };
}

function trimSentence(text: string): string {
  return text.trim().replace(/\.+$/, "");
}

/** Annotations for a composite tool: read-only only if every action is, destructive if any is. */
export function combineAnnotations(operations: readonly OperationInfo[]): ToolAnnotationHints {
  const each = operations.map((operation) => operationAnnotations(operation));
  return {
    readOnlyHint: each.every((a) => a.readOnlyHint),
    destructiveHint: each.some((a) => a.destructiveHint),
    idempotentHint: each.every((a) => a.idempotentHint),
    openWorldHint: each.some((a) => a.openWorldHint),
  };
}

function describeTool(tool: ToolInfo, actions: Array<[string | null, OperationInfo]>): string {
  const parts = [tool.description.trim()];
  if (tool.actions) {
    const lines = actions.map(
      ([action, operation]) => `- ${action}: ${trimSentence(operation.summary)}.`,
    );
    parts.push(`Actions:\n${lines.join("\n")}`);
  }
  const example = pickExample(actions);
  if (example) parts.push(`Example input: ${JSON.stringify(example)}`);
  return parts.join("\n\n");
}

function pickExample(
  actions: Array<[string | null, OperationInfo]>,
): Record<string, unknown> | null {
  for (const [action, operation] of actions) {
    const example = operation.examples[0];
    if (!example || typeof example.input !== "object" || example.input === null) continue;
    return action === null
      ? (example.input as Record<string, unknown>)
      : { action, ...(example.input as Record<string, unknown>) };
  }
  return null;
}

const COMMON = new Set<string>(RESERVED_INPUT_FIELDS);

/**
 * Maps tool arguments to one operation call: picks the action's operation, rejects fields the
 * action does not accept (with the list of fields it does accept), drops nulls for fields that
 * do not take null, and lifts the common fields into call options.
 */
export function prepareCall(
  spec: McpToolSpec,
  rawArgs: unknown,
  defaultWorkspace: string | null | undefined,
): PreparedCall {
  const args: Record<string, unknown> =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? { ...(rawArgs as Record<string, unknown>) }
      : {};
  let action: string | null = null;
  let operation: OperationInfo;
  if (spec.actions) {
    const names = Object.keys(spec.actions);
    const requested = args.action;
    if (typeof requested !== "string" || !spec.actions[requested]) {
      throw new OpenOutboundError(
        "validation_failed",
        typeof requested === "string"
          ? `Unknown action "${requested}" for ${spec.name}.`
          : `${spec.name} needs an "action".`,
        {
          hint: `Pass action as one of: ${names.join(", ")}.`,
          details: { field: "action", allowed: names },
        },
      );
    }
    action = requested;
    operation = spec.actions[requested] as OperationInfo;
    delete args.action;
  } else {
    operation = spec.operation as OperationInfo;
  }

  // dry_run reaches the engine for every operation, so every door answers alike: a preview,
  // `unsupported` for a write without one, and reads ignore it.
  const dryRunArg = args.dry_run;
  delete args.dry_run;

  const properties = schemaProperties(operation.input_schema);
  const input: Record<string, unknown> = {};
  const unexpected: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const property = properties[key];
    if (!property) {
      if (value === null || value === "") continue;
      unexpected.push(key);
      continue;
    }
    if (value === null && !allowsNull(property)) continue;
    input[key] = value;
  }
  if (unexpected.length > 0) {
    const accepted = Object.keys(properties).filter((name) => !COMMON.has(name));
    const target = action ? `action "${action}"` : spec.name;
    throw new OpenOutboundError(
      "validation_failed",
      `${plural(unexpected.length, "Field")} ${unexpected.map((f) => `"${f}"`).join(", ")} ${unexpected.length === 1 ? "is" : "are"} not used by ${target}.`,
      {
        hint: `Fields for ${target}: ${accepted.join(", ") || "(none)"}. Remove the others and try again.`,
        details: { unexpected, accepted },
      },
    );
  }

  const options: McpCallOptions = {};
  const workspace = takeString(input, "workspace") ?? defaultWorkspace ?? undefined;
  if (workspace) options.workspace = workspace;
  const reason = takeString(input, "reason");
  if (reason) options.reason = reason;
  const idempotencyKey = takeString(input, "idempotency_key");
  if (idempotencyKey) options.idempotencyKey = idempotencyKey;
  // A dry_run that is not a boolean goes to the engine as given, which refuses it.
  if (typeof dryRunArg === "boolean") options.dryRun = dryRunArg;
  else if (dryRunArg !== undefined && dryRunArg !== null) input.dry_run = dryRunArg;
  const responseFormat = takeString(input, "response_format");
  if (responseFormat === "concise" || responseFormat === "detailed") {
    options.responseFormat = responseFormat;
  }
  return { operation, action, input, options };
}

function takeString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  delete input[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** True when the JSON Schema accepts null. */
export function allowsNull(schema: JsonSchema): boolean {
  const type = schema.type;
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) return true;
  for (const key of ["anyOf", "oneOf"] as const) {
    const members = schema[key];
    if (Array.isArray(members) && members.some((m) => allowsNull(m as JsonSchema))) return true;
  }
  return false;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
