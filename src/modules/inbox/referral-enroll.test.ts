/**
 * Approved referrals enroll through the real campaigns `enrollPeople` binding, so every
 * enrollment check applies (verified email, one campaign at a time, rest period, company cap).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actorRef } from "../../core/context.js";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import { approvals, enrollments, people } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  seedCampaign,
  seedCompany,
  seedEnrollment,
  seedPerson,
  seedThread,
} from "../../testing/factories.js";
import { REFERRAL_APPROVAL_TYPE, referralResolver } from "./referral.js";

vi.mock("../../runtime/notify.js", () => ({ notify: vi.fn(async () => {}) }));

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

async function scenario(settings: WorkspaceSettingsInput = {}) {
  const ctx = await createTestContext({ db: testDb, settings });
  const company = await seedCompany(ctx, { country: "US" });
  const referrer = await seedPerson(ctx, { company_id: company.id, country: "US" });
  const { campaign } = await seedCampaign(ctx, { status: "active" });
  const thread = await seedThread(ctx, { person_id: referrer.id, campaign_id: campaign.id });
  const email = `sam.lee.${thread.id.slice(-6).toLowerCase()}@${company.domain}`;
  const [approval] = await ctx.db
    .insert(approvals)
    .values({
      workspace_id: ctx.workspace.id,
      kind: "referral",
      title: "Add referral Sam Lee",
      payload: {
        type: REFERRAL_APPROVAL_TYPE,
        referrer_person_id: referrer.id,
        thread_id: thread.id,
        message_id: "msg_01k6a3v0q8x3m2n4p5r6s7t8v9",
        campaign_id: campaign.id,
        referral: { name: "Sam Lee", email, title: "Head of Purchasing" },
      },
    })
    .returning();
  if (!approval) throw new Error("approval missing");
  return { ctx, company, campaign, email, approval };
}

function approve(ctx: TestContext, approval: Parameters<typeof referralResolver.apply>[1]) {
  return referralResolver.apply(ctx, approval, {
    decision: "approve",
    decidedBy: actorRef(ctx.principal),
  });
}

async function referred(ctx: TestContext, email: string) {
  const [row] = await ctx.db.select().from(people).where(eq(people.email, email));
  if (!row) throw new Error("referred person missing");
  return row;
}

describe("referral enrollment through campaigns", () => {
  it("queues the referred person with the decider as enroller when every check passes", async () => {
    const s = await scenario({ sending: { require_verified_email: false } });
    const applied = await approve(s.ctx, s.approval);
    expect(applied.message).toContain("queued them");
    const person = await referred(s.ctx, s.email);
    const [row] = await s.ctx.db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.campaign_id, s.campaign.id), eq(enrollments.person_id, person.id)));
    expect(row).toMatchObject({ status: "queued", enrolled_by: { id: "usr_test" } });
    expect(applied.data).toMatchObject({ enrollment_id: row?.id });

    // Approving again finds the person and reports the existing enrollment.
    const again = await approve(s.ctx, s.approval);
    expect(again.message).toContain("already enrolled");
  });

  it("skips an unverified address under the default sending rules", async () => {
    const s = await scenario();
    const applied = await approve(s.ctx, s.approval);
    expect(applied.message).toContain("not enrolled");
    expect(applied.message).toContain("not_contactable:unverified_email");
    const person = await referred(s.ctx, s.email);
    expect(
      await s.ctx.db.select().from(enrollments).where(eq(enrollments.person_id, person.id)),
    ).toHaveLength(0);
  });

  it("skips a person who is already in another active campaign", async () => {
    const s = await scenario({ sending: { require_verified_email: false } });
    const existing = await seedPerson(s.ctx, {
      company_id: s.company.id,
      email: s.email,
      country: "US",
    });
    const { campaign: other } = await seedCampaign(s.ctx, { status: "active" });
    await seedEnrollment(s.ctx, { campaign_id: other.id, person_id: existing.id });
    const applied = await approve(s.ctx, s.approval);
    expect(applied.message).toMatch(/^Found Sam Lee; not enrolled/);
    expect(applied.data).toMatchObject({ reasons: ["active_in_other_campaign"] });
  });
});
