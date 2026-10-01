import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { messages, people, problems, suppressions, threads } from "../db/schema/index.js";
import { detectPrivacyRequest } from "../modules/inbox/privacy-phrases.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { privacyKindOf } from "./brain/inbox-answers.js";
import { SEEDED_PRIVACY_REPLY, seedPrivacyRequest } from "./privacy-seed.js";
import { seedWorkspace } from "./seed.js";

const DAY = 86_400_000;

describe("sandbox privacy request", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx?.close();
  });

  async function privacyProblems(workspaceId: string) {
    return ctx.db
      .select()
      .from(problems)
      .where(and(eq(problems.workspace_id, workspaceId), eq(problems.kind, "privacy_request")));
  }

  it("seeds one urgent privacy request for the do-not-contact person", async () => {
    ctx = await createTestContext();
    const seeded = await seedWorkspace(ctx, "brightsmile", false);
    const [problem, ...more] = await privacyProblems(seeded.workspace_id);
    expect(more).toEqual([]);
    if (!problem?.person_id || !problem.due_at) throw new Error("privacy problem missing");

    const [person] = await ctx.db.select().from(people).where(eq(people.id, problem.person_id));
    expect(person?.status).toBe("do_not_contact");
    const [reply] = await ctx.db
      .select()
      .from(messages)
      .where(eq(messages.id, problem.subject_id ?? ""));
    expect(reply).toMatchObject({
      direction: "inbound",
      person_id: person?.id,
      body_text: SEEDED_PRIVACY_REPLY,
      classification: { category: "privacy_request", privacy_kind: "delete" },
    });
    const received = reply?.received_at?.getTime() ?? 0;
    expect(problem.due_at.getTime()).toBe(received + 30 * DAY);
    expect(problem).toMatchObject({
      severity: "urgent",
      owner: "person",
      status: "open",
      dedupe_key: `privacy_request:${reply?.id}`,
      data: { kind: "delete", message_id: reply?.id, thread_id: reply?.thread_id },
    });
    expect(problem.title).toMatch(/^Privacy request from .+: delete their data$/);
    expect(problem.title).toContain(person?.full_name ?? "?");
    expect(problem.remedy).toContain(
      `run manage_leads action forget with person_id ${person?.id}, first with dry_run true`,
    );
    expect(problem.data.suggested_reply).toBe(
      `Hi ${person?.first_name}, understood. I am deleting your details now and you will not hear from us again.`,
    );

    const [thread] = await ctx.db
      .select()
      .from(threads)
      .where(eq(threads.id, reply?.thread_id ?? ""));
    expect(thread).toMatchObject({ category: "privacy_request", needs_attention: true });
    const blocks = await ctx.db
      .select({ type: suppressions.type, note: suppressions.note })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.workspace_id, seeded.workspace_id),
          eq(suppressions.value, person?.email ?? ""),
        ),
      );
    expect(blocks).toEqual([{ type: "email", note: `Privacy request (reply ${reply?.id})` }]);
  });

  it("is idempotent and survives a reset", async () => {
    ctx = await createTestContext();
    const first = await seedWorkspace(ctx, "northwind", false);
    const again = await seedWorkspace(ctx, "northwind", false);
    expect(again.counts).toEqual(first.counts);
    expect(await privacyProblems(first.workspace_id)).toHaveLength(1);
    expect(await seedPrivacyRequest(ctx, { workspaceId: first.workspace_id, mailbox: null })).toBe(
      false,
    );

    const reset = await seedWorkspace(ctx, "northwind", true);
    expect(reset.counts).toEqual(first.counts);
    expect(await privacyProblems(reset.workspace_id)).toHaveLength(1);
  });

  it("uses a reply that the rules and the sandbox brain both read as a deletion request", () => {
    expect(detectPrivacyRequest(SEEDED_PRIVACY_REPLY)).toBe("delete");
    expect(privacyKindOf(SEEDED_PRIVACY_REPLY)).toBe("delete");
  });
});
