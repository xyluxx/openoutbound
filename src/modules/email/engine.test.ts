import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../../core/ids.js";
import { audit_events, mailboxes, suppressions } from "../../db/schema/index.js";
import { createTestEngine, type TestEngine } from "../../testing/engine.js";
import { signUnsubscribeToken } from "./unsubscribe-token.js";

vi.mock("../leads/service.js", async () => (await import("./test-support.js")).fakeLeadsService);

let engine: TestEngine;
let workspaceId: string;

beforeEach(async () => {
  engine = await createTestEngine({ now: "2026-09-21T15:00:00.000Z" });
  const created = (await engine.call("workspaces.create", { name: "Helix Test" })) as {
    id: string;
  };
  workspaceId = created.id;
});
afterEach(async () => {
  await engine.close();
});

const call = (id: string, input: unknown, options: { dryRun?: boolean } = {}) =>
  engine.call(id, input, { workspace: workspaceId, ...options });

describe("email module on the real engine", () => {
  it("adds and lists mailboxes through the executor without leaking passwords", async () => {
    const added = (await call("mailboxes.add", {
      email: "sam@brand.example.com",
      smtp_host: "smtp.brandmail.example.com",
      imap_host: "imap.brandmail.example.com",
      password: "secret-pw-1",
      reason: "Connect the first sender",
    })) as { mailbox: { id: string } };
    const listed = (await call("mailboxes.list", {})) as { items: Array<{ id: string }> };
    expect(listed.items.map((item) => item.id)).toEqual([added.mailbox.id]);

    const audit = await engine.db
      .select()
      .from(audit_events)
      .where(eq(audit_events.operation, "mailboxes.add"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("secret-pw-1");
    const [row] = await engine.db.select().from(mailboxes);
    expect(JSON.stringify(row)).not.toContain("secret-pw-1");
  });

  it("keeps CSV passwords out of the audit log, also on dry runs", async () => {
    const csv =
      "email,password,smtp_host\nlee@brand.example.com,csv-pw-2,smtp.brandmail.example.com";
    const preview = (await call(
      "mailboxes.import_csv",
      { csv_credentials: csv },
      { dryRun: true },
    )) as { dry_run: boolean };
    expect(preview.dry_run).toBe(true);
    expect(await engine.db.select().from(mailboxes)).toHaveLength(0);
    await call("mailboxes.import_csv", { csv_credentials: csv });
    expect(await engine.db.select().from(mailboxes)).toHaveLength(1);
    const audit = await engine.db.select().from(audit_events);
    expect(JSON.stringify(audit)).not.toContain("csv-pw-2");
  });

  it("serves the unsubscribe routes with the engine's system context", async () => {
    const app = new Hono();
    for (const register of engine.httpRoutes()) register(app, { engine });
    const token = signUnsubscribeToken(engine.config, {
      messageId: newId("msg"),
      workspaceId,
      email: "dana@harbor.example.com",
    });
    expect((await app.request(`/u/${token}`)).status).toBe(200);
    const response = await app.request(`/u/${token}`, {
      method: "POST",
      body: "List-Unsubscribe=One-Click",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(response.status).toBe(200);
    const [row] = await engine.db.select().from(suppressions);
    expect(row).toMatchObject({ workspace_id: workspaceId, value: "dana@harbor.example.com" });
  });

  it("runs the sync and health schedules for the workspace", async () => {
    await call("mailboxes.add", {
      email: "sam@brand.example.com",
      smtp_host: "smtp.brandmail.example.com",
      password: "pw",
    });
    engine.advance(60 * 60_000);
    const result = await engine.runJobs();
    expect(JSON.stringify(result)).not.toMatch(/email\.(sync_all|health_check)[^}]*failed/);
    const [row] = await engine.db.select().from(mailboxes);
    expect(row?.health).toMatchObject({ sent_7d: 0, bounce_rate_7d: 0 });
  });
});
