/**
 * Letting an automation enroll people without approval is an approval gate (spec 2, rule 4),
 * through the real engine: anyone who must ask gets the rule with approvals on and an
 * approval of kind automation_approval; turning approvals on never asks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_SCOPES } from "../../../core/context.js";
import { createTestEngine, type TestEngine } from "../../../testing/engine.js";

interface Rule {
  id: string;
  name: string;
  require_approval: boolean;
  filters: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
}

interface Held {
  status: string;
  approval_id: string;
  summary: string;
}

let engine: TestEngine;
let workspace: string;
let campaignId: string;

beforeAll(async () => {
  engine = await createTestEngine();
  workspace = (
    (await engine.call("workspaces.create", { name: "Automation Gate Co" })) as {
      slug: string;
    }
  ).slug;
  campaignId = (
    (await engine.call(
      "campaigns.create",
      { name: "Champions", template: "signal_based_email_4" },
      { workspace },
    )) as { id: string }
  ).id;
});
afterAll(() => engine.close());

const agent = () =>
  engine.principal({
    type: "agent",
    id: "key_automation_agent",
    name: "Automation agent",
    scopes: [...ALL_SCOPES],
  });

const enroll = () => [{ type: "enroll", campaign_id: campaignId, max_people: 1 }];

const rules = async () =>
  (
    (await engine.call("signals.automations.list", {}, { workspace })) as {
      items: Rule[];
    }
  ).items;

const ruleById = async (id: string) => (await rules()).find((row) => row.id === id);

const decideAs = async (approvalId: string, principal?: ReturnType<typeof agent>) =>
  (
    (await engine.call(
      "approvals.decide",
      { approval_id: approvalId, decision: "approve" },
      { workspace, ...(principal ? { principal } : {}) },
    )) as { results: Array<Record<string, unknown>> }
  ).results[0];

const summaryOf = async (approvalId: string) =>
  (
    (await engine.call("approvals.get", { approval_id: approvalId }, { workspace })) as {
      summary: string;
    }
  ).summary;

const NARROW = { definition_keys: ["job_change"], has_email: true, min_score: 90 };
const wide = () => [{ type: "enroll", campaign_id: campaignId, max_people: 25 }];

describe("automation approval gate", () => {
  it("creates the rule with approvals on and asks a person to turn them off", async () => {
    const held = (await engine.call(
      "signals.automations.create",
      { name: "Champion moved", actions: enroll(), require_approval: false },
      { workspace, principal: agent() },
    )) as Held;
    expect(held.status).toBe("awaiting_approval");
    const rule = (await rules()).find((row) => row.name === "Champion moved");
    expect(rule?.require_approval).toBe(true);

    const own = (await engine.call(
      "approvals.decide",
      { approval_id: held.approval_id, decision: "approve" },
      { workspace, principal: agent() },
    )) as { results: Array<Record<string, unknown>> };
    expect(own.results[0]).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const decided = (await engine.call(
      "approvals.decide",
      { approval_id: held.approval_id, decision: "approve" },
      { workspace },
    )) as { results: Array<Record<string, unknown>> };
    expect(decided.results[0]).toMatchObject({ ok: true, status: "approved" });
    expect((await rules()).find((row) => row.id === rule?.id)?.require_approval).toBe(false);
  });

  it("asks when an update would start enrolling without approval, never the other way", async () => {
    // A notify-only rule has no approvals to turn off.
    const quiet = (await engine.call(
      "signals.automations.create",
      { name: "Funding alert", actions: [{ type: "notify" }], require_approval: false },
      { workspace, principal: agent() },
    )) as Rule;
    expect(quiet.require_approval).toBe(false);

    // Adding an enroll action to it is the same as turning approvals off.
    const held = (await engine.call(
      "signals.automations.update",
      { rule_id: quiet.id, name: "Funding enroll", actions: enroll() },
      { workspace, principal: agent() },
    )) as Held;
    expect(held.status).toBe("awaiting_approval");
    expect(held.summary).toContain("Changed now: name, actions.");
    const stored = (await rules()).find((row) => row.id === quiet.id);
    expect(stored).toMatchObject({ name: "Funding enroll", require_approval: true });

    // Turning approvals on, or a person turning them off, applies at once.
    const person = (await engine.call(
      "signals.automations.update",
      { rule_id: quiet.id, require_approval: false },
      { workspace },
    )) as Rule;
    expect(person.require_approval).toBe(false);
    const safer = (await engine.call(
      "signals.automations.update",
      { rule_id: quiet.id, require_approval: true },
      { workspace, principal: agent() },
    )) as Rule;
    expect(safer.require_approval).toBe(true);
  });

  it("asks before a rule that enrolls unattended enrolls other people, and keeps it until then", async () => {
    // A person lets a narrow rule enroll without approval.
    const rule = (await engine.call(
      "signals.automations.create",
      { name: "Narrow champions", filters: NARROW, actions: enroll(), require_approval: false },
      { workspace },
    )) as Rule;
    expect(rule.require_approval).toBe(false);

    // Other actions and the name change at once; who it enrolls does not.
    const notify = (await engine.call(
      "signals.automations.update",
      { rule_id: rule.id, actions: [...enroll(), { type: "notify" }] },
      { workspace, principal: agent() },
    )) as Rule;
    expect(notify.actions).toHaveLength(2);
    const held = (await engine.call(
      "signals.automations.update",
      { rule_id: rule.id, name: "Every champion", filters: {}, actions: wide() },
      { workspace, principal: agent() },
    )) as Held;
    expect(held.status).toBe("awaiting_approval");
    expect(await ruleById(rule.id)).toMatchObject({
      name: "Every champion",
      filters: NARROW,
      actions: [...enroll(), { type: "notify" }],
      require_approval: false,
    });
    const summary = await summaryOf(held.approval_id);
    expect(summary).toContain('"max_people":25');
    expect(summary).toContain("Filters: none");

    expect(await decideAs(held.approval_id, agent())).toMatchObject({
      error: { code: "forbidden" },
    });
    expect(await decideAs(held.approval_id)).toMatchObject({ ok: true, status: "approved" });
    expect(await ruleById(rule.id)).toMatchObject({
      filters: {},
      actions: wide(),
      require_approval: false,
    });
  });

  it("applies a request only to the rule it showed", async () => {
    const held = (await engine.call(
      "signals.automations.create",
      { name: "Careful rule", filters: NARROW, actions: enroll(), require_approval: false },
      { workspace, principal: agent() },
    )) as Held;
    expect(held.status).toBe("awaiting_approval");
    const summary = await summaryOf(held.approval_id);
    expect(summary).toContain('"min_score":90');
    expect(summary).toContain('"type":"enroll"');
    const rule = (await rules()).find((row) => row.name === "Careful rule");
    if (!rule) throw new Error("rule missing");

    // While it waits (approvals still on, so nothing to ask), the agent widens the rule.
    const widened = (await engine.call(
      "signals.automations.update",
      { rule_id: rule.id, filters: {}, actions: wide() },
      { workspace, principal: agent() },
    )) as Rule;
    expect(widened.require_approval).toBe(true);
    expect(await decideAs(held.approval_id)).toMatchObject({
      ok: false,
      status: "pending",
      error: { code: "conflict", message: expect.stringContaining("changed since") },
    });
    expect(await ruleById(rule.id)).toMatchObject({ filters: {}, require_approval: true });
  });
});
