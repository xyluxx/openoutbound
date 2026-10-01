import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { stepConfigSchema } from "../core/settings.js";
import {
  campaign_steps,
  companies,
  icps,
  people,
  signals,
  threads,
  type Workspace,
  workspaces,
} from "../db/schema/index.js";
import { replyBlockers } from "../modules/inbox/send.js";
import { createIcp, scoreLeads } from "../modules/leads/operations/icps.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { sandboxStatus, seedAllSandboxWorkspaces, seedWorkspace } from "./seed.js";
import { SANDBOX_WORLD_KEYS, WORLD } from "./world/index.js";

describe("sandbox seeding", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx?.close();
  });

  it("creates both sandbox workspaces with real content", async () => {
    ctx = await createTestContext();
    const results = await seedAllSandboxWorkspaces(ctx, false);
    expect(results.map((r) => r.slug).sort()).toEqual(["brightsmile", "northwind"]);
    for (const result of results) {
      expect(result.created).toBe(true);
      expect(result.reset).toBe(false);
      expect(result.counts.companies).toBeGreaterThan(0);
      expect(result.counts.people).toBeGreaterThan(0);
      expect(result.counts.lists).toBeGreaterThan(0);
      expect(result.counts.list_members).toBeGreaterThan(0);
      expect(result.counts.icps).toBeGreaterThan(0);
      expect(result.counts.knowledge_items).toBeGreaterThan(0);
      expect(result.counts.offers).toBeGreaterThan(0);
      expect(result.counts.signals).toBeGreaterThan(0);
      expect(result.counts.campaigns).toBeGreaterThan(0);
      expect(result.counts.campaign_steps).toBeGreaterThan(0);
      expect(result.counts.mailboxes).toBeGreaterThan(0);
      expect(result.counts.linkedin_accounts).toBeGreaterThan(0);
      expect(result.counts.threads).toBeGreaterThan(0);
      expect(result.counts.messages).toBeGreaterThan(0);
      expect(result.counts.suppressions).toBeGreaterThan(0);
      expect(result.quick_start_prompts.length).toBe(3);
    }
  });

  it("is idempotent: seeding again without reset adds nothing new", async () => {
    ctx = await createTestContext();
    const first = await seedAllSandboxWorkspaces(ctx, false);
    const second = await seedAllSandboxWorkspaces(ctx, false);
    for (const result of second) {
      expect(result.created).toBe(false);
      expect(result.reset).toBe(false);
    }
    expect(second.map((r) => r.counts)).toEqual(first.map((r) => r.counts));
  });

  it("reset deletes and recreates a workspace with stable (deterministic) counts", async () => {
    ctx = await createTestContext();
    const first = await seedWorkspace(ctx, "northwind", false);
    const [beforeCompany] = await ctx.db
      .select()
      .from(companies)
      .where(eq(companies.workspace_id, first.workspace_id));
    expect(beforeCompany).toBeDefined();

    const reset = await seedWorkspace(ctx, "northwind", true);
    expect(reset.created).toBe(true);
    expect(reset.reset).toBe(true);
    expect(reset.counts).toEqual(first.counts);
    // A new workspace row (and new company rows) were created: ids differ from before the reset.
    expect(reset.workspace_id).not.toBe(first.workspace_id);
  });

  it("never touches a real workspace that holds a world's slug", async () => {
    ctx = await createTestContext();
    const [real] = await ctx.db
      .insert(workspaces)
      .values({ slug: "northwind", name: "Northwind Freight Co" })
      .returning();
    if (!real) throw new Error("no workspace");
    await ctx.db
      .insert(companies)
      .values({ workspace_id: real.id, name: "Client Account", domain: "client.example.com" });

    for (const reset of [false, true]) {
      await expect(seedAllSandboxWorkspaces(ctx, reset)).rejects.toMatchObject({
        code: "conflict",
        details: { field: "slug", slug: "northwind", world: "northwind" },
        hint: expect.stringContaining("--slug northwind-sandbox"),
      });
      await expect(seedWorkspace(ctx, "northwind", reset)).rejects.toMatchObject({
        code: "conflict",
      });
    }
    // Checked before anything changed: brightsmile was not seeded either.
    const rows = await ctx.db.select().from(workspaces);
    expect(rows.filter((row) => row.is_sandbox)).toEqual([]);
    const [still] = rows.filter((row) => row.id === real.id);
    expect(still).toMatchObject({ slug: "northwind", is_sandbox: false });
    expect(
      await ctx.db.select().from(companies).where(eq(companies.workspace_id, real.id)),
    ).toHaveLength(1);

    // The world seeds under another slug, and its reset deletes only that sandbox.
    const [seeded] = await seedAllSandboxWorkspaces(ctx, false, {
      world: "northwind",
      slug: "northwind-sandbox",
    });
    expect(seeded).toMatchObject({ slug: "northwind-sandbox", created: true });
    expect(seeded?.counts.companies).toBeGreaterThan(0);
    const [again] = await seedAllSandboxWorkspaces(ctx, true, {
      world: "northwind",
      slug: "northwind-sandbox",
    });
    expect(again).toMatchObject({ slug: "northwind-sandbox", reset: true });
    expect(again?.counts).toEqual(seeded?.counts);
    expect(
      await ctx.db.select().from(companies).where(eq(companies.workspace_id, real.id)),
    ).toHaveLength(1);
    // The world is found by name under the other slug.
    const status = await sandboxStatus(ctx);
    expect(status.map((row) => [row.slug, row.quick_start_prompts.length])).toEqual([
      ["northwind-sandbox", 3],
    ]);
  });

  it("needs a world for a slug, and knows exactly the worlds there are", async () => {
    ctx = await createTestContext();
    await expect(seedAllSandboxWorkspaces(ctx, false, { slug: "practice" })).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "world" },
    });
    expect([...SANDBOX_WORLD_KEYS].sort()).toEqual(Object.keys(WORLD).sort());
  });

  it("fills in a collection that is missing without touching the rest", async () => {
    ctx = await createTestContext();
    const seeded = await seedWorkspace(ctx, "brightsmile", false);
    await ctx.db.delete(signals).where(eq(signals.workspace_id, seeded.workspace_id));

    const filled = await seedWorkspace(ctx, "brightsmile", false);
    expect(filled.created).toBe(false);
    expect(filled.workspace_id).toBe(seeded.workspace_id);
    expect(filled.counts.signals).toBe(seeded.counts.signals);
    expect(filled.counts.companies).toBe(seeded.counts.companies);
    expect(filled.counts.people).toBe(seeded.counts.people);
  });

  it("seeds demo replies that can be answered: no invalid or suppressed address", async () => {
    ctx = await createTestContext();
    for (const result of await seedAllSandboxWorkspaces(ctx, false)) {
      const [workspace] = await ctx.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, result.workspace_id));
      // The demo replies to answer (the privacy request's person is suppressed on purpose).
      const replied = await ctx.db
        .select({ person_id: threads.person_id })
        .from(threads)
        .where(
          and(
            eq(threads.workspace_id, result.workspace_id),
            inArray(threads.category, ["interested", "question"]),
          ),
        );
      expect(replied).toHaveLength(2);
      const scoped = ctx.with({ workspace });
      for (const thread of replied) {
        expect(await replyBlockers(scoped, thread.person_id, "email")).toEqual([]);
      }
    }
  });

  it("every campaign step's stored config validates against StepConfig", async () => {
    ctx = await createTestContext();
    const result = await seedWorkspace(ctx, "northwind", false);
    const steps = await ctx.db
      .select()
      .from(campaign_steps)
      .where(eq(campaign_steps.workspace_id, result.workspace_id));
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(() => stepConfigSchema.parse(step.config)).not.toThrow();
      expect((step.config as { type: string }).type).toBe(step.type);
    }
  });

  it("marks is_sandbox true and stores the workspace's own company settings", async () => {
    ctx = await createTestContext();
    const result = await seedWorkspace(ctx, "northwind", false);
    const [row] = await ctx.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, result.workspace_id));
    expect(row?.is_sandbox).toBe(true);
    expect(row?.settings.company?.name).toContain("Northwind");
  });

  it("stores ICPs as manage_icp does, so rescoring the seeded leads keeps realistic scores", async () => {
    ctx = await createTestContext();
    for (const result of await seedAllSandboxWorkspaces(ctx, false)) {
      const blueprint = WORLD[result.slug]?.blueprint;
      const rows = await ctx.db
        .select()
        .from(icps)
        .where(eq(icps.workspace_id, result.workspace_id));
      expect(rows).toHaveLength(blueprint?.icps.length ?? -1);
      for (const icp of blueprint?.icps ?? []) {
        const created = createIcp.input.parse({
          name: icp.name,
          criteria: icp.criteria,
          scoring: icp.scoring,
        });
        const row = rows.find((candidate) => candidate.name === icp.name);
        expect(row?.criteria).toEqual(created.criteria);
        expect(row?.scoring).toEqual(created.scoring);
      }

      const seeded = await ctx.db
        .select()
        .from(people)
        .where(eq(people.workspace_id, result.workspace_id));
      const [workspace] = await ctx.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, result.workspace_id));
      const scored = (await scoreLeads.handler(
        ctx.with({ workspace: workspace as Workspace }),
        scoreLeads.input.parse({ all_people: true }),
      )) as { people_scored: number; distribution: Record<string, number> };
      expect(scored.people_scored).toBe(seeded.length);
      expect(scored.distribution).toMatchObject({ unscored: 0 });
      expect(scored.distribution.strong).toBeGreaterThan(0);
      expect(scored.distribution.weak).toBeGreaterThan(0);

      // manage_icp action score gives every seeded lead the score it was seeded with.
      const rescored = await ctx.db
        .select()
        .from(people)
        .where(eq(people.workspace_id, result.workspace_id));
      const seededScores = new Map(seeded.map((person) => [person.id, person.fit_score]));
      for (const person of rescored) expect(person.fit_score).toBe(seededScores.get(person.id));
      const scores = rescored.map((person) => person.fit_score ?? -1);
      expect(Math.max(...scores), result.slug).toBeGreaterThanOrEqual(90);
      expect(Math.min(...scores), result.slug).toBeLessThan(40);
    }
  });
});
