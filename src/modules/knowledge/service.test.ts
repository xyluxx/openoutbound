import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KnowledgeKind, KnowledgeStatus } from "../../core/enums.js";
import { knowledge_items, offers } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { answerGap } from "./gaps.js";
import { rankKnowledge } from "./search.js";
import { buildGroundingPack, openKnowledgeGap, searchKnowledge } from "./service.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

/** A fresh workspace on the shared database. */
async function context(settings: Record<string, unknown> = {}): Promise<TestContext> {
  return createTestContext({ db, settings });
}

async function item(
  ctx: TestContext,
  kind: KnowledgeKind,
  title: string,
  body: string,
  status: KnowledgeStatus = "active",
) {
  const [row] = await ctx.db
    .insert(knowledge_items)
    .values({ workspace_id: ctx.workspace.id, kind, title, body, status })
    .returning();
  if (!row) throw new Error("insert failed");
  return row;
}

describe("searchKnowledge", () => {
  it("ranks title matches first and never returns suggested, archived or other workspaces", async () => {
    const ctx = await context();
    const other = await context();
    const inBody = await item(ctx, "faq", "Setup time", "Shopify stores connect in one day.");
    const inTitle = await item(ctx, "product", "Shopify integration", "Two-way sync of orders.");
    await item(ctx, "faq", "Shopify pricing", "Draft answer", "suggested");
    await item(ctx, "faq", "Shopify legacy", "Old answer", "archived");
    await item(other, "faq", "Shopify elsewhere", "Other workspace");

    const results = await searchKnowledge(ctx, "shopify");
    expect(results.map((r) => r.id)).toEqual([inTitle.id, inBody.id]);
  });

  it("tops up all-words matches with any-word matches", async () => {
    const ctx = await context();
    const both = await item(ctx, "faq", "Shopify pricing", "Flat fee per store.");
    const one = await item(ctx, "faq", "Pricing", "Plans start small.");
    await item(ctx, "about", "Company", "We forecast demand.");

    const ranked = await rankKnowledge(ctx.db, ctx.workspace.id, "shopify pricing");
    expect(ranked.map((r) => [r.item.id, r.match])).toEqual([
      [both.id, "fulltext"],
      [one.id, "any_word"],
    ]);
    const strict = await rankKnowledge(ctx.db, ctx.workspace.id, "shopify pricing", {
      mode: "all",
    });
    expect(strict.map((r) => r.item.id)).toEqual([both.id]);
  });

  it("falls back to a substring match when the query has no lexemes", async () => {
    const ctx = await context();
    const hit = await item(ctx, "faq", "Discounts", "Save 10% with code ++promo++ today.");
    const ranked = await rankKnowledge(ctx.db, ctx.workspace.id, "++");
    expect(ranked.map((r) => [r.item.id, r.match])).toEqual([[hit.id, "substring"]]);
    expect(await searchKnowledge(ctx, "%")).toEqual([hit].map((row) => ({ ...row, search: null })));
    expect(await searchKnowledge(ctx, "   ")).toEqual([]);
  });

  it("escapes LIKE wildcards in the fallback", async () => {
    const ctx = await context();
    await item(ctx, "faq", "Underscore", "no match here");
    expect(await rankKnowledge(ctx.db, ctx.workspace.id, "_")).toEqual([]);
  });
});

