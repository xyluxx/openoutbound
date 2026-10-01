import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isOpenOutboundError, type OpenOutboundError } from "../../../core/errors.js";
import {
  campaign_steps,
  change_log,
  enrollments,
  messages,
  people,
} from "../../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { createTestDb, type TestDb } from "../../../testing/db.js";
import {
  seedCampaign,
  seedEnrollment,
  seedMessage,
  seedPerson,
} from "../../../testing/factories.js";
import { pickWinner } from "./pick-winner.js";

const VARIANTS = {
  type: "email",
  config: {
    style: "guided",
    subject: "quick idea",
    body: "Hi {{first_name}}, [[ai: one line about their clinic]]",
    instruction: "Keep it short.",
    variants: [
      { key: "A", subject: "a thought on {{company}}" },
      {
        key: "B",
        subject: "front desk overflow",
        body: "Hi {{first_name}}, we answer overflow calls. [[ai: why now]]",
        instruction: "Mention lunch hours.",
      },
    ],
  },
} as const;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function setup(status: "active" | "draft" = "active") {
  const ctx: TestContext = await createTestContext({ db });
  const seeded = await seedCampaign(ctx, {
    name: "Clinic owners",
    status,
    steps: [
      VARIANTS,
      { type: "wait", delay_days: 2 },
      { type: "email", config: { mode: "reply" } },
    ],
  });
  return { ctx, ...seeded };
}

async function run(ctx: TestContext, input: Record<string, unknown>) {
  const parsed = pickWinner.input.parse(input);
  return pickWinner.output.parse(await pickWinner.handler(ctx, parsed));
}

async function failure(promise: Promise<unknown>): Promise<OpenOutboundError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isOpenOutboundError(error)) throw new Error(`expected an OpenOutboundError, got ${error}`);
  return error;
}

