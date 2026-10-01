import { describe, expect, it } from "vitest";
import { z } from "zod";
import { onEvent } from "../core/events.js";
import {
  type AnyOperation,
  defineJob,
  defineOperation,
  defineTool,
  type EngineModule,
} from "../core/operation.js";
import { modules as builtinModules } from "../modules/index.js";
import { defineProvider } from "../providers/types.js";
import { KERNEL_CONTRIBUTIONS } from "./create-engine.js";
import { buildRegistry, eventJobName } from "./registry.js";

function op(
  id: string,
  overrides: Partial<Pick<AnyOperation, "effect" | "dryRun" | "http">> = {},
): AnyOperation {
  return defineOperation({
    id,
    summary: id,
    description: `${id} for registry tests.`,
    effect: overrides.effect ?? "write",
    input: z.object({ name: z.string().describe("A name") }),
    output: z.object({ ok: z.boolean() }),
    dryRun: overrides.dryRun ?? "none",
    idempotent: true,
    workspace: "required",
    examples: [],
    ...(overrides.http ? { http: overrides.http } : {}),
    handler: async () => ({ ok: true }),
  }) as AnyOperation;
}

const job = (name: string) => defineJob({ name, handler: async () => ({}) });
const verifier = (id: string) =>
  defineProvider<"email_verifier">({
    slot: "email_verifier",
    id,
    name: id,
    description: "Test provider.",
    secrets: [],
    create: () => ({
      id,
      verify: async () => {
        throw new Error("unused");
      },
    }),
  });

describe("registry", () => {
  it("accepts the built-in modules with the kernel contributions", () => {
    const registry = buildRegistry(builtinModules, KERNEL_CONTRIBUTIONS);
    for (const name of ["webhooks.deliver", "notifications.deliver", "system.maintenance"]) {
      expect(registry.job(name), name).toBeDefined();
    }
    expect(registry.schedule("system.maintenance")).toMatchObject({ perWorkspace: false });
    for (const operation of registry.operations()) {
      const schema = registry.inputSchema(operation.id);
      expect(schema.shape.workspace, operation.id).toBeDefined();
      expect(() => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })).not.toThrow();
    }
    const tools = registry.tools().map((tool) => tool.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        "get_status",
        "manage_workspaces",
        "manage_providers",
        "review_items",
        "get_job",
        "manage_webhooks",
        "manage_notifications",
      ]),
    );
  });

  it("reports every conflict at once", () => {
    const first: EngineModule = {
      name: "alpha",
      operations: [
        op("alpha.run", { http: { method: "POST", path: "/v1/alpha" } }),
        op("alpha.other", { http: { method: "POST", path: "/v1/alpha" } }),
      ],
      tools: [
        defineTool({
          name: "alpha_tool",
          title: "Alpha",
          description: "Alpha tool for registry tests.",
          toolset: "core",
          operation: "alpha.missing",
        }),
      ],
      jobs: [job("alpha.work"), job("webhooks.deliver")],
      eventHandlers: [onEvent("lead.created", "alpha.on_lead", async () => {})],
      approvalResolvers: [{ kind: "message", apply: async () => ({}) }],
      schedules: [
        { name: "alpha.tick", cron: "* * * * *", job: "alpha.work", perWorkspace: true },
        { name: "alpha.ghost", cron: "* * * * *", job: "alpha.none", perWorkspace: false },
      ],
      providers: [verifier("dup_verifier")],
    };
    const second: EngineModule = {
      name: "alpha",
      operations: [op("alpha.run")],
      eventHandlers: [onEvent("lead.created", "alpha.on_lead", async () => {})],
      approvalResolvers: [{ kind: "message", apply: async () => ({}) }],
      schedules: [
        { name: "alpha.tick", cron: "0 * * * *", job: "alpha.work", perWorkspace: false },
      ],
      providers: [verifier("dup_verifier")],
    };
    let message = "";
    try {
      buildRegistry([first, second], KERNEL_CONTRIBUTIONS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split("\n")[0]).toBe("Invalid engine modules:");
    for (const problem of [
      'duplicate module "alpha"',
      'duplicate operation "alpha.run" (alpha)',
      'operations "alpha.run" and "alpha.other" share the route POST /v1/alpha',
      'tool "alpha_tool" references unknown operation "alpha.missing"',
      'duplicate job "webhooks.deliver" (alpha)',
      'duplicate event handler "alpha.on_lead" (alpha)',
      'two approval resolvers for kind "message" (alpha)',
      'duplicate schedule "alpha.tick" (alpha)',
      'schedule "alpha.ghost" references unknown job "alpha.none"',
      'Duplicate provider "dup_verifier" in slot "email_verifier"',
    ]) {
      expect(message).toContain(problem);
    }
  });

  it("adds the executor's common fields to input schemas", () => {
    const registry = buildRegistry([
      {
        name: "demo",
        operations: [
          op("demo.read", { effect: "read" }),
          op("demo.write", { dryRun: "supported" }),
          op("demo.send", { effect: "send", dryRun: "default" }),
          op("demo.plain"),
        ],
        eventHandlers: [onEvent("lead.created", "demo.on_lead", async () => {})],
      },
    ]);
    const keys = (id: string) => Object.keys(registry.inputSchema(id).shape).sort();
    expect(keys("demo.read")).toEqual([
      "idempotency_key",
      "name",
      "reason",
      "response_format",
      "workspace",
    ]);
    expect(keys("demo.write")).toContain("dry_run");
    expect(keys("demo.plain")).not.toContain("dry_run");
    expect(keys("demo.plain")).not.toContain("response_format");
    const sendSchema = registry.inputSchema("demo.send");
    expect((sendSchema.shape.dry_run as z.ZodType | undefined)?.description).toContain(
      "previews by default",
    );
    expect(registry.inputSchema("demo.send")).toBe(sendSchema);
    expect(sendSchema.safeParse({ name: "x", dry_run: false }).success).toBe(true);
    expect(registry.outputSchema("demo.read")).toBeDefined();

    expect(() => registry.inputSchema("demo.nope")).toThrowError(
      expect.objectContaining({
        code: "not_found",
        hint: "Did you mean one of: demo.read, demo.write, demo.send, demo.plain?",
      }),
    );
    expect(registry.job(eventJobName("demo.on_lead"))).toBeDefined();
    expect(registry.eventHandlers("lead.created").map((handler) => handler.name)).toEqual([
      "demo.on_lead",
    ]);
    expect(registry.eventHandlers("lead.updated")).toEqual([]);
  });
});