describe("buildGroundingPack", () => {
  it("includes every rule, the default offer with proof, facts for the query and voice samples", async () => {
    const ctx = await context({
      company: { name: "Northwind Analytics", website: "https://northwind.example.com" },
    });
    const rule1 = await item(ctx, "rule", "No ROI promises", "Never promise ROI numbers.");
    await item(ctx, "rule", "Never mention competitors", "");
    await item(ctx, "rule", "Draft rule", "Not approved yet", "suggested");
    const proof = await item(ctx, "proof", "Stockouts down 31%", "Lumen Home cut stockouts 31%.");
    await item(ctx, "about", "About Northwind", "Inventory forecasting for DTC brands.");
    const shopify = await item(ctx, "faq", "Shopify", "We connect to Shopify in a day.");
    await item(ctx, "faq", "Suggested fact", "Should never appear", "suggested");
    await item(ctx, "voice_sample", "Voice", "Short sentences. No fluff.");
    const [offer] = await ctx.db
      .insert(offers)
      .values({
        workspace_id: ctx.workspace.id,
        name: "Forecast Pilot",
        summary: "A 30 day pilot.",
        value_props: ["Fewer stockouts"],
        proof_item_ids: [proof.id],
        cta: "Open to a 20 minute call?",
        is_default: true,
      })
      .returning();

    const pack = await buildGroundingPack(ctx, { query: "shopify" });
    expect(pack.company).toEqual({
      name: "Northwind Analytics",
      website: "https://northwind.example.com",
    });
    expect(pack.offer?.id).toBe(offer?.id);
    expect(pack.rules).toEqual([`${rule1.title}: ${rule1.body}`, "Never mention competitors"]);
    expect(pack.facts[0]?.id).toBe(proof.id);
    expect(pack.facts[1]?.id).toBe(shopify.id);
    expect(pack.facts.map((f) => f.title)).not.toContain("Suggested fact");
    expect(pack.voiceSamples).toEqual(["Short sentences. No fluff."]);
    expect(pack.text.indexOf("## Rules")).toBeLessThan(
      pack.text.indexOf("## Offer: Forecast Pilot"),
    );
    expect(pack.text.indexOf("## Offer")).toBeLessThan(pack.text.indexOf("## Facts about us"));
    expect(pack.text).toContain("## Voice samples");
    expect(pack.text).not.toContain("Not approved yet");
    expect(pack.text).not.toContain("Should never appear");
  });

  it("keeps rules and the offer, then stops adding facts at maxChars", async () => {
    const ctx = await context();
    await item(ctx, "rule", "Rule", "Always be honest.");
    for (let i = 0; i < 10; i++) {
      await item(ctx, "about", `Fact ${i}`, `${"lorem ipsum ".repeat(40)}${i}`);
    }
    await item(ctx, "voice_sample", "Voice", "Plain words.");
    const pack = await buildGroundingPack(ctx, { maxChars: 1_500 });
    expect(pack.text.length).toBeLessThanOrEqual(1_500);
    expect(pack.rules).toEqual(["Rule: Always be honest."]);
    expect(pack.facts.length).toBeGreaterThan(0);
    expect(pack.facts.length).toBeLessThan(10);
    expect(pack.voiceSamples).toEqual(["Plain words."]);

    const big = await buildGroundingPack(ctx, {});
    expect(big.facts).toHaveLength(10);
    expect(big.text.length).toBeLessThanOrEqual(6_000);
  });

  it("uses at most 3 voice samples and no offer when none is default among several", async () => {
    const ctx = await context();
    for (let i = 0; i < 5; i++) await item(ctx, "voice_sample", `Voice ${i}`, `Sample ${i}`);
    await ctx.db.insert(offers).values([
      { workspace_id: ctx.workspace.id, name: "A" },
      { workspace_id: ctx.workspace.id, name: "B" },
    ]);
    const pack = await buildGroundingPack(ctx, {});
    expect(pack.voiceSamples).toHaveLength(3);
    expect(pack.offer).toBeNull();
    expect(pack.company).toEqual({ name: null, website: null });
  });

  it("uses the only active offer, and rejects unknown or suggested explicit offers", async () => {
    const ctx = await context();
    const [only] = await ctx.db
      .insert(offers)
      .values({ workspace_id: ctx.workspace.id, name: "Only" })
      .returning();
    const [suggested] = await ctx.db
      .insert(offers)
      .values({
        workspace_id: ctx.workspace.id,
        name: "Draft",
        status: "archived",
        suggested: true,
      })
      .returning();
    expect((await buildGroundingPack(ctx, { offerId: null })).offer?.id).toBe(only?.id);
    await expect(
      buildGroundingPack(ctx, { offerId: "off_01k6a3v0q8x3m2n4p5r6s7t8v9" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(buildGroundingPack(ctx, { offerId: suggested?.id ?? "" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("leaves the offer's booking link out of the text when asked", async () => {
    const ctx = await context();
    await ctx.db.insert(offers).values({
      workspace_id: ctx.workspace.id,
      name: "Forecast Pilot",
      summary: "A 30 day pilot.",
      booking_url: "https://calendly.com/northwind-example/intro",
      is_default: true,
    });
    const withLink = await buildGroundingPack(ctx, {});
    expect(withLink.text).toContain("Booking link: https://calendly.com/northwind-example/intro");
    const without = await buildGroundingPack(ctx, { bookingLink: false });
    expect(without.text).not.toContain("calendly.com");
    expect(without.text).toContain("Summary: A 30 day pilot.");
    expect(without.offer?.booking_url).toBe("https://calendly.com/northwind-example/intro");
  });
});

describe("knowledge gaps", () => {
  it("dedupes open gaps by normalized question and emits once", async () => {
    const ctx = await context();
    const first = await openKnowledgeGap(ctx, {
      question: "Do you integrate with Shopify?",
      threadId: "thr_01k6a3v0q8x3m2n4p5r6s7t8v9",
    });
    const second = await openKnowledgeGap(ctx, {
      question: "  do you INTEGRATE with shopify ",
      context: "Asked in a reply",
    });
    expect(second.id).toBe(first.id);
    const events = ctx.emitted("knowledge.gap_opened");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({
      gap_id: first.id,
      question: "Do you integrate with Shopify?",
      thread_id: "thr_01k6a3v0q8x3m2n4p5r6s7t8v9",
    });
    const different = await openKnowledgeGap(ctx, { question: "What does it cost?" });
    expect(different.id).not.toBe(first.id);
    await expect(openKnowledgeGap(ctx, { question: "?!" })).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("answering creates an active faq item, and the next same question opens a new gap", async () => {
    const ctx = await context();
    const gap = await openKnowledgeGap(ctx, { question: "Is there a free trial?" });
    const answered = await answerGap(ctx, { gapId: gap.id, answer: "Yes, 30 days." });
    expect(answered.created).toBe(true);
    expect(answered.item).toMatchObject({
      kind: "faq",
      title: "Is there a free trial?",
      body: "Yes, 30 days.",
      status: "active",
    });
    expect(answered.gap).toMatchObject({ status: "answered", answer_item_id: answered.item.id });
    const again = await answerGap(ctx, { gapId: gap.id, answer: "Yes, 14 days." });
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(answered.item.id);
    expect(again.item.body).toBe("Yes, 14 days.");
    expect((await searchKnowledge(ctx, "free trial")).map((i) => i.id)).toEqual([answered.item.id]);
    const reopened = await openKnowledgeGap(ctx, { question: "Is there a free trial?" });
    expect(reopened.id).not.toBe(gap.id);
  });
});
