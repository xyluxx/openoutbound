import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../../../testing/context.js";
import { createTestDb, type TestDb } from "../../../testing/db.js";
import { seedMailbox } from "../../../testing/factories.js";
import { collectWarnings } from "./warnings.js";

let db: TestDb;
let ctx: TestContext;
beforeAll(async () => {
  db = await createTestDb();
  ctx = await createTestContext({ db });
});
afterAll(async () => {
  await ctx.close();
  await db.close();
});

describe("reply sync warnings", () => {
  it("warns loudly once IMAP has failed for a while, and not after a single failed run", async () => {
    const now = ctx.clock.now();
    const minutesAgo = (minutes: number) =>
      new Date(now.getTime() - minutes * 60_000).toISOString();
    const failing = await seedMailbox(ctx, {
      email: "stuck@example.org",
      health: { last_sync_error: "IMAP login failed", sync_error_since: minutesAgo(90) },
    });
    await seedMailbox(ctx, {
      email: "blip@example.org",
      health: { last_sync_error: "Connection timed out", sync_error_since: minutesAgo(5) },
    });
    await seedMailbox(ctx, { email: "fine@example.org", health: { last_sync_error: null } });

    const { warnings } = await collectWarnings(ctx, ctx.workspace, now);
    const sync = warnings.filter((entry) => entry.code === "mailbox_sync_failing");
    expect(sync).toHaveLength(1);
    expect(sync[0]).toMatchObject({
      severity: "critical",
      target_id: failing.id,
      message: expect.stringContaining("stuck@example.org"),
      hint: expect.stringContaining("action test"),
    });
  });
});