describe("campaigns.pick_winner", () => {
  it("keeps the winner on a live campaign without moving anyone", async () => {
    const { ctx, campaign, steps } = await setup();
    const [first, wait, last] = steps;
    if (!first || !wait || !last) throw new Error("steps missing");
    const person = await seedPerson(ctx);
    const other = await seedPerson(ctx);
    const midway = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: person.id,
      current_step: 2,
    });
    const starting = await seedEnrollment(ctx, {
      campaign_id: campaign.id,
      person_id: other.id,
      current_step: 0,
    });
    await seedMessage(ctx, {
      campaign_id: campaign.id,
      step_id: first.id,
      person_id: other.id,
      variant: "A",
      status: "pending_review",
    });

    const result = await run(ctx, {
      campaign_id: campaign.id,
      step_id: first.id,
      variant_key: "B",
    });
    expect(result).toMatchObject({
      campaign_id: campaign.id,
      winner: "B",
      removed_variants: ["A"],
      pending_other_variants: 1,
      step: {
        id: first.id,
        position: 0,
        config: {
          style: "guided",
          subject: "front desk overflow",
          body: "Hi {{first_name}}, we answer overflow calls. [[ai: why now]]",
          instruction: "Mention lunch hours.",
        },
      },
    });
    expect("variants" in (result as { step: { config: object } }).step.config).toBe(false);

    const rows = await ctx.db
      .select()
      .from(campaign_steps)
      .where(eq(campaign_steps.campaign_id, campaign.id));
    expect(rows.map((row) => row.id).sort()).toEqual([first.id, wait.id, last.id].sort());
    const saved = rows.find((row) => row.id === first.id);
    expect(saved?.config).not.toHaveProperty("variants");
    expect(saved?.config).toMatchObject({ type: "email", subject: "front desk overflow" });
    const [kept] = await ctx.db.select().from(enrollments).where(eq(enrollments.id, midway.id));
    const [start] = await ctx.db.select().from(enrollments).where(eq(enrollments.id, starting.id));
    expect(kept?.current_step).toBe(2);
    expect(start?.current_step).toBe(0);
  });

  it("records the change in the change log under campaigns.pick_winner", async () => {
    const { ctx, campaign, steps } = await setup();
    const [first] = steps;
    if (!first) throw new Error("step missing");
    await run(ctx, { campaign_id: campaign.id, step_id: first.id, variant_key: "A" });
    const rows = await ctx.db
      .select()
      .from(change_log)
      .where(eq(change_log.target_id, campaign.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ area: "campaign", operation: "campaigns.pick_winner" });
  });

  it("falls back to the step's own text for fields the winner does not set", async () => {
    const { ctx, campaign, steps } = await setup("draft");
    const result = (await run(ctx, {
      campaign_id: campaign.id,
      step_id: steps[0]?.id,
      variant_key: "A",
    })) as { step: { id: string; config: Record<string, unknown> } };
    expect(result.step.config).toMatchObject({
      subject: "a thought on {{company}}",
      body: "Hi {{first_name}}, [[ai: one line about their clinic]]",
      instruction: "Keep it short.",
    });
    // A draft nobody started gets fresh step ids from campaigns.update.
    const [row] = await ctx.db
      .select()
      .from(campaign_steps)
      .where(eq(campaign_steps.id, result.step.id));
    expect(row?.position).toBe(0);
  });

  it("previews with dry_run and changes nothing", async () => {
    const { ctx, campaign, steps } = await setup();
    const first = steps[0];
    const preview = await run(ctx.with({ request: { dryRun: true } }), {
      campaign_id: campaign.id,
      step_id: first?.id,
      variant_key: "B",
    });
    expect(preview).toMatchObject({
      dry_run: true,
      preview: { winner: "B", removed_variants: ["A"], step: { id: first?.id } },
    });
    const [row] = await ctx.db
      .select()
      .from(campaign_steps)
      .where(eq(campaign_steps.id, first?.id ?? ""));
    expect(row?.config).toHaveProperty("variants");
  });

  it("warns, in the answer and in the dry run, when the test has not enough data yet", async () => {
    const { ctx, campaign, steps } = await setup();
    const input = { campaign_id: campaign.id, step_id: steps[0]?.id, variant_key: "B" };
    const preview = await run(ctx.with({ request: { dryRun: true } }), input);
    const expected = expect.stringContaining(
      "does not have enough data yet: every variant needs 50 sends and the fewest so far is 0",
    );
    expect(preview).toMatchObject({ dry_run: true, warnings: [expected] });
    const result = await run(ctx, input);
    expect(result).toMatchObject({ winner: "B", warnings: [expected] });
  });

  it("warns when the kept variant is not the report's leader, and keeps it anyway", async () => {
    const { ctx, campaign, steps } = await setup();
    const step = steps[0];
    if (!step) throw new Error("step missing");
    const now = ctx.clock.now().getTime();
    const sentAt = new Date(now - 48 * 3_600_000);
    const repliedAt = new Date(now - 24 * 3_600_000);
    const leads = await ctx.db
      .insert(people)
      .values(
        Array.from({ length: 120 }, (_, n) => ({
          workspace_id: ctx.workspace.id,
          first_name: "Lead",
          full_name: `Lead ${n}`,
          email: `lead.${n}@example.com`,
        })),
      )
      .returning({ id: people.id });
    const base = {
      workspace_id: ctx.workspace.id,
      channel: "email" as const,
      campaign_id: campaign.id,
    };
    await ctx.db.insert(messages).values(
      leads.map((person, n) => ({
        ...base,
        action: "email" as const,
        direction: "outbound" as const,
        status: "sent" as const,
        step_id: step.id,
        variant: n < 60 ? "A" : "B",
        person_id: person.id,
        sent_at: sentAt,
        subject: "quick idea",
        body_text: "Hi there, one idea for the front desk.",
      })),
    );
    // A: 12 of 60 interested; B: 1 of 60.
    const interested = [...leads.slice(0, 12), ...leads.slice(60, 61)];
    await ctx.db.insert(messages).values(
      interested.map((person) => ({
        ...base,
        action: "reply" as const,
        direction: "inbound" as const,
        status: "received" as const,
        person_id: person.id,
        received_at: repliedAt,
        subject: "Re: quick idea",
        body_text: "Sounds good, tell me more.",
        classification: { category: "interested" as const, confidence: 0.9 },
      })),
    );

    const leader = await run(ctx.with({ request: { dryRun: true } }), {
      campaign_id: campaign.id,
      step_id: step.id,
      variant_key: "A",
    });
    expect(leader).toMatchObject({ dry_run: true, warnings: [] });
    const result = await run(ctx, { campaign_id: campaign.id, step_id: step.id, variant_key: "B" });
    expect(result).toMatchObject({
      winner: "B",
      warnings: [
        expect.stringMatching(
          /^The campaign report ranks variant "A" first on positive_reply_rate \(confidence 1\), not "B"/,
        ),
      ],
    });
    const [saved] = await ctx.db
      .select()
      .from(campaign_steps)
      .where(eq(campaign_steps.id, step.id));
    expect(saved?.config).toMatchObject({ subject: "front desk overflow" });
  });

  it("rejects an unknown variant key, a step without variants and a foreign step", async () => {
    const { ctx, campaign, steps } = await setup();
    const bad = await failure(
      run(ctx, { campaign_id: campaign.id, step_id: steps[0]?.id, variant_key: "C" }),
    );
    expect(bad.code).toBe("validation_failed");
    expect(bad.hint).toBe("Use one of: A, B.");

    const plain = await failure(
      run(ctx, { campaign_id: campaign.id, step_id: steps[2]?.id, variant_key: "A" }),
    );
    expect(plain.message).toContain("has no variants");

    const missing = await failure(
      run(ctx, { campaign_id: campaign.id, step_id: "stp_unknown", variant_key: "A" }),
    );
    expect(missing.code).toBe("not_found");
  });
});
