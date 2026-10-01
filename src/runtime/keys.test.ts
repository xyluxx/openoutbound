import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_SCOPES } from "../core/context.js";
import {
  api_keys,
  audit_events,
  idempotency_records,
  type Workspace,
  workspaces,
} from "../db/schema/index.js";
import { module as keys } from "../modules/keys/index.js";
import { createTestEngine, type TestEngine } from "../testing/engine.js";
import {
  API_KEY_PATTERN,
  authenticateApiKey,
  creatorKeyEnded,
  hashApiKey,
  localPrincipal,
} from "./api-keys.js";

interface CreatedKey {
  id: string;
  key: string;
  prefix: string;
  kind: string;
  scopes: string[];
  workspace_id: string | null;
  expires_at: string | null;
  warning: string;
}

let engine: TestEngine;
let acme: Workspace;

const create = (input: Record<string, unknown>, options: Record<string, unknown> = {}) =>
  engine.call("keys.create", input, options) as Promise<CreatedKey>;

beforeAll(async () => {
  engine = await createTestEngine({ modules: [keys] });
  const [row] = await engine.db
    .insert(workspaces)
    .values({ slug: "acme", name: "Acme" })
    .returning();
  if (!row) throw new Error("no workspace");
  acme = row;
});
afterAll(async () => {
  await engine.close();
});
beforeEach(async () => {
  await engine.db.delete(api_keys);
});

