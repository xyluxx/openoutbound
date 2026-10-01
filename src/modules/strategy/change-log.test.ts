import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { change_log } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  changeKind,
  findChange,
  latestVersion,
  recordChange,
  summarizeChange,
} from "./change-log.js";
import { runInChangeScope } from "./change-scope.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const settingsChange = (before: unknown, after: unknown) => ({
  area: "settings" as const,
  targetId: "ws_target",
  operation: "workspaces.update",
  before,
  after,
});

/** A db whose first insert fails like a lost race for the next version. */
function racingDb(real: Db, failures: number): Db {
  let left = failures;
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "insert" && left > 0) {
        left--;
        return () => ({
          values: () => ({
            returning: () =>
              Promise.reject(
                Object.assign(new Error("duplicate key value"), {
                  cause: { code: "23505" },
                }),
              ),
          }),
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe("recordChange", () => {
  it("stores the diff with the next version, actor, door, reason and time", async () => {
    const ctx = await createTestContext({ db, request: { reason: "Hand meetings to people" } });
    const first = await recordChange(
      ctx,
      settingsChange({ booking: { mode: "link" } }, { booking: { mode: "handoff" } }),
    );
    const second = await recordChange(ctx, settingsChange({}, { strategy: { goals: "Demos" } }));
    expect(first?.version).toBe(1);
    expect(second?.version).toBe(2);
    const row = await findChange(ctx, ctx.workspace.id, first?.changeId ?? "");
    expect(row).toMatchObject({
      version: 1,
      area: "settings",
      target_id: "ws_target",
      operation: "workspaces.update",
      diff: [{ path: "booking.mode", before: "link", after: "handoff" }],
      reason: "Hand meetings to people",
      actor: { type: "human", id: "usr_test", name: "Test User", via: "cli" },
      via: "cli",
      proposal_id: null,
      undo_of: null,
    });
    expect(row?.created_at.toISOString()).toBe(ctx.clock.now().toISOString());
    expect(ctx.emitted("change.recorded").map((event) => event.data)).toEqual([
      {
        change_id: first?.changeId,
        version: 1,
        area: "settings",
        target_id: "ws_target",
        proposal_id: null,
      },
      {
        change_id: second?.changeId,
        version: 2,
        area: "settings",
        target_id: "ws_target",
        proposal_id: null,
      },
    ]);
    expect(await latestVersion(ctx, ctx.workspace.id)).toBe(2);
  });

  it("records nothing when before and after are equal", async () => {
    const ctx = await createTestContext({ db });
    expect(
      await recordChange(
        ctx,
        settingsChange({ ai: { language: "en" } }, { ai: { language: "en" } }),
      ),
    ).toBeNull();
    expect(await latestVersion(ctx, ctx.workspace.id)).toBe(0);
    expect(ctx.emitted("change.recorded")).toHaveLength(0);
  });

  it("gives every concurrent change its own version", async () => {
    const ctx = await createTestContext({ db });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        recordChange(ctx, settingsChange({ n: index }, { n: index + 1 })),
      ),
    );
    const versions = results.map((result) => result?.version).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(versions).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("retries when another writer took the version", async () => {
    const ctx = await createTestContext({ db });
    const racing = { ...ctx, db: racingDb(ctx.db, 2) } as TestContext;
    const result = await recordChange(racing, settingsChange({ a: 1 }, { a: 2 }));
    expect(result?.version).toBe(1);
  });

  it("logs and returns null instead of breaking the change when storing fails", async () => {
    const ctx = await createTestContext({ db });
    const broken = { ...ctx, db: racingDb(ctx.db, 20) } as TestContext;
    await expect(recordChange(broken, settingsChange({ a: 1 }, { a: 2 }))).resolves.toBeNull();
  });

  it("counts versions per workspace", async () => {
    const one = await createTestContext({ db });
    const two = await createTestContext({ db });
    await recordChange(one, settingsChange({ a: 1 }, { a: 2 }));
    await recordChange(one, settingsChange({ a: 2 }, { a: 3 }));
    const other = await recordChange(two, settingsChange({ a: 1 }, { a: 2 }));
    expect(other?.version).toBe(1);
    expect(await findChange(two, two.workspace.id, other?.changeId ?? "")).not.toBeNull();
    expect(await findChange(one, one.workspace.id, other?.changeId ?? "")).toBeNull();
  });

  it("links changes made inside a proposal or undo scope", async () => {
    const ctx = await createTestContext({ db });
    const scope = {
      workspaceId: ctx.workspace.id,
      proposalId: "prop_01k6a3v0q8x3m2n4p5r6s7t8v9",
      undoOf: "chg_01k6a3v0q8x3m2n4p5r6s7t8v9",
      operation: "changes.undo",
      recorded: [] as Array<{ changeId: string; version: number }>,
    };
    const result = await runInChangeScope(scope, async () => {
      await Promise.resolve();
      return recordChange(ctx, settingsChange({ a: 1 }, { a: 2 }));
    });
    expect(scope.recorded).toEqual([{ changeId: result?.changeId, version: result?.version }]);
    const [row] = await ctx.db
      .select()
      .from(change_log)
      .where(eq(change_log.id, result?.changeId ?? ""));
    expect(row).toMatchObject({
      proposal_id: scope.proposalId,
      undo_of: scope.undoOf,
      operation: "changes.undo",
    });
    // A scope of another workspace is ignored.
    const other = await createTestContext({ db });
    const outside = await runInChangeScope(scope, () =>
      recordChange(other, settingsChange({ a: 1 }, { a: 2 })),
    );
    const otherRow = await findChange(other, other.workspace.id, outside?.changeId ?? "");
    expect(otherRow).toMatchObject({ proposal_id: null, undo_of: null });
  });
});

describe("change kinds and summaries", () => {
  it("tells creates, deletes and updates apart by the operation, never by missing paths", () => {
    expect(changeKind({ area: "offer", operation: "offers.create", diff: [] })).toBe("create");
    expect(changeKind({ area: "offer", operation: "knowledge.approve", diff: [] })).toBe("create");
    expect(changeKind({ area: "icp", operation: "icps.delete", diff: [] })).toBe("delete");
    expect(changeKind({ area: "offer", operation: "offers.delete", diff: [] })).toBe("delete");
    // An update that only adds (or only removes) keys is still an update.
    expect(
      changeKind({
        area: "campaign",
        operation: "campaigns.update",
        diff: [{ path: "settings.review_level", after: "every" }] as never,
      }),
    ).toBe("update");
    expect(
      changeKind({
        area: "campaign",
        operation: "changes.undo",
        diff: [{ path: "settings.review_level", before: "every" }] as never,
      }),
    ).toBe("update");
    expect(
      changeKind({
        area: "settings",
        operation: "workspaces.update",
        diff: [{ path: "strategy.goals", after: "X" }] as never,
      }),
    ).toBe("update");
  });

  it("keeps the create or delete operation of a whole record inside an undo scope", async () => {
    const ctx = await createTestContext({ db });
    const scope = {
      workspaceId: ctx.workspace.id,
      undoOf: "chg_01k6a3v0q8x3m2n4p5r6s7t8v9",
      operation: "changes.undo",
      recorded: [] as Array<{ changeId: string; version: number }>,
    };
    const created = await runInChangeScope(scope, () =>
      recordChange(ctx, {
        area: "icp",
        targetId: "icp_1",
        operation: "icps.create",
        before: null,
        after: { name: "Dental groups" },
      }),
    );
    const row = await findChange(ctx, ctx.workspace.id, created?.changeId ?? "");
    expect(row).toMatchObject({ operation: "icps.create" });
    expect(changeKind(row as NonNullable<typeof row>)).toBe("create");
  });

  it("summarizes one value or the changed paths", () => {
    expect(
      summarizeChange({
        area: "settings",
        operation: "workspaces.update",
        diff: [{ path: "booking.mode", before: "link", after: "handoff" }],
      }),
    ).toBe("booking.mode: link -> handoff");
    expect(
      summarizeChange({
        area: "settings",
        operation: "workspaces.update",
        diff: ["a", "b", "c", "d", "e"].map((path) => ({ path, before: 1, after: 2 })),
      }),
    ).toBe("Changed a, b, c and 2 more");
    expect(
      summarizeChange({
        area: "offer",
        operation: "offers.create",
        diff: [{ path: "name", after: "Pilot" }] as never,
      }),
    ).toBe("Created (name)");
  });
});
