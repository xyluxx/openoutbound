/**
 * Proposal rules without the engine: who applies at once, where a proposal points, following
 * an operation's own approval, and paging.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../core/context.js";
import type { EmittedEvent } from "../../core/events.js";
import { change_proposals } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { updateOfferOp } from "../knowledge/operations/offers.js";
import { updateWorkspace } from "../workspaces/operations.js";
import { followOperationApproval, inferTarget, listProposals, proposalRoute } from "./proposals.js";

const DAY = 24 * 60 * 60 * 1000;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const principal = (type: Principal["type"], scopes: Principal["scopes"]): Principal => ({
  type,
  id: `${type}_1`,
  name: type,
  scopes,
  workspaceId: null,
  via: "mcp",
});

describe("proposalRoute", () => {
  it("applies at once only for a person holding approve, unless the setting is auto", () => {
    const write: Principal["scopes"] = ["read", "write"];
    const owner: Principal["scopes"] = ["read", "write", "approve"];
    expect(proposalRoute(principal("human", owner), updateOfferOp, "approve").route).toBe(
      "apply_now",
    );
    // Everyone else asks: people without approve, agents (even holding approve), services and
    // the engine itself (the one approval rule).
    for (const [type, scopes] of [
      ["human", write],
      ["agent", owner],
      ["service", write],
      ["system", write],
    ] as const) {
      expect(proposalRoute(principal(type, [...scopes]), updateOfferOp, "approve").route).toBe(
        "needs_approval",
      );
    }
    // auto switches the gate off for everyone.
    expect(proposalRoute(principal("agent", write), updateOfferOp, "auto").route).toBe("apply_now");
    expect(proposalRoute(principal("human", write), updateOfferOp, "auto").route).toBe("apply_now");
  });

  it("always asks when the caller lacks the operation's scopes", () => {
    const result = proposalRoute(principal("human", ["read", "write"]), updateWorkspace, "auto");
    expect(result).toEqual({ route: "needs_approval", missingScopes: ["admin"] });
  });
});

describe("inferTarget", () => {
  it("points at the record the operation changes", () => {
    expect(inferTarget("workspaces.update", {}, "ws_1")).toEqual({ type: "workspace", id: "ws_1" });
    expect(inferTarget("campaigns.pick_winner", { campaign_id: "cmp_1" }, "ws_1")).toEqual({
      type: "campaign",
      id: "cmp_1",
    });
    expect(inferTarget("signals.definitions.update", { key: "funding_round" }, "ws_1")).toEqual({
      type: "signal_definition",
      id: "funding_round",
    });
    expect(inferTarget("offers.create", { name: "Pilot" }, "ws_1")).toBeNull();
  });
});

async function waitingProposal(ctx: TestContext, approvalId: string) {
  const [row] = await ctx.db
    .insert(change_proposals)
    .values({
      workspace_id: ctx.workspace.id,
      title: "Raise the daily limit",
      reason: "The mailbox is warm",
      operation: "mailboxes.update",
      input: { mailbox_id: "mbx_01k6a3v0q8x3m2n4p5r6s7t8v9", daily_limit: 60 },
      status: "awaiting_approval",
      approval_id: approvalId,
    })
    .returning();
  if (!row) throw new Error("no proposal");
  return row;
}

function decided(
  ctx: TestContext,
  approvalId: string,
  status: "approved" | "rejected",
  kind: "mailbox_limits" | "change" = "mailbox_limits",
): EmittedEvent<"approval.decided"> {
  return {
    id: "evt_1",
    type: "approval.decided",
    workspaceId: ctx.workspace.id,
    subject: { type: "approval", id: approvalId },
    data: {
      approval_id: approvalId,
      kind,
      decision: status === "approved" ? "approve" : "reject",
      status,
    },
    occurredAt: ctx.clock.now(),
  };
}

describe("following an operation's own approval", () => {
  it("marks the proposal applied or rejected, and ignores change approvals", async () => {
    const ctx = await createTestContext({ db });
    const approved = await waitingProposal(ctx, "apr_01k6a3v0q8x3m2n4p5r6s7t8v1");
    const rejected = await waitingProposal(ctx, "apr_01k6a3v0q8x3m2n4p5r6s7t8v2");
    const own = await waitingProposal(ctx, "apr_01k6a3v0q8x3m2n4p5r6s7t8v3");
    const job = ctx.jobContext();
    await followOperationApproval.handler(
      job,
      decided(ctx, approved.approval_id ?? "", "approved"),
    );
    await followOperationApproval.handler(
      job,
      decided(ctx, rejected.approval_id ?? "", "rejected"),
    );
    await followOperationApproval.handler(
      job,
      decided(ctx, own.approval_id ?? "", "approved", "change"),
    );
    const read = async (id: string) =>
      (await ctx.db.select().from(change_proposals).where(eq(change_proposals.id, id)))[0];
    const now = ctx.clock.now().getTime();
    const applied = await read(approved.id);
    expect(applied?.status).toBe("applied");
    expect(applied?.applied_at?.getTime()).toBe(now);
    expect(applied?.review_at?.getTime()).toBe(now + 14 * DAY);
    expect((await read(rejected.id))?.status).toBe("rejected");
    expect((await read(own.id))?.status).toBe("awaiting_approval");
  });
});

describe("listProposals", () => {
  it("pages newest first and filters by status", async () => {
    const ctx = await createTestContext({ db });
    for (const title of ["First", "Second", "Third"]) {
      await ctx.db.insert(change_proposals).values({
        workspace_id: ctx.workspace.id,
        title,
        reason: "Test",
        operation: "offers.update",
        input: {},
        status: title === "Second" ? "rejected" : "applied",
      });
    }
    const first = await listProposals(ctx, { limit: 2 });
    expect(first.items.map((row) => row.title)).toEqual(["Third", "Second"]);
    expect(first.has_more).toBe(true);
    const second = await listProposals(ctx, { limit: 2, cursor: first.next_cursor ?? "" });
    expect(second.items.map((row) => row.title)).toEqual(["First"]);
    expect(second.has_more).toBe(false);
    const rejected = await listProposals(ctx, { limit: 25, status: ["rejected"] });
    expect(rejected.items.map((row) => row.title)).toEqual(["Second"]);
  });
});
