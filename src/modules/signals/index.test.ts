import { describe, expect, it } from "vitest";
import { operationCliPath, toolOperationIds } from "../../core/operation.js";
import { providers } from "../../providers/signals/index.js";
import { module } from "./index.js";

describe("signals module registration", () => {
  const operations = module.operations ?? [];
  const ids = operations.map((operation) => operation.id);

  it("registers unique operations with unique HTTP routes and CLI paths", () => {
    expect(new Set(ids).size).toBe(ids.length);
    const routes = operations.map((op) => `${op.http?.method} ${op.http?.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    const cli = operations.map((op) => operationCliPath(op).join(" "));
    expect(new Set(cli).size).toBe(cli.length);
    for (const operation of operations) {
      expect(operation.examples.length, operation.id).toBeGreaterThan(0);
      expect(operation.description.length, operation.id).toBeGreaterThan(150);
    }
  });

  it("points every tool action at a registered operation", () => {
    for (const tool of module.tools ?? []) {
      for (const id of toolOperationIds(tool)) expect(ids, `${tool.name} -> ${id}`).toContain(id);
    }
    const signalsTool = module.tools?.find((tool) => tool.name === "manage_signals");
    expect(Object.keys(signalsTool?.actions ?? {})).toEqual(
      expect.arrayContaining([
        "feed",
        "get",
        "list_definitions",
        "update_definition",
        "define_custom",
        "remove_definition",
        "dismiss",
        "list_monitors",
        "create_monitor",
        "update_monitor",
        "run_monitor",
        "ingest",
      ]),
    );
    const automationsTool = module.tools?.find((tool) => tool.name === "manage_automations");
    expect(automationsTool?.toolset).toBe("signals");
    expect(Object.keys(automationsTool?.actions ?? {})).toEqual([
      "list",
      "create",
      "update",
      "remove",
      "test",
    ]);
  });

  it("schedules only registered jobs and handles the expected events", () => {
    const jobs = (module.jobs ?? []).map((job) => job.name);
    expect(jobs).toEqual(["monitors.run", "monitors.tick", "signals.recompute_intent"]);
    for (const schedule of module.schedules ?? []) expect(jobs).toContain(schedule.job);
    expect(
      (module.eventHandlers ?? []).map((handler) => `${handler.event}:${handler.name}`),
    ).toEqual([
      "reply.received:signals.first_party_reply",
      "message.bounced:signals.first_party_bounce",
      "signal.detected:signals.run_automations",
    ]);
    expect(module.httpRoutes).toHaveLength(1);
  });

  it("leaves providers to the slot index (the registry rejects duplicates)", () => {
    expect(module.providers).toBeUndefined();
    expect(providers.map((provider) => provider.id)).toEqual([
      "predictleads",
      "crustdata",
      "webhook",
    ]);
    for (const provider of providers) expect(provider.slot).toBe("signals");
  });
});
