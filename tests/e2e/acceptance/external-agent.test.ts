/**
 * Acceptance scenario 7, an external agent. An outside agent connects over remote MCP with an
 * API key of kind agent for this client (read, write, send and spend, no approve). It reads the
 * operating state and the next actions, then proposes a campaign change with manage_strategy
 * action propose: review every message, with its reason and evidence. Nothing changes yet: the
 * proposal waits as an approval of kind change, and the agent cannot approve it itself. A person
 * approves, and the change runs through the normal executor: an audit line, a change log entry
 * linked to the proposal and made by the agent, the proposal applied, and the campaign's next
 * emails wait for review. A proposal for an operation outside the allowlist, or from a key
 * without the scope to propose, fails with a hint; a change that needs a scope the key lacks is
 * never applied by that key and waits for an owner.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { approvals, audit_events } from "../../../src/db/schema/index.js";
import { createHttpApp } from "../../../src/http/app.js";
import {
  type Any,
  advance,
  createCampaign,
  DAY,
  enrollAndLaunch,
  firstEmailSent,
  messagesOf,
  startWorld,
  until,
  type World,
} from "./support.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Any;
};

let world: World;
const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await world?.close();
});

/** An MCP client on the engine's HTTP door, signed in with one API key. */
async function connectAgent(key: string): Promise<Client> {
  const { app, close } = createHttpApp(world.engine);
  closers.push(close);
  const client = new Client({ name: "growth-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:7331/mcp"), {
    fetch: (async (input: string | URL | Request, init?: RequestInit) =>
      app.fetch(new Request(input, init))) as typeof fetch,
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  closers.push(() => client.close());
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** The structured output of a tool call that must work. */
async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await tool(client, name, args);
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  return result.structuredContent as Any;
}

/** The structured error of a tool call that must fail. */
async function failure(client: Client, name: string, args: Record<string, unknown>) {
  const result = await tool(client, name, args);
  expect(result.isError).toBe(true);
  return result.structuredContent?.error as Any;
}

const REASON =
  "Dental groups is the first campaign with the new offer wording: the owner should see every follow-up before it goes out.";

describe("acceptance: external agent", () => {
  it("reads the state, proposes a campaign change a person approves, and gets clear refusals", async () => {
    world = await startWorld();
    const priya = await world.lead({
      person: {
        first_name: "Priya",
        last_name: "Natarajan",
        full_name: "Priya Natarajan",
        email: "priya.natarajan@harbor-dental.example.com",
      },
      company: { name: "Harbor Dental", domain: "harbor-dental.example.com" },
    });
    const omar = await world.lead({
      person: {
        first_name: "Omar",
        last_name: "Haddad",
        full_name: "Omar Haddad",
        email: "omar.haddad@cedar-dental.example.com",
      },
      company: { name: "Cedar Dental", domain: "cedar-dental.example.com" },
    });
    const campaign = await createCampaign(world, { name: "Dental groups" });
    await enrollAndLaunch(world, campaign.id, [priya.person.id, omar.person.id]);
    await firstEmailSent(world, priya.person.id);
    await firstEmailSent(world, omar.person.id);

    // The owner gives the agent a key for this client: agent scopes, no approve.
    const agentKey = await world.call<Any>("keys.create", { name: "Growth agent", kind: "agent" });
    expect(agentKey).toMatchObject({
      kind: "agent",
      workspace_id: world.workspaceId,
      scopes: ["read", "write", "send", "spend"],
    });
    const agent = await connectAgent(agentKey.key);
    const tools = (await agent.listTools()).tools.map((item) => item.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        "get_operating_state",
        "get_next_actions",
        "manage_strategy",
        "review_items",
      ]),
    );

    // It reads where things stand and what happens next.
    const state = await ok(agent, "get_operating_state");
    expect(state.workspace.id).toBe(world.workspaceId);
    expect(state.campaigns.top_active).toEqual([
      expect.objectContaining({ id: campaign.id, name: "Dental groups", sent_today: 2 }),
    ]);
    expect(state.approvals_pending.total).toBe(0);
    expect(state.problems.open).toBe(0);
    const next = await ok(agent, "get_next_actions", { hours: 96 });
    const followUps = next.items.filter((item: Any) => item.campaign_id === campaign.id);
    expect(followUps.map((item: Any) => item.person_id).sort()).toEqual(
      [priya.person.id, omar.person.id].sort(),
    );
    expect(followUps.every((item: Any) => item.kind === "campaign_step" && !item.blocked)).toBe(
      true,
    );
    expect(next.blocked).toEqual([]);

    // It proposes a change to the campaign: nothing changes, an owner must approve it.
    const proposed = await ok(agent, "manage_strategy", {
      action: "propose",
      title: "Review every message in Dental groups",
      operation: "campaigns.update",
      input: { campaign_id: campaign.id, settings: { review_level: "every" } },
      evidence: [{ label: "first emails sent with the new wording", value: "2", ref: campaign.id }],
      expected_outcome: "The owner sees each follow-up before it goes out",
      reason: REASON,
    });
    expect(proposed).toMatchObject({
      status: "awaiting_approval",
      operation: "campaigns.update",
      target_type: "campaign",
      target_id: campaign.id,
      change_id: null,
      approval_id: expect.stringMatching(/^apr_/),
      proposed_by: { type: "agent", name: "Growth agent" },
    });
    expect(proposed.message).toContain("Waiting for an owner's approval");
    const [approval] = await world.engine.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, proposed.approval_id));
    expect(approval).toMatchObject({
      workspace_id: world.workspaceId,
      kind: "change",
      status: "pending",
      target_type: "proposal",
      target_id: proposed.id,
    });
    expect(approval?.payload).toMatchObject({
      proposal_id: proposed.id,
      operation: "campaigns.update",
      reason: REASON,
    });
    const unchanged = await world.call<Any>("campaigns.get", { campaign_id: campaign.id });
    expect(unchanged.settings.review_level).toBe("unsure");
    const waiting = await ok(agent, "get_operating_state");
    expect(waiting.approvals_pending).toMatchObject({
      total: 1,
      by_kind: [{ kind: "change", count: 1 }],
    });

    // The agent cannot approve its own change.
    const selfApproval = await failure(agent, "review_items", {
      action: "decide",
      approval_id: proposed.approval_id,
      decision: "approve",
    });
    expect(selfApproval).toMatchObject({
      code: "forbidden",
      details: { missing_scope: "approve" },
    });
    expect(selfApproval.hint).toContain('includes the "approve" scope');
    expect(
      await ok(agent, "manage_strategy", { action: "proposal", proposal_id: proposed.id }),
    ).toMatchObject({ status: "awaiting_approval" });

    // A person approves: the change runs through the normal executor as the agent.
    const decided = await world.call<Any>("approvals.decide", {
      approval_id: proposed.approval_id,
      decision: "approve",
    });
    expect(decided.results[0]).toMatchObject({
      ok: true,
      status: "approved",
      data: { status: "applied" },
    });
    const applied = await ok(agent, "manage_strategy", {
      action: "proposal",
      proposal_id: proposed.id,
    });
    expect(applied).toMatchObject({
      status: "applied",
      decided_by: { type: "human" },
      change_id: expect.stringMatching(/^chg_/),
    });
    const change = await ok(agent, "manage_strategy", {
      action: "change",
      change_id: applied.change_id,
    });
    expect(change).toMatchObject({
      proposal_id: proposed.id,
      operation: "campaigns.update",
      area: "campaign",
      target_id: campaign.id,
      actor: { type: "agent", name: "Growth agent" },
      via: "mcp",
      reason: `Proposal ${proposed.id}: ${REASON}`,
      diff: [{ path: "settings.review_level", before: "unsure", after: "every" }],
    });
    const audit = await world.engine.db
      .select()
      .from(audit_events)
      .where(
        and(
          eq(audit_events.workspace_id, world.workspaceId),
          eq(audit_events.operation, "campaigns.update"),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      status: "ok",
      actor_type: "agent",
      actor_id: agentKey.id,
      actor_name: "Growth agent",
      target_id: campaign.id,
      reason: `Proposal ${proposed.id}: ${REASON}`,
    });
    const updated = await world.call<Any>("campaigns.get", { campaign_id: campaign.id });
    expect(updated.settings.review_level).toBe("every");
    expect(updated.settings.senders.mailbox_ids).toEqual([world.mailbox.id]);

    // In practice: three days later the follow-ups wait for a person's review.
    await advance(world.engine, 3 * DAY);
    await until(world.engine, "both follow-ups wait for review", async () => {
      const rows = await Promise.all(
        [priya, omar].map((lead) =>
          messagesOf(world, { personId: lead.person.id, direction: "outbound" }),
        ),
      );
      return rows.every(
        (messages) =>
          messages.some((row) => row.status === "sent") &&
          messages.some((row) => row.status === "pending_review"),
      );
    });
    const reviews = await world.engine.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.workspace_id, world.workspaceId),
          eq(approvals.kind, "message"),
          eq(approvals.status, "pending"),
        ),
      );
    expect(reviews).toHaveLength(2);

    // Refusals with a hint. An operation outside the allowlist:
    const outside = await failure(agent, "manage_strategy", {
      action: "propose",
      title: "Launch the campaign again",
      operation: "campaigns.launch",
      input: { campaign_id: campaign.id },
      reason: "Restart it.",
    });
    expect(outside).toMatchObject({ code: "validation_failed" });
    expect(outside.message).toContain("campaigns.launch cannot be proposed");
    expect(outside.hint).toBe(
      "Propose one of the allowed operations, or run the operation directly if your key may.",
    );
    expect(outside.details.allowed).toContain("campaigns.update");

    // A key without the write scope cannot propose at all:
    const readerKey = await world.call<Any>("keys.create", {
      name: "Reporting agent",
      kind: "agent",
      scopes: ["read"],
    });
    const reader = await connectAgent(readerKey.key);
    const readOnly = await failure(reader, "manage_strategy", {
      action: "propose",
      title: "Pause Dental groups",
      operation: "campaigns.pause",
      input: { campaign_id: campaign.id },
      reason: "Replies dropped.",
    });
    expect(readOnly).toMatchObject({ code: "forbidden", details: { missing_scope: "write" } });
    expect(readOnly.hint).toContain('includes the "write" scope');

    // A change that needs a scope the key lacks (admin, for workspace settings) is never applied
    // with that key: it waits for an owner, and the answer names the missing scope.
    const settingsChange = await ok(agent, "manage_strategy", {
      action: "propose",
      title: "Hand meetings to the owner",
      operation: "workspaces.update",
      input: { settings: { booking: { mode: "handoff" } } },
      reason: "The owner prefers to book every meeting himself.",
    });
    expect(settingsChange).toMatchObject({ status: "awaiting_approval", change_id: null });
    expect(settingsChange.message).toContain("your key lacks admin for workspaces.update");

    // Only the one approved change was made by the agent; the refused proposals left nothing
    // behind (the older entry is the offer the owner set up).
    const proposals = await ok(agent, "manage_strategy", { action: "proposals" });
    expect(proposals.items.map((item: Any) => [item.title, item.status])).toEqual([
      ["Hand meetings to the owner", "awaiting_approval"],
      ["Review every message in Dental groups", "applied"],
    ]);
    const changes = await ok(agent, "manage_strategy", { action: "changes" });
    expect(changes.items.map((item: Any) => [item.change_id, item.actor?.type])).toEqual([
      [applied.change_id, "agent"],
      [expect.stringMatching(/^chg_/), "human"],
    ]);
    expect(changes.items[1]).toMatchObject({ area: "offer", target_id: world.offerId });
  });
});
