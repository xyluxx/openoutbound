import { describe, expect, it } from "vitest";
import { createFakeEngine } from "../../tests/e2e/fake-engine.js";
import { buildStaticRegistry } from "../cli/static-registry.js";
import { isOpenOutboundError, type OpenOutboundError } from "../core/errors.js";
import { modules } from "../modules/index.js";
import { buildCatalog } from "./catalog.js";
import { MCP_INSTRUCTIONS, mcpInstructions } from "./instructions.js";
import type { JsonSchema } from "./json-schema.js";
import {
  allowsNull,
  buildToolSpecs,
  type McpToolSpec,
  prepareCall,
  resolveToolsets,
} from "./tools.js";

const engine = createFakeEngine();
const catalog = buildCatalog(engine.registry, "0.1.0");

function spec(name: string, toolsets = resolveToolsets("all")): McpToolSpec {
  const found = buildToolSpecs(catalog, toolsets).specs.find((s) => s.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function catchError(fn: () => unknown): OpenOutboundError {
  try {
    fn();
  } catch (error) {
    if (isOpenOutboundError(error)) return error;
    throw error;
  }
  throw new Error("expected an error");
}

describe("resolveToolsets", () => {
  it("defaults to core, expands all, accepts comma lists and adds agent_brain", () => {
    expect([...resolveToolsets(undefined)]).toEqual(["core"]);
    expect([...resolveToolsets("")]).toEqual(["core"]);
    expect(resolveToolsets("all").size).toBe(8);
    expect([...resolveToolsets("core, leads")].sort()).toEqual(["core", "leads"]);
    expect([...resolveToolsets(["core"], { agentBrain: true })].sort()).toEqual([
      "agent_brain",
      "core",
    ]);
  });

  it("rejects unknown toolsets with the valid list", () => {
    const error = catchError(() => resolveToolsets("core,nope"));
    expect(error.code).toBe("validation_failed");
    expect(error.message).toContain("nope");
    expect(error.hint).toContain("core, leads");
  });
});

describe("buildToolSpecs", () => {
  it("filters tools by toolset", () => {
    const core = buildToolSpecs(catalog, resolveToolsets("core")).specs.map((s) => s.name);
    expect(core).toEqual(["manage_items"]);
    const all = buildToolSpecs(catalog, resolveToolsets("all")).specs.map((s) => s.name);
    expect(all).toEqual(["manage_items", "send_item", "run_job", "ping"]);
  });

  it("flattens composite tools into one object with an action enum", () => {
    const tool = spec("manage_items");
    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, JsonSchema>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.action?.enum).toEqual(["list", "get", "create", "delete"]);
    expect(schema.properties.action?.description).toBe(
      "What to do: see Actions in the tool description.",
    );
    // item_id is used by get and delete only, so it is optional and says which actions use it.
    expect(schema.required).toEqual(["action"]);
    expect(String(schema.properties.item_id?.description)).toMatch(/^Used by: get, delete\./);
    // get describes item_id and delete does not: still one field, not an anyOf.
    expect(schema.properties.item_id?.anyOf).toBeUndefined();
    expect(schema.properties.item_id?.description).toBe("Used by: get, delete. Item id");
    // Fields shared by every action carry no "Used by" prefix.
    expect(String(schema.properties.reason?.description)).not.toContain("Used by");
    // dry_run only exists for create.
    expect(String(schema.properties.dry_run?.description)).toContain("Used by: create.");
    expect(tool.description).toContain("Actions:\n- list: List demo items.");
    expect(tool.description).toContain(
      'Example input: {"action":"list","status":"open","limit":10}',
    );
  });

  it("says what each action does once, in the tool description", () => {
    const tool = spec("manage_items");
    const listed = JSON.stringify({ description: tool.description, input: tool.inputSchema });
    for (const summary of ["List demo items", "Create a demo item"]) {
      expect(listed.split(summary)).toHaveLength(2);
    }
  });

  it("marks a field required only when every action requires it", () => {
    const tool = spec("send_item");
    expect(tool.inputSchema.required).toEqual(["item_id"]);
    expect(tool.actions).toBeNull();
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it("derives annotations from effects", () => {
    expect(spec("manage_items").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(spec("send_item").annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    });
    expect(spec("ping").annotations.readOnlyHint).toBe(false);
  });

  it("reports and skips tools pointing at unknown operations", () => {
    const broken = {
      ...catalog,
      tools: [
        ...catalog.tools,
        {
          name: "broken",
          title: "Broken",
          description: "x",
          toolset: "core" as const,
          actions: { go: "demo.missing" },
          operation: null,
        },
      ],
    };
    const result = buildToolSpecs(broken, resolveToolsets("core"));
    expect(result.specs.map((s) => s.name)).toEqual(["manage_items"]);
    expect(result.problems.join(" ")).toContain("demo.missing");
  });
});

describe("prepareCall", () => {
  const tool = spec("manage_items");

  it("maps an action to its operation and lifts common fields into call options", () => {
    const prepared = prepareCall(
      tool,
      {
        action: "create",
        name: "Gamma",
        reason: "testing",
        dry_run: true,
        idempotency_key: "k1",
        workspace: "acme",
      },
      "globex",
    );
    expect(prepared.operation.id).toBe("demo.create_item");
    expect(prepared.action).toBe("create");
    expect(prepared.input).toEqual({ name: "Gamma" });
    expect(prepared.options).toEqual({
      workspace: "acme",
      reason: "testing",
      dryRun: true,
      idempotencyKey: "k1",
    });
  });

  it("uses the default workspace when the call names none", () => {
    expect(prepareCall(tool, { action: "list" }, "globex").options.workspace).toBe("globex");
  });

  it("rejects a missing or unknown action with the valid actions", () => {
    expect(catchError(() => prepareCall(tool, {}, null)).hint).toContain(
      "list, get, create, delete",
    );
    const unknown = catchError(() => prepareCall(tool, { action: "explode" }, null));
    expect(unknown.code).toBe("validation_failed");
    expect(unknown.message).toContain('Unknown action "explode"');
  });

  it("rejects fields the action does not use and lists the ones it does", () => {
    const error = catchError(() =>
      prepareCall(tool, { action: "get", item_id: "it_1", status: "open" }, null),
    );
    expect(error.message).toBe('Field "status" is not used by action "get".');
    expect(error.hint).toContain('Fields for action "get": item_id');
  });

  it("ignores nulls and empty strings for fields that do not take them", () => {
    const prepared = prepareCall(
      tool,
      { action: "list", status: null, min_score: null, query: "", note: null },
      null,
    );
    expect(prepared.input).toEqual({});
    // note accepts null on create, so null is kept there.
    expect(prepareCall(tool, { action: "create", name: "x", note: null }, null).input).toEqual({
      name: "x",
      note: null,
    });
  });

  it("knows which schemas accept null", () => {
    expect(allowsNull({ type: ["string", "null"] })).toBe(true);
    expect(allowsNull({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe(true);
    expect(allowsNull({ type: "string" })).toBe(false);
  });
});

describe("the core toolset of the built-in modules", () => {
  const builtIn = buildCatalog(buildStaticRegistry(modules), "0.1.0");

  it("has the tools problem remedies name most often", () => {
    const core = buildToolSpecs(builtIn, resolveToolsets("core")).specs.map((s) => s.name);
    // Privacy deletions (forget), unknown sends (resolve_unknown) and promises (tasks).
    expect(core).toEqual(
      expect.arrayContaining(["manage_leads", "manage_messages", "manage_tasks"]),
    );
    const leads = buildToolSpecs(builtIn, resolveToolsets("leads")).specs.map((s) => s.name);
    expect(leads).toEqual(expect.arrayContaining(["enrich_leads", "manage_suppressions"]));
  });

  it("tells a bound session where it works and that another workspace is refused", () => {
    expect(MCP_INSTRUCTIONS).toContain(
      "A session started with --workspace (or a key created for one workspace) is bound to it: every call works there, get_status names it, and passing another workspace is refused.",
    );
    expect(mcpInstructions("northwind")).toContain(
      'This session is bound to workspace "northwind": leave out `workspace`; passing another workspace is refused.',
    );
    expect(mcpInstructions(null)).toBe(MCP_INSTRUCTIONS);
  });

  it("tells the agent what to do when a remedy names a tool it does not have", () => {
    expect(MCP_INSTRUCTIONS).toContain(
      "When a named tool is missing, ask the human to restart the server with --toolsets core,<toolset>.",
    );
  });
});
