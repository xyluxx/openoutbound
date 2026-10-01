/** A new suppression stops the campaigns of everyone it covers, however many that is. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enrollments, people } from "../../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { truncateAll } from "../../../testing/db.js";
import { seedCampaign, seedPerson, seedWorkspace } from "../../../testing/factories.js";
import { addSuppressionOp, COVERED_BATCH } from "./suppressions.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  ctx = ctx.with({ workspace: await seedWorkspace(ctx.db, { settings: {} }) });
});

describe("suppressions.add", () => {
  it("stops campaigns for every person a domain covers, past the first 200", async () => {
    const { campaign } = await seedCampaign(ctx);
    const rows = await ctx.db
      .insert(people)
      .values(
        Array.from({ length: 205 }, (_, i) => ({
          workspace_id: ctx.workspace.id,
          full_name: `Person ${i}`,
          email: `person${i}@rival.example.com`,
          source: "test",
        })),
      )
      .returning({ id: people.id });
    await ctx.db.insert(enrollments).values(
      rows.map((row) => ({
        workspace_id: ctx.workspace.id,
        campaign_id: campaign.id,
        person_id: row.id,
        status: "active" as const,
      })),
    );
    await seedPerson(ctx, { email: "not-enrolled@rival.example.com" });
    const other = await seedPerson(ctx, { email: "dana@other.example.com" });
    await ctx.db.insert(enrollments).values({
      workspace_id: ctx.workspace.id,
      campaign_id: campaign.id,
      person_id: other.id,
      status: "active",
    });

    const saved = COVERED_BATCH.size;
    COVERED_BATCH.size = 50;
    try {
      const input = addSuppressionOp.input.parse({
        type: "domain",
        value: "rival.example.com",
        suppression_reason: "competitor",
      });
      const added = addSuppressionOp.output.parse(await addSuppressionOp.handler(ctx, input));
      expect(added).toMatchObject({ created: true, people_covered: 206, enrollments_stopped: 205 });
    } finally {
      COVERED_BATCH.size = saved;
    }
    const statuses = await ctx.db
      .select({ person_id: enrollments.person_id, status: enrollments.status })
      .from(enrollments)
      .where(eq(enrollments.campaign_id, campaign.id));
    expect(statuses.filter((row) => row.status === "stopped")).toHaveLength(205);
    expect(statuses.find((row) => row.person_id === other.id)?.status).toBe("active");
  });
});
