/**
 * Lowering a campaign's review level is an approval gate (spec 2, rule 4), through the real
 * engine: anyone who must ask gets awaiting_approval while the rest of the update applies,
 * raising never asks, and a person decides.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_SCOPES } from "../../core/context.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { lowersReviewLevel } from "./review-level.js";

interface Detail {
  id: string;
  name: string;
  review_level: string;
  settings: Record<string, unknown>;
}

interface Decided {
  results: Array<Record<string, unknown>>;
}

let engine: TestEngine;
let workspace: string;

beforeAll(async () => {
  engine = await createTestEngine();
  const created = (await engine.call("workspaces.create", { name: "Review Gate Co" })) as {
    slug: string;
  };
  workspace = created.slug;
});
afterAll(() => engine.close());

const agent = () =>
  engine.principal({
    type: "agent",
    id: "key_review_agent",
    name: "Review agent",
    // Even an agent holding approve asks, and cannot decide its own request.
    scopes: [...ALL_SCOPES],
  });

async function newCampaign(level: string): Promise<Detail> {
  return (await engine.call(
    "campaigns.create",
    {
      name: `Dental groups ${level}`,
      template: "signal_based_email_4",
      settings: { review_level: level },
    },
    { workspace },
  )) as Detail;
}

const get = async (id: string) =>
  (await engine.call("campaigns.get", { campaign_id: id }, { workspace })) as Detail;

describe("campaign review level gate", () => {
  it("orders the levels: every, then first, then unsure", () => {
    expect(lowersReviewLevel("every", "first")).toBe(true);
    expect(lowersReviewLevel("first", "unsure")).toBe(true);
    expect(lowersReviewLevel("unsure", "every")).toBe(false);
    expect(lowersReviewLevel("first", "first")).toBe(false);
  });

  it("holds a lower level for an agent while the rest of the update applies", async () => {
    const campaign = await newCampaign("every");
    const held = (await engine.call(
      "campaigns.update",
      {
        campaign_id: campaign.id,
        name: "Dental groups, Q4",
        settings: { review_level: "unsure", daily_new_leads: 12 },
      },
      { workspace, principal: agent() },
    )) as { status: string; approval_id: string; summary: string };
    expect(held).toMatchObject({ status: "awaiting_approval" });
    expect(held.summary).toContain("every to unsure");
    expect(await get(campaign.id)).toMatchObject({
      name: "Dental groups, Q4",
      review_level: "every",
      settings: { daily_new_leads: 12 },
    });

    // The agent cannot decide its own request; a person can.
    const own = (await engine.call(
      "approvals.decide",
      { approval_id: held.approval_id, decision: "approve" },
      { workspace, principal: agent() },
    )) as Decided;
    expect(own.results[0]).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const decided = (await engine.call(
      "approvals.decide",
      { approval_id: held.approval_id, decision: "approve" },
      { workspace },
    )) as Decided;
    expect(decided.results[0]).toMatchObject({ ok: true, status: "approved" });
    expect((await get(campaign.id)).review_level).toBe("unsure");
  });

  it("never asks to raise the level, and lets a person holding approve lower it", async () => {
    const campaign = await newCampaign("unsure");
    const raised = (await engine.call(
      "campaigns.update",
      { campaign_id: campaign.id, settings: { review_level: "every" } },
      { workspace, principal: agent() },
    )) as Detail;
    expect(raised.review_level).toBe("every");

    const lowered = (await engine.call(
      "campaigns.update",
      { campaign_id: campaign.id, settings: { review_level: "first" } },
      { workspace },
    )) as Detail;
    expect(lowered.review_level).toBe("first");

    // A person without approve asks like anyone else.
    const helper = engine.principal({ id: "key_helper", scopes: ["read", "write"] });
    const asked = (await engine.call(
      "campaigns.update",
      { campaign_id: campaign.id, settings: { review_level: "unsure" } },
      { workspace, principal: helper },
    )) as { status: string; approval_id: string };
    expect(asked.status).toBe("awaiting_approval");
    const rejected = (await engine.call(
      "approvals.decide",
      { approval_id: asked.approval_id, decision: "reject" },
      { workspace },
    )) as Decided;
    expect(rejected.results[0]).toMatchObject({ ok: true, status: "rejected" });
    expect((await get(campaign.id)).review_level).toBe("first");
  });
});