describe("API keys", () => {
  it("shows the key once, stores only its hash and authenticates it", async () => {
    const created = await create({ name: "Claude Code on laptop" });
    expect(created.key).toMatch(API_KEY_PATTERN);
    expect(created).toMatchObject({
      kind: "agent",
      scopes: ["read", "write", "send", "spend"],
      workspace_id: null,
      prefix: created.key.slice(0, 11),
    });
    const [row] = await engine.db.select().from(api_keys).where(eq(api_keys.id, created.id));
    expect(row?.hash).toBe(hashApiKey(created.key));
    expect(JSON.stringify(row)).not.toContain(created.key);

    const principal = await engine.authenticate(`  ${created.key} `, "http");
    expect(principal).toEqual({
      type: "agent",
      id: created.id,
      name: "Claude Code on laptop",
      scopes: ["read", "write", "send", "spend"],
      workspaceId: null,
      via: "http",
      // A person created it: the key answers for itself.
      controller: created.id,
    });
    const [used] = await engine.db.select().from(api_keys).where(eq(api_keys.id, created.id));
    expect(used?.last_used_at).toEqual(engine.clock.now());
    engine.advance(30_000);
    await engine.authenticate(created.key, "mcp");
    const [same] = await engine.db.select().from(api_keys).where(eq(api_keys.id, created.id));
    expect(same?.last_used_at).toEqual(used?.last_used_at);
    engine.advance(61_000);
    await engine.authenticate(created.key, "mcp");
    const [later] = await engine.db.select().from(api_keys).where(eq(api_keys.id, created.id));
    expect(later?.last_used_at).toEqual(engine.clock.now());

    const audit = await engine.db.select().from(audit_events);
    expect(JSON.stringify(audit)).not.toContain(created.key);
  });

  it("rejects malformed, unknown, revoked and expired keys", async () => {
    for (const bad of ["", "oo_short", "Bearer oo_x", `oo_${"a".repeat(43)}`]) {
      expect(await engine.authenticate(bad, "http")).toBeNull();
    }
    const temporary = await create({ name: "Temp", expires_in_days: 1 });
    expect(await engine.authenticate(temporary.key, "http")).not.toBeNull();
    engine.advance(25 * 3_600_000);
    expect(await engine.authenticate(temporary.key, "http")).toBeNull();

    const revoked = await create({ name: "Leaked" });
    const result = await engine.call("keys.revoke", { key_id: revoked.id });
    expect(result).toMatchObject({ id: revoked.id, revoked_at: engine.clock.now().toISOString() });
    expect(await engine.authenticate(revoked.key, "http")).toBeNull();
    await expect(engine.call("keys.revoke", { key_id: revoked.id })).resolves.toMatchObject({
      id: revoked.id,
    });
    const active = (await engine.call("keys.list", {})) as { items: Array<{ id: string }> };
    expect(active.items.map((item) => item.id)).not.toContain(revoked.id);
    const all = (await engine.call("keys.list", { include_revoked: true })) as {
      items: Array<{ id: string }>;
    };
    expect(all.items.map((item) => item.id)).toContain(revoked.id);
    expect(JSON.stringify(all)).not.toContain(revoked.key);
  });

  it("never lets a key outlive the key that created it", async () => {
    const minterScopes = ["read", "write", "send", "spend", "admin"];
    const parent = await create({
      name: "Temporary agent",
      scopes: minterScopes,
      expires_in_days: 3,
    });
    const asParent = await engine.authenticate(parent.key, "http");
    if (!asParent) throw new Error("parent does not authenticate");
    // Without an expiry it gets its creator's; a later one is capped; an earlier one stays.
    const inherits = await create({ name: "Inherits" }, { principal: asParent });
    expect(inherits.expires_at).toBe(parent.expires_at);
    expect(inherits.warning).toContain("never outlives");
    const capped = await create({ name: "Capped", expires_in_days: 30 }, { principal: asParent });
    expect(capped.expires_at).toBe(parent.expires_at);
    const sooner = await create({ name: "Sooner", expires_in_days: 1 }, { principal: asParent });
    expect(Date.parse(String(sooner.expires_at))).toBeLessThan(
      Date.parse(String(parent.expires_at)),
    );
    expect(sooner.warning).not.toContain("never outlives");
    // Down the chain too.
    const minter = await create({ name: "Minter", scopes: minterScopes }, { principal: asParent });
    const asMinter = await engine.authenticate(minter.key, "http");
    if (!asMinter) throw new Error("minter does not authenticate");
    const grandchild = await create({ name: "Grandchild" }, { principal: asMinter });
    expect(grandchild.expires_at).toBe(parent.expires_at);

    // Revoking a key revokes every key created from it, down the chain.
    const unrelated = await create({ name: "Unrelated" });
    const revoked = await engine.call("keys.revoke", { key_id: parent.id });
    expect(revoked).toMatchObject({ id: parent.id });
    expect((revoked as { also_revoked: string[] }).also_revoked.sort()).toEqual(
      [inherits.id, capped.id, sooner.id, minter.id, grandchild.id].sort(),
    );
    for (const key of [parent, inherits, capped, sooner, minter, grandchild]) {
      expect(await engine.authenticate(key.key, "http")).toBeNull();
    }
    expect(await engine.authenticate(unrelated.key, "http")).not.toBeNull();
    const again = await engine.call("keys.revoke", { key_id: parent.id });
    expect(again).toMatchObject({ id: parent.id, also_revoked: [] });
  });

  it("ends what a key made with it: a revoked or expired key, or one whose creator ended", async () => {
    const now = engine.clock.now();
    const ended = (id: string) => creatorKeyEnded(engine.db, { id }, now);
    const parent = await create({
      name: "Parent",
      scopes: ["read", "write", "send", "spend", "admin"],
    });
    const asParent = await engine.authenticate(parent.key, "http");
    if (!asParent) throw new Error("parent does not authenticate");
    const child = await create({ name: "Child" }, { principal: asParent });
    expect(await ended(child.id)).toBe(false);
    // Not a key: a person, the engine, nothing.
    expect(await creatorKeyEnded(engine.db, { id: "local-admin" }, now)).toBe(false);
    expect(await creatorKeyEnded(engine.db, null, now)).toBe(false);
    // The child stays stored, but a creator that ended ends it too (also without the cascade).
    await engine.db.update(api_keys).set({ revoked_at: now }).where(eq(api_keys.id, parent.id));
    expect(await ended(parent.id)).toBe(true);
    expect(await ended(child.id)).toBe(true);
    const expiring = await create({ name: "Expiring", expires_in_days: 1 });
    expect(await ended(expiring.id)).toBe(false);
    expect(
      await creatorKeyEnded(
        engine.db,
        { id: expiring.id },
        new Date(now.getTime() + 2 * 86_400_000),
      ),
    ).toBe(true);
  });

  it("refuses a key whose creator key was revoked or expired before it was cascaded", async () => {
    const minterScopes = ["read", "write", "send", "spend", "admin"];
    const parent = await create({ name: "Old minter", scopes: minterScopes });
    const asParent = await engine.authenticate(parent.key, "http");
    if (!asParent) throw new Error("parent does not authenticate");
    const child = await create({ name: "Old child" }, { principal: asParent });
    // A revocation stored before revoking cascaded (only the creator's row changed).
    await engine.db
      .update(api_keys)
      .set({ revoked_at: engine.clock.now() })
      .where(eq(api_keys.id, parent.id));
    expect(await engine.authenticate(child.key, "http")).toBeNull();

    const temporary = await create({
      name: "Old temporary",
      scopes: minterScopes,
      expires_in_days: 1,
    });
    const asTemporary = await engine.authenticate(temporary.key, "http");
    if (!asTemporary) throw new Error("temporary does not authenticate");
    const forever = await create({ name: "Old forever" }, { principal: asTemporary });
    // A child stored without an expiry before keys were capped.
    await engine.db.update(api_keys).set({ expires_at: null }).where(eq(api_keys.id, forever.id));
    expect(await engine.authenticate(forever.key, "http")).not.toBeNull();
    engine.advance(2 * 86_400_000);
    expect(await engine.authenticate(forever.key, "http")).toBeNull();
  });

  it("never grants scopes the creator does not have", async () => {
    await expect(
      create({ name: "Escalation", scopes: ["approve"] }, { scopes: ["read", "admin"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      create({ name: "Default agent" }, { scopes: ["read", "admin"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const reader = await create(
      { name: "Reader", scopes: ["read", "read"] },
      {
        scopes: ["read", "admin"],
      },
    );
    expect(reader.scopes).toEqual(["read"]);
    const human = await create({ name: "Owner", kind: "human" });
    expect(human.scopes).toEqual([...ALL_SCOPES]);
    const service = await create({ name: "Zapier", kind: "service" });
    expect(service.scopes).toEqual(["read", "write"]);
  });

  it("lets only a person create a human key", async () => {
    const agent = engine.principal({ type: "agent", id: "key_agent_admin", name: "Admin agent" });
    const service = engine.principal({ type: "service", id: "key_service", name: "Zapier" });
    for (const principal of [agent, service]) {
      await expect(
        create({ name: "Escalated owner", kind: "human" }, { principal }),
      ).rejects.toMatchObject({ code: "forbidden", details: { reason: "human_key" } });
    }
    expect(await engine.db.select().from(api_keys)).toHaveLength(0);
    // Agent and service keys stay possible for them (within their own scopes).
    await expect(
      create({ name: "Helper", kind: "agent" }, { principal: agent }),
    ).resolves.toMatchObject({ kind: "agent" });
    await expect(create({ name: "Owner", kind: "human" })).resolves.toMatchObject({
      kind: "human",
    });
  });

  it("binds keys to a workspace and keeps workspace keys inside it", async () => {
    const instanceKey = await create({ name: "Instance" });
    const bound = await create({ name: "Acme agent", kind: "human" }, { workspace: "acme" });
    expect(bound.workspace_id).toBe(acme.id);
    const principal = await engine.authenticate(bound.key, "http");
    expect(principal?.workspaceId).toBe(acme.id);
    if (!principal) throw new Error("no principal");

    const nested = await create({ name: "Nested" }, { principal });
    expect(nested.workspace_id).toBe(acme.id);
    // Never a key for another workspace, explicitly named or not.
    const [other] = await engine.db
      .insert(workspaces)
      .values({ slug: "globex-keys", name: "Globex" })
      .returning();
    await expect(
      create({ name: "Elsewhere" }, { principal, workspace: other?.slug ?? "" }),
    ).rejects.toMatchObject({ code: "forbidden", details: { reason: "workspace_scope" } });
    const listed = (await engine.call("keys.list", {}, { principal })) as {
      items: Array<{ id: string }>;
    };
    expect(listed.items.map((item) => item.id).sort()).toEqual([bound.id, nested.id].sort());
    await expect(
      engine.call("keys.revoke", { key_id: instanceKey.id }, { principal }),
    ).rejects.toMatchObject({ code: "not_found" });
    const everything = (await engine.call("keys.list", {})) as { items: Array<{ id: string }> };
    expect(everything.items).toHaveLength(3);
  });

  it("does not replay a plain key from the idempotency store", async () => {
    const first = await create({ name: "Retried" }, { idempotencyKey: "create-key-1" });
    const replay = await create({ name: "Retried" }, { idempotencyKey: "create-key-1" });
    expect(replay.id).toBe(first.id);
    expect(replay.key).toBe("[shown once]");
    const stored = await engine.db.select().from(idempotency_records);
    expect(JSON.stringify(stored)).not.toContain(first.key);
  });

  it("builds local principals", () => {
    const config = { agentScopes: ["read", "write"] as ("read" | "write")[] };
    expect(localPrincipal(config, "admin", "cli")).toMatchObject({
      type: "human",
      id: "local-admin",
      scopes: [...ALL_SCOPES],
      workspaceId: null,
    });
    expect(localPrincipal(config, "agent", "mcp")).toEqual({
      type: "agent",
      id: "local-agent",
      name: "Local agent",
      scopes: ["read", "write"],
      workspaceId: null,
      via: "mcp",
    });
    expect(engine.localPrincipal("agent", "mcp").scopes).toEqual(engine.config.agentScopes);
  });

  it("authenticates directly against the table", async () => {
    const created = await create({ name: "Direct" });
    await expect(
      authenticateApiKey(engine.db, engine.clock, created.key, "cli"),
    ).resolves.toMatchObject({ id: created.id, via: "cli" });
  });
});
