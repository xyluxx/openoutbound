/**
 * Change proposals through the engine: the allowlist and input checks, people applying at once,
 * agents waiting for an approval (unless approvals.agent_changes is auto), approve, edit and
 * reject, failures stored, change log rows linked, and workspaces kept apart.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../core/context.js";
import { isOpenOutboundError } from "../../core/errors.js";
import { audit_events, offers } from "../../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { module as system } from "../system/index.js";
import { module as workspaces } from "../workspaces/index.js";
import { module as strategy } from "./index.js";

// biome-ignore lint/suspicious/noExplicitAny: results are checked with expect
type Any = any;

const DAY = 24 * 60 * 60 * 1000;
const MISSING_OFFER = "off_01k6a3v0q8x3m2n4p5r6s7t8v9";

let engine: TestEngine;
let workspace: string;
let agent: Principal;

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isOpenOutboundError(error)) return error;
    throw error;
  }
  throw new Error("expected an error");
}

async function newOffer(name: string): Promise<Any> {
  return engine.call("offers.create", { name, summary: "A pilot." }, { workspace });
}

async function offerSummary(offerId: string): Promise<string | undefined> {
  const [row] = await engine.db.select().from(offers).where(eq(offers.id, offerId));
  return row?.summary;
}

function propose(input: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return engine.call("changes.propose", input, {
    workspace,
    reason: "Replies ask what the pilot includes",
    ...options,
  }) as Promise<Any>;
}

beforeAll(async () => {
  engine = await createTestEngine();
  const created = (await engine.call("workspaces.create", { name: "Harbor Analytics" })) as Any;
  workspace = created.id;
  agent = engine.principal({
    type: "agent",
    id: "key_growth_agent",
    name: "Growth agent",
    scopes: ["read", "write"],
    via: "mcp",
  });
});
afterAll(async () => {
  await engine.close();
});

describe("proposing", () => {
  it("applies a person's proposal at once through the executor", async () => {
    const proposed = await propose(
      {
        title: "Set the goals",
        operation: "workspaces.update",
        input: { settings: { strategy: { goals: "Ten demos a month" } } },
        evidence: [{ label: "owner call", value: "2026-09-18" }],
        expected_outcome: "Writers aim every email at a demo",
      },
      { reason: "The owner set clear goals" },
    );
    expect(proposed).toMatchObject({
      status: "applied",
      operation: "workspaces.update",
      target_type: "workspace",
      target_id: workspace,
      change_id: expect.stringMatching(/^chg_/),
      review_after_days: 14,
      proposed_by: { type: "human" },
      evidence: [{ label: "owner call", value: "2026-09-18" }],
    });
    expect(new Date(proposed.review_at).getTime() - new Date(proposed.applied_at).getTime()).toBe(
      14 * DAY,
    );
    const change = (await engine.call(
      "changes.get",
      { change_id: proposed.change_id },
      { workspace },
    )) as Any;
    expect(change).toMatchObject({
      proposal_id: proposed.id,
      area: "settings",
      reason: `Proposal ${proposed.id}: The owner set clear goals`,
      diff: [{ path: "strategy.goals", after: "Ten demos a month" }],
    });
    // The operation ran through the gate: it has its own audit line.
    const audit = await engine.db
      .select()
      .from(audit_events)
      .where(
        and(
          eq(audit_events.workspace_id, workspace),
          eq(audit_events.operation, "workspaces.update"),
        ),
      );
    expect(audit.map((row) => [row.status, row.reason])).toEqual([
      ["ok", `Proposal ${proposed.id}: The owner set clear goals`],
    ]);
    const page = (await engine.call("strategy.get", {}, { workspace })) as Any;
    expect(page.strategy.goals).toBe("Ten demos a month");
  });

  it("refuses operations outside the allowlist, invalid input, credentials and no reason", async () => {
    const offer = await newOffer("Checked offer");
    const outside = await errorOf(
      propose({ title: "Import", operation: "leads.import", input: { rows: [] } }),
    );
    expect(outside.code).toBe("validation_failed");
    expect(outside.message).toContain("leads.import cannot be proposed");
    expect(outside.details?.allowed).toContain("offers.update");
    expect(outside.details?.allowed).toContain("workspaces.update");

    const invalid = await errorOf(
      propose({
        title: "Bad",
        operation: "offers.update",
        input: { offer_id: offer.id, summary: 5 },
      }),
    );
    expect(invalid.code).toBe("validation_failed");
    expect(invalid.message).toContain("The input for offers.update is not valid");

    const reserved = await errorOf(
      propose({
        title: "Reserved",
        operation: "offers.update",
        input: { offer_id: offer.id, summary: "x", dry_run: false },
      }),
    );
    expect(reserved.message).toContain("dry_run");

    const credential = await errorOf(
      propose({
        title: "Password",
        operation: "mailboxes.update",
        input: { mailbox_id: "mbx_01k6a3v0q8x3m2n4p5r6s7t8v9", password: "example-pass" },
      }),
    );
    expect(credential.message).toContain("credentials (password)");

    const noReason = await errorOf(
      engine.call(
        "changes.propose",
        { title: "No reason", operation: "offers.update", input: { offer_id: offer.id } },
        { workspace },
      ),
    );
    expect(noReason.message).toBe("A proposal needs a reason.");

    const listed = (await engine.call("proposals.list", {}, { workspace })) as Any;
    expect(listed.items.map((item: Any) => item.title)).not.toContain("Bad");
  });

  it("previews the route on a dry run without storing anything", async () => {
    const offer = await newOffer("Preview offer");
    const preview = await propose(
      { title: "Preview", operation: "offers.update", input: { offer_id: offer.id, summary: "x" } },
      { principal: agent, dryRun: true },
    );
    expect(preview).toMatchObject({
      dry_run: true,
      preview: { operation: "offers.update", target_id: offer.id, route: "needs_approval" },
    });
    const listed = (await engine.call("proposals.list", {}, { workspace })) as Any;
    expect(listed.items.map((item: Any) => item.title)).not.toContain("Preview");
  });

  it("stores the error when the operation fails", async () => {
    const failed = await propose({
      title: "Missing offer",
      operation: "offers.update",
      input: { offer_id: MISSING_OFFER, summary: "A pilot." },
    });
    expect(failed).toMatchObject({ status: "failed", change_id: null, applied_at: null });
    expect(failed.error).toMatch(/^not_found: Offer off_\w+ not found\./);
    expect(failed.message).toContain("The change failed");
  });
});

describe("agent proposals and approvals", () => {
  it("waits for approval, then applies as the agent", async () => {
    const offer = await newOffer("Forecast Pilot");
    const proposed = await propose(
      {
        title: "Sharper summary",
        operation: "offers.update",
        input: { offer_id: offer.id, summary: "A 30 day pilot on your own data." },
        expected_outcome: "Fewer questions, more meetings",
      },
      { principal: agent },
    );
    expect(proposed).toMatchObject({
      status: "awaiting_approval",
      approval_id: expect.stringMatching(/^apr_/),
      change_id: null,
      proposed_by: { type: "agent", name: "Growth agent" },
    });
    expect(await offerSummary(offer.id)).toBe("A pilot.");

    const decided = (await engine.call(
      "approvals.decide",
      { approval_id: proposed.approval_id, decision: "approve" },
      { workspace },
    )) as Any;
    expect(decided.results[0]).toMatchObject({
      ok: true,
      status: "approved",
      data: { status: "applied" },
    });
    expect(await offerSummary(offer.id)).toBe("A 30 day pilot on your own data.");
    const proposal = (await engine.call(
      "proposals.get",
      { proposal_id: proposed.id },
      { workspace },
    )) as Any;
    expect(proposal).toMatchObject({
      status: "applied",
      decided_by: { type: "human" },
      change_id: expect.stringMatching(/^chg_/),
    });
    const change = (await engine.call(
      "changes.get",
      { change_id: proposal.change_id },
      { workspace },
    )) as Any;
    expect(change).toMatchObject({
      proposal_id: proposed.id,
      actor: { type: "agent", name: "Growth agent" },
      via: "mcp",
      diff: [{ path: "summary", before: "A pilot.", after: "A 30 day pilot on your own data." }],
    });

    // Undoing the change marks the proposal reverted.
    await engine.call("changes.undo", { change_id: proposal.change_id }, { workspace });
    const reverted = (await engine.call(
      "proposals.get",
      { proposal_id: proposed.id },
      { workspace },
    )) as Any;
    expect(reverted.status).toBe("reverted");
    expect(await offerSummary(offer.id)).toBe("A pilot.");
  });

  it("asks once: an approved change does not wait again at the operation's own gate", async () => {
    const offer = await newOffer("Review pilot");
    const created = (await engine.call(
      "campaigns.create",
      {
        name: "Dental groups, Q4",
        template: "signal_based_email_4",
        offer_id: offer.id,
        settings: { review_level: "every" },
      },
      { workspace },
    )) as Any;
    const campaignId = String(created.id ?? created.campaign?.id);
    const proposed = await propose(
      {
        title: "Review only unsure messages",
        operation: "campaigns.update",
        input: { campaign_id: campaignId, settings: { review_level: "unsure" } },
      },
      { principal: agent },
    );
    expect(proposed).toMatchObject({ status: "awaiting_approval" });

    const decided = (await engine.call(
      "approvals.decide",
      { approval_id: proposed.approval_id, decision: "approve" },
      { workspace },
    )) as Any;
    expect(decided.results[0]).toMatchObject({ ok: true, data: { status: "applied" } });
    const campaign = (await engine.call(
      "campaigns.get",
      { campaign_id: campaignId },
      { workspace },
    )) as Any;
    expect(campaign.settings.review_level).toBe("unsure");
    const pending = (await engine.call(
      "approvals.list",
      { status: "pending" },
      { workspace },
    )) as Any;
    expect(pending.items.filter((item: Any) => item.kind === "review_level")).toEqual([]);
    const proposal = (await engine.call(
      "proposals.get",
      { proposal_id: proposed.id },
      { workspace },
    )) as Any;
    const change = (await engine.call(
      "changes.get",
      { change_id: proposal.change_id },
      { workspace },
    )) as Any;
    expect(change.actor).toMatchObject({ type: "agent", name: "Growth agent" });
  });

  it("asks once for settings too: a person's approval lets a proposal loosen a gate", async () => {
    const other = (await engine.call("workspaces.create", { name: "Gate Client" })) as Any;
    const opts = { workspace: other.id };
    const adminAgent = engine.principal({
      type: "agent",
      id: "key_admin_growth",
      name: "Admin agent",
      scopes: ["read", "write", "admin"],
      via: "mcp",
    });
    const loosen = {
      title: "Launch without asking",
      operation: "workspaces.update",
      input: { settings: { approvals: { agent_launch_requires_approval: false } } },
    };
    const launchApproval = async () =>
      ((await engine.call("workspaces.get", {}, { ...opts, responseFormat: "detailed" })) as Any)
        .settings.approvals.agent_launch_requires_approval;

    const proposed = await propose(loosen, { ...opts, principal: adminAgent });
    expect(proposed).toMatchObject({ status: "awaiting_approval" });
    const decided = (await engine.call(
      "approvals.decide",
      { approval_id: proposed.approval_id, decision: "approve" },
      opts,
    )) as Any;
    expect(decided.results[0]).toMatchObject({ ok: true, data: { status: "applied" } });
    expect(await launchApproval()).toBe(false);

    // A proposal that applies on its own (agent_changes auto) had no person decide it.
    await engine.call(
      "workspaces.update",
      { settings: { approvals: { agent_launch_requires_approval: true, agent_changes: "auto" } } },
      opts,
    );
    const auto = await propose(loosen, { ...opts, principal: adminAgent });
    expect(auto).toMatchObject({ status: "failed", change_id: null });
    expect(auto.error).toMatch(/^forbidden: /);
    expect(await launchApproval()).toBe(true);
  });

  it("applies the edited input, and keeps a bad edit pending", async () => {
    const offer = await newOffer("Edited offer");
    const proposed = await propose(
      {
        title: "New summary",
        operation: "offers.update",
        input: { offer_id: offer.id, summary: "Draft wording" },
      },
      { principal: agent },
    );
    const bad = (await engine.call(
      "approvals.decide",
      {
        approval_id: proposed.approval_id,
        decision: "edit",
        edits: { input: { offer_id: offer.id, summary: 7 } },
      },
      { workspace },
    )) as Any;
    expect(bad.results[0]).toMatchObject({ ok: false, status: "pending" });
    expect(bad.results[0].error.code).toBe("validation_failed");

    await engine.call(
      "approvals.decide",
      {
        approval_id: proposed.approval_id,
        decision: "edit",
        edits: { input: { offer_id: offer.id, summary: "Owner wording" } },
      },
      { workspace },
    );
    expect(await offerSummary(offer.id)).toBe("Owner wording");
    const proposal = (await engine.call(
      "proposals.get",
      { proposal_id: proposed.id },
      { workspace },
    )) as Any;
    expect(proposal).toMatchObject({
      status: "applied",
      input: { offer_id: offer.id, summary: "Owner wording" },
    });
  });

  it("points an edited proposal at the target of the input that was applied", async () => {
    const campaign = (name: string) =>
      engine.call("campaigns.create", { name, steps: [{ type: "email" }] }, { workspace });
    const first = (await campaign("Dental groups A")) as Any;
    const second = (await campaign("Dental groups B")) as Any;
    const proposed = await propose(
      {
        title: "Review every message",
        operation: "campaigns.update",
        input: { campaign_id: first.id, settings: { review_level: "every" } },
      },
      { principal: agent },
    );
    expect(proposed).toMatchObject({ target_type: "campaign", target_id: first.id });
    await engine.call(
      "approvals.decide",
      {
        approval_id: proposed.approval_id,
        decision: "edit",
        edits: { input: { campaign_id: second.id, settings: { review_level: "every" } } },
      },
      { workspace },
    );
    const proposal = (await engine.call(
      "proposals.get",
      { proposal_id: proposed.id },
      { workspace },
    )) as Any;
    expect(proposal).toMatchObject({
      status: "applied",
      target_type: "campaign",
      target_id: second.id,
    });
    const change = (await engine.call(
      "changes.get",
      { change_id: proposal.change_id },
      { workspace },
    )) as Any;
    expect(change.target_id).toBe(second.id);
  });

  it("rejects without changing anything", async () => {
    const offer = await newOffer("Rejected offer");
    const proposed = await propose(
      {
        title: "Worse summary",
        operation: "offers.update",
        input: { offer_id: offer.id, summary: "Buy now" },
      },
      { principal: agent },
    );
    await engine.call(
      "approvals.decide",
      { approval_id: proposed.approval_id, decision: "reject" },
      { workspace },
    );
    expect(await offerSummary(offer.id)).toBe("A pilot.");
    const proposal = (await engine.call(
      "proposals.get",
      { proposal_id: proposed.id },
      { workspace },
    )) as Any;
    expect(proposal).toMatchObject({
      status: "rejected",
      change_id: null,
      decided_by: { type: "human" },
    });
  });

  it("applies at once with the auto setting, unless the agent lacks the scopes", async () => {
    const other = (await engine.call("workspaces.create", { name: "Auto Client" })) as Any;
    const opts = { workspace: other.id };
    await engine.call(
      "workspaces.update",
      { settings: { approvals: { agent_changes: "auto" } } },
      opts,
    );
    const offer = (await engine.call(
      "offers.create",
      { name: "Auto offer", summary: "A pilot." },
      opts,
    )) as Any;
    const applied = await propose(
      { title: "Auto", operation: "offers.update", input: { offer_id: offer.id, summary: "Now" } },
      { ...opts, principal: agent },
    );
    expect(applied).toMatchObject({ status: "applied", approval_id: null });

    // workspaces.update needs admin: the agent's proposal waits even with auto.
    const settings = await propose(
      {
        title: "Handoff",
        operation: "workspaces.update",
        input: { settings: { booking: { mode: "handoff" } } },
      },
      { ...opts, principal: agent },
    );
    expect(settings.status).toBe("awaiting_approval");
    expect(settings.message).toContain("lacks admin");

    // The decider lends the authority, so they need admin too.
    const refused = (await engine.call(
      "approvals.decide",
      { approval_id: settings.approval_id, decision: "approve" },
      { ...opts, scopes: ["read", "write", "approve"] },
    )) as Any;
    expect(refused.results[0]).toMatchObject({ ok: false, status: "pending" });
    expect(refused.results[0].error.code).toBe("forbidden");

    await engine.call(
      "approvals.decide",
      { approval_id: settings.approval_id, decision: "approve" },
      opts,
    );
    const page = (await engine.call("strategy.get", {}, opts)) as Any;
    expect(page.booking.mode).toBe("handoff");
    expect(page.recent_changes[0]).toMatchObject({
      area: "settings",
      actor: { type: "agent", name: "Growth agent" },
    });
  });
});

describe("isolation", () => {
  it("keeps proposals and changes inside their workspace", async () => {
    const proposed = await propose({
      title: "Private",
      operation: "workspaces.update",
      input: { settings: { strategy: { agent_notes: "Only here" } } },
    });
    const other = (await engine.call("workspaces.create", { name: "Other Client" })) as Any;
    const opts = { workspace: other.id };
    const missing = await errorOf(engine.call("proposals.get", { proposal_id: proposed.id }, opts));
    expect(missing.code).toBe("not_found");
    const missingChange = await errorOf(
      engine.call("changes.get", { change_id: proposed.change_id }, opts),
    );
    expect(missingChange.code).toBe("not_found");
    const undo = await errorOf(
      engine.call("changes.undo", { change_id: proposed.change_id }, opts),
    );
    expect(undo.code).toBe("not_found");
    expect(((await engine.call("proposals.list", {}, opts)) as Any).items).toEqual([]);
    expect(((await engine.call("changes.list", {}, opts)) as Any).items).toEqual([]);
    const own = (await engine.call("changes.list", { area: "settings" }, { workspace })) as Any;
    expect(own.items.map((item: Any) => item.change_id)).toContain(proposed.change_id);
  });
});

describe("operations a module does not register", () => {
  it("refuses an allowlisted operation that is not available, naming the ones that are", async () => {
    const small = await createTestEngine({ modules: [workspaces, system, strategy] });
    try {
      const created = (await small.call("workspaces.create", { name: "Small Client" })) as Any;
      const error = await errorOf(
        small.call(
          "changes.propose",
          {
            title: "Pick a winner",
            operation: "offers.update",
            input: { offer_id: MISSING_OFFER, summary: "x" },
          },
          { workspace: created.id, reason: "Variant B leads" },
        ),
      );
      expect(error.code).toBe("validation_failed");
      expect(error.message).toBe(
        "offers.update is not available in this engine, so it cannot be proposed.",
      );
      expect(error.details?.allowed).toEqual(["workspaces.update"]);
    } finally {
      await small.close();
    }
  });
});
