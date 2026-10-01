import { afterEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import { silentLogger } from "../../core/logger.js";
import {
  linkedin_accounts,
  linkedin_relations,
  people,
  workspaces,
} from "../../db/schema/index.js";
import type { ProviderRuntime } from "../../providers/types.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { allPeople } from "../world/index.js";
import { hashBool } from "../world/rng.js";
import { createSandboxLinkedIn } from "./linkedin.js";

/** Finds an id suffix whose accept-bucket hash matches `want`, so tests control the outcome. */
function idWithAcceptBucket(prefix: string, want: boolean): string {
  for (let i = 0; i < 2000; i++) {
    const id = `${prefix}_${i}`;
    if (hashBool(`accept:${id}`, 0.35) === want) return id;
  }
  throw new Error(`no id found with accept bucket ${want}`);
}

function runtime(db: TestDb["db"], workspaceId: string, now: string): ProviderRuntime {
  return {
    fetch: fetch,
    safeFetch: (() => {
      throw new Error("not used");
    }) as unknown as ProviderRuntime["safeFetch"],
    log: silentLogger(),
    clock: fixedClock(now),
    baseUrl: "http://localhost:7331",
    workspaceId,
    db,
  };
}

describe("sandbox linkedin provider", () => {
  let testDb: TestDb;
  afterEach(async () => {
    await testDb?.close();
  });

  it("getProfile throws an actionable error for a profile outside the sandbox world", async () => {
    testDb = await createTestDb();
    const [ws] = await testDb.db.insert(workspaces).values({ slug: "ws1", name: "WS" }).returning();
    expect(ws).toBeDefined();
    if (!ws) return;
    const provider = createSandboxLinkedIn(runtime(testDb.db, ws.id, "2026-09-27T12:00:00Z"));
    await expect(
      provider.getProfile("acct_1", {
        profile_url: "https://www.linkedin.com/in/not-a-real-person",
      }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("getProfile returns a known world person, and sendInvite/getProfile agree on relation state", async () => {
    testDb = await createTestDb();
    const [ws] = await testDb.db.insert(workspaces).values({ slug: "ws1", name: "WS" }).returning();
    const worldPerson = allPeople()[0];
    expect(worldPerson).toBeDefined();
    if (!worldPerson || !ws) return;

    const [account] = await testDb.db
      .insert(linkedin_accounts)
      .values({
        workspace_id: ws.id,
        provider: "sandbox",
        external_account_id: "acct_1",
        status: "active",
      })
      .returning();
    const [personRow] = await testDb.db
      .insert(people)
      .values({
        workspace_id: ws.id,
        full_name: worldPerson.full_name,
        linkedin_url: worldPerson.linkedin_url,
      })
      .returning();
    expect(account && personRow).toBeTruthy();
    if (!account || !personRow) return;

    const provider = createSandboxLinkedIn(runtime(testDb.db, ws.id, "2026-09-27T12:00:00Z"));
    const profileBefore = await provider.getProfile("acct_1", {
      profile_url: worldPerson.linkedin_url,
    });
    expect(profileBefore.full_name).toBe(worldPerson.full_name);
    expect(profileBefore.connection_degree).not.toBe(1);

    const invite = await provider.sendInvite(
      "acct_1",
      { profile_url: worldPerson.linkedin_url },
      "Hi there",
    );
    expect(invite.providerRef).toBeTruthy();

    await testDb.db.insert(linkedin_relations).values({
      workspace_id: ws.id,
      account_id: account.id,
      person_id: personRow.id,
      status: "connected",
      connected_at: new Date("2026-09-27T12:00:00Z"),
    });
    const profileAfter = await provider.getProfile("acct_1", {
      profile_url: worldPerson.linkedin_url,
    });
    expect(profileAfter.connection_degree).toBe(1);
  });

  it("listRecentPosts is deterministic and about half of a large sample have a post", async () => {
    testDb = await createTestDb();
    const [ws] = await testDb.db.insert(workspaces).values({ slug: "ws1", name: "WS" }).returning();
    expect(ws).toBeDefined();
    if (!ws) return;
    const provider = createSandboxLinkedIn(runtime(testDb.db, ws.id, "2026-09-27T12:00:00Z"));
    const sample = allPeople().slice(0, 60);
    let withPost = 0;
    for (const person of sample) {
      const a = await provider.listRecentPosts("acct_1", { profile_url: person.linkedin_url });
      const b = await provider.listRecentPosts("acct_1", { profile_url: person.linkedin_url });
      expect(a).toEqual(b);
      if (a.length > 0) withPost++;
    }
    expect(withPost).toBeGreaterThan(sample.length * 0.3);
    expect(withPost).toBeLessThan(sample.length * 0.7);
  });

  it("syncRelations reports acceptance only after the simulated delay and only for the accepting bucket", async () => {
    testDb = await createTestDb();
    const [ws] = await testDb.db.insert(workspaces).values({ slug: "ws1", name: "WS" }).returning();
    expect(ws).toBeDefined();
    if (!ws) return;
    const [account] = await testDb.db
      .insert(linkedin_accounts)
      .values({
        workspace_id: ws.id,
        provider: "sandbox",
        external_account_id: "acct_1",
        status: "active",
      })
      .returning();
    expect(account).toBeDefined();
    if (!account) return;

    const acceptsId = idWithAcceptBucket("pe_accept", true);
    const rejectsId = idWithAcceptBucket("pe_reject", false);
    const now = new Date("2026-09-27T12:00:00Z");
    const longAgo = new Date(now.getTime() - 60 * 60_000);

    await testDb.db.insert(people).values([
      {
        id: acceptsId,
        workspace_id: ws.id,
        full_name: "Accepts Person",
        linkedin_url: "https://www.linkedin.com/in/accepts-person",
      },
      {
        id: rejectsId,
        workspace_id: ws.id,
        full_name: "Rejects Person",
        linkedin_url: "https://www.linkedin.com/in/rejects-person",
      },
    ]);
    await testDb.db.insert(linkedin_relations).values([
      {
        workspace_id: ws.id,
        account_id: account.id,
        person_id: acceptsId,
        status: "invited",
        invited_at: longAgo,
      },
      {
        workspace_id: ws.id,
        account_id: account.id,
        person_id: rejectsId,
        status: "invited",
        invited_at: longAgo,
      },
    ]);

    const provider = createSandboxLinkedIn(runtime(testDb.db, ws.id, now.toISOString()));
    const result = await provider.syncRelations?.("acct_1", { since: undefined, cursor: null });
    expect(result?.connections.map((c) => c.profile_url)).toEqual([
      "https://www.linkedin.com/in/accepts-person",
    ]);
  });

  it("syncRelations does not report acceptance before the simulated delay elapses", async () => {
    testDb = await createTestDb();
    const [ws] = await testDb.db.insert(workspaces).values({ slug: "ws1", name: "WS" }).returning();
    expect(ws).toBeDefined();
    if (!ws) return;
    const [account] = await testDb.db
      .insert(linkedin_accounts)
      .values({
        workspace_id: ws.id,
        provider: "sandbox",
        external_account_id: "acct_1",
        status: "active",
      })
      .returning();
    expect(account).toBeDefined();
    if (!account) return;

    const acceptsId = idWithAcceptBucket("pe_accept_soon", true);
    const now = new Date("2026-09-27T12:00:00Z");
    const justNow = new Date(now.getTime() - 60_000);

    await testDb.db.insert(people).values({
      id: acceptsId,
      workspace_id: ws.id,
      full_name: "Accepts Soon",
      linkedin_url: "https://www.linkedin.com/in/accepts-soon",
    });
    await testDb.db.insert(linkedin_relations).values({
      workspace_id: ws.id,
      account_id: account.id,
      person_id: acceptsId,
      status: "invited",
      invited_at: justNow,
    });

    const provider = createSandboxLinkedIn(runtime(testDb.db, ws.id, now.toISOString()));
    const result = await provider.syncRelations?.("acct_1", { since: undefined, cursor: null });
    expect(result?.connections).toEqual([]);
  });
});
