/**
 * Lessons: stored with an expiry, listable through manage_knowledge, kept out of facts, search
 * and gap detection, given to writers as guidance, and archived once expired.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { isOpenOutboundError } from "../../core/errors.js";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import { knowledge_items } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { buildGroundingPack, GUIDANCE_HEADER } from "./grounding.js";
import { createItem, updateItem } from "./items.js";
import { archiveLessonsJob } from "./lessons.js";
import { ingestKnowledge } from "./operations/ingest.js";
import {
  createKnowledgeItem,
  listKnowledge,
  searchKnowledgeItems,
  updateKnowledgeItem,
} from "./operations/items.js";
import { searchKnowledge } from "./service.js";

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

const DAY = 24 * 60 * 60 * 1000;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function addLesson(ctx: TestContext, input: Record<string, unknown>) {
  return call(createKnowledgeItem, ctx, { kind: "lesson", ...input });
}

async function ingestText(ctx: TestContext, input: Record<string, unknown>) {
  const result = await call(ingestKnowledge, ctx, input);
  if (!("items" in result)) throw new Error("expected the items at once");
  return result;
}

async function itemRow(ctx: TestContext, id: string | undefined) {
  const [row] = await ctx.db
    .select()
    .from(knowledge_items)
    .where(eq(knowledge_items.id, id ?? ""));
  return row;
}

describe("storing lessons", () => {
  it("adds a lesson with a 90 day expiry by default, its sample size and author", async () => {
    const ctx = await createTestContext({ db });
    const now = ctx.clock.now().getTime();
    const lesson = await addLesson(ctx, {
      title: "Short first emails win",
      body: "Under 60 words doubled replies from practice managers.",
      source_ref: "campaign report, September",
      sample_size: 420,
    });
    expect(lesson).toMatchObject({
      kind: "lesson",
      sample_size: 420,
      author: { type: "human", name: "Test User" },
    });
    expect(new Date(lesson.expires_at ?? 0).getTime()).toBe(now + 90 * DAY);
    const custom = await addLesson(ctx, { title: "Clinic count openers", expires_in_days: 30 });
    expect(new Date(custom.expires_at ?? 0).getTime()).toBe(now + 30 * DAY);

    const listed = await call(listKnowledge, ctx, { kinds: ["lesson"] });
    expect(listed.items.map((item) => item.title).sort()).toEqual([
      "Clinic count openers",
      "Short first emails win",
    ]);
  });

  it("renews on update, gives a new lesson its expiry and clears it when it stops being one", async () => {
    const ctx = await createTestContext({ db });
    const lesson = await addLesson(ctx, { title: "Renewed lesson", expires_in_days: 10 });
    ctx.clock.advance(5 * DAY);
    const renewed = await call(updateKnowledgeItem, ctx, {
      item_id: lesson.id,
      expires_in_days: 60,
      sample_size: 900,
    });
    expect(new Date(renewed.expires_at ?? 0).getTime()).toBe(ctx.clock.now().getTime() + 60 * DAY);
    expect(renewed.sample_size).toBe(900);

    const fact = await call(createKnowledgeItem, ctx, { kind: "faq", title: "Becomes a lesson" });
    const converted = await call(updateKnowledgeItem, ctx, { item_id: fact.id, kind: "lesson" });
    expect(new Date(converted.expires_at ?? 0).getTime()).toBe(
      ctx.clock.now().getTime() + 90 * DAY,
    );
    await call(updateKnowledgeItem, ctx, { item_id: lesson.id, kind: "other" });
    const [row] = await ctx.db
      .select()
      .from(knowledge_items)
      .where(eq(knowledge_items.id, lesson.id));
    expect(row).toMatchObject({ kind: "other", expires_at: null, sample_size: null });
  });

  it("gives every lesson written without an expiry the 90 day default", async () => {
    const ctx = await createTestContext({ db });
    const inDefault = ctx.clock.now().getTime() + 90 * DAY;
    const expiry = (item: { expires_at: Date | null } | undefined) => item?.expires_at?.getTime();

    // Ingested lessons, with and without a source_ref, and a direct create.
    const loose = await ingestText(ctx, {
      format: "text",
      kind: "lesson",
      content: "Mentioning the clinic count doubled replies.",
      title: "Clinic count openers",
    });
    expect(expiry(await itemRow(ctx, loose.items[0]?.id))).toBe(inDefault);
    const sourced = await ingestText(ctx, {
      format: "markdown",
      kind: "lesson",
      content: "# Short first emails\nUnder 60 words won.",
      source_ref: "september-review",
    });
    const sourcedId = sourced.items[0]?.id ?? "";
    expect(expiry(await itemRow(ctx, sourcedId))).toBe(inDefault);
    const { item: direct } = await createItem(ctx, {
      kind: "lesson",
      title: "Tuesday sends",
      body: "Tuesday mornings got the most replies.",
    });
    expect(expiry(direct)).toBe(inDefault);

    // A lesson stored without an expiry before gets one at its next write.
    await ctx.db
      .update(knowledge_items)
      .set({ expires_at: null })
      .where(eq(knowledge_items.id, sourcedId));
    await ingestText(ctx, {
      format: "markdown",
      kind: "lesson",
      content: "# Short first emails\nUnder 50 words won.",
      source_ref: "september-review",
    });
    expect(expiry(await itemRow(ctx, sourcedId))).toBe(inDefault);
    await ctx.db
      .update(knowledge_items)
      .set({ expires_at: null })
      .where(eq(knowledge_items.id, direct.id));
    expect(expiry(await updateItem(ctx, direct.id, { title: "Tuesday morning sends" }))).toBe(
      inDefault,
    );
    expect(expiry(await updateItem(ctx, direct.id, { expires_at: null }))).toBe(inDefault);
  });

  it("refuses expiry and sample size on other kinds", async () => {
    const ctx = await createTestContext({ db });
    try {
      await call(createKnowledgeItem, ctx, { kind: "proof", title: "Proof", expires_in_days: 30 });
      throw new Error("expected an error");
    } catch (error) {
      expect(isOpenOutboundError(error) && error.code).toBe("validation_failed");
      expect((error as Error).message).toBe("expires_in_days applies to lessons only.");
    }
  });
});

describe("lessons are guidance, never facts", () => {
  it("stays out of search and gap detection unless asked for", async () => {
    const ctx = await createTestContext({ db });
    await call(createKnowledgeItem, ctx, {
      kind: "faq",
      title: "Pricing per location",
      body: "Pricing starts at 49 EUR per location.",
    });
    await addLesson(ctx, {
      title: "Pricing questions",
      body: "Prospects asking about pricing per location book more often.",
    });
    const found = await searchKnowledge(ctx, "pricing location");
    expect(found.map((item) => item.kind)).toEqual(["faq"]);
    const searched = await call(searchKnowledgeItems, ctx, { query: "pricing location" });
    expect(searched.items.map((item) => item.kind)).toEqual(["faq"]);
    const lessons = await call(searchKnowledgeItems, ctx, {
      query: "pricing location",
      kinds: ["lesson"],
    });
    expect(lessons.items.map((item) => item.title)).toEqual(["Pricing questions"]);
  });

  it("reaches the grounding pack only as a separate guidance list", async () => {
    const ctx = await createTestContext({ db });
    const now = ctx.clock.now().getTime();
    await call(createKnowledgeItem, ctx, {
      kind: "about",
      title: "What we do",
      body: "We forecast supplies for dental groups.",
    });
    await ctx.db.insert(knowledge_items).values([
      ...Array.from({ length: 6 }, (_, index) => ({
        workspace_id: ctx.workspace.id,
        kind: "lesson" as const,
        title: `Lesson ${index + 1}`,
        body: `Observation number ${index + 1}.`,
        expires_at: new Date(now + 30 * DAY),
        updated_at: new Date(now - (10 - index) * DAY),
      })),
      {
        workspace_id: ctx.workspace.id,
        kind: "lesson" as const,
        title: "Expired lesson",
        expires_at: new Date(now - DAY),
        updated_at: new Date(now),
      },
      {
        workspace_id: ctx.workspace.id,
        kind: "lesson" as const,
        title: "Archived lesson",
        status: "archived" as const,
        updated_at: new Date(now),
      },
    ]);
    const other = await createTestContext({ db });
    await addLesson(other, { title: "Other client's lesson" });

    const pack = await buildGroundingPack(ctx, {});
    expect(pack.facts.map((fact) => fact.kind)).toEqual(["about"]);
    expect(pack.text).not.toContain("Lesson");
    expect(pack.text).not.toContain(GUIDANCE_HEADER);
    expect(pack.guidance?.map((item) => item.title)).toEqual([
      "Lesson 6",
      "Lesson 5",
      "Lesson 4",
      "Lesson 3",
      "Lesson 2",
    ]);
    expect(pack.guidanceText).toContain(`## ${GUIDANCE_HEADER}`);
    expect(pack.guidanceText).toContain("Never state it to the prospect");
    expect(pack.guidanceText).toContain("- Lesson 6: Observation number 6.");
    expect(pack.guidanceText).not.toContain("Expired lesson");
    expect(pack.guidanceText).not.toContain("Other client");

    const others = await buildGroundingPack(other, {});
    expect(others.guidance?.map((item) => item.title)).toEqual(["Other client's lesson"]);
    const none = await buildGroundingPack(await createTestContext({ db }), {});
    expect(none.guidance).toEqual([]);
    expect(none.guidanceText).toBe("");
  });
});

describe("expiry", () => {
  it("archives expired lessons of the workspace each day", async () => {
    const ctx = await createTestContext({ db });
    const other = await createTestContext({ db });
    const expired = await addLesson(ctx, { title: "Soon stale", expires_in_days: 1 });
    const fresh = await addLesson(ctx, { title: "Still fresh", expires_in_days: 30 });
    const foreign = await addLesson(other, { title: "Other stale", expires_in_days: 1 });
    ctx.clock.advance(2 * DAY);
    const result = await archiveLessonsJob.handler(ctx.jobContext(), {
      workspace_id: ctx.workspace.id,
    });
    expect(result).toEqual({ archived: 1 });
    const status = async (id: string) =>
      (await ctx.db.select().from(knowledge_items).where(eq(knowledge_items.id, id)))[0]?.status;
    expect(await status(expired.id)).toBe("archived");
    expect(await status(fresh.id)).toBe("active");
    expect(await status(foreign.id)).toBe("active");
  });
});
