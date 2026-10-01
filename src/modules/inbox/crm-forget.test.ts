import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenOutboundError } from "../../core/errors.js";
import type { EventData } from "../../core/events.js";
import type { WorkspaceSettingsInput } from "../../core/settings.js";
import { problems } from "../../db/schema/index.js";
import type { CrmProvider } from "../../providers/types.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import {
  CRM_FORGET_DELETE_JOB,
  crmForgetDeleteJob,
  crmOnLeadForgotten,
  deleteForgottenContact,
  handleForgottenLead,
} from "./crm-forget.js";

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

type CrmSettings = NonNullable<WorkspaceSettingsInput["crm"]>;
const HASH = "a".repeat(64);

function deletingCrm(id = "hubspot") {
  return {
    id,
    upsertContact: vi.fn(async () => ({ contactId: "c-1" })),
    upsertDeal: vi.fn(async () => ({ dealId: "d-1" })),
    deleteContact: vi.fn(async (_contactId: string) => ({ deleted: true })),
  } satisfies CrmProvider;
}

function plainCrm(id = "pipedrive") {
  return {
    id,
    upsertContact: vi.fn(async () => ({ contactId: "p-1" })),
    upsertDeal: vi.fn(async () => ({ dealId: "d-1" })),
  } satisfies CrmProvider;
}

async function setup(crm: CrmSettings = {}, crms: CrmProvider[] = [deletingCrm(), plainCrm()]) {
  return createTestContext({ db: testDb, providers: { crm: crms }, settings: { crm } });
}

function forgotten(
  links: EventData["lead.forgotten"]["crm_links"],
  hash: string | null = HASH,
): EventData["lead.forgotten"] {
  return { person_id: null, email_sha256: hash, crm_links: links };
}

const LINKS: EventData["lead.forgotten"]["crm_links"] = [
  { provider: "hubspot", entity_type: "person", external_id: "c-1" },
  { provider: "hubspot", entity_type: "opportunity", external_id: "d-9" },
  { provider: "hubspot", entity_type: "company", external_id: "co-3" },
  { provider: "pipedrive", entity_type: "person", external_id: "p-1" },
  { provider: "salesforce", entity_type: "person", external_id: "0035g00000XyZab" },
  { provider: "hubspot", entity_type: "person", external_id: "c-1" },
  { provider: "", entity_type: "person", external_id: "x" },
];

async function forgetProblems(ctx: TestContext) {
  return ctx.db
    .select()
    .from(problems)
    .where(and(eq(problems.workspace_id, ctx.workspace.id), eq(problems.kind, "crm_forget")));
}

describe("handleForgottenLead", () => {
  it("task (default): one problem per contact and deal, owned by whoever syncs that CRM", async () => {
    const ctx = await setup();
    const outcome = await handleForgottenLead(ctx, forgotten(LINKS));
    expect(outcome).toEqual({ tasks: 4, deletes: 0 });
    const rows = await forgetProblems(ctx);
    const byKey = Object.fromEntries(rows.map((row) => [row.dedupe_key, row]));
    expect(Object.keys(byKey).sort()).toEqual([
      "crm_forget:hubspot:opportunity:d-9",
      "crm_forget:hubspot:person:c-1",
      "crm_forget:pipedrive:person:p-1",
      "crm_forget:salesforce:person:0035g00000XyZab",
    ]);
    expect(byKey["crm_forget:hubspot:person:c-1"]).toMatchObject({
      owner: "person",
      severity: "normal",
      status: "open",
      title: "Delete a forgotten contact in HubSpot",
      data: { provider: "hubspot", entity_type: "person", external_id: "c-1" },
    });
    expect(byKey["crm_forget:hubspot:person:c-1"]?.remedy).toContain("resolve_exception");
    expect(byKey["crm_forget:hubspot:opportunity:d-9"]?.title).toBe(
      "Check a deal in HubSpot for a forgotten person",
    );
    // A CRM the engine does not sync itself: the agent reported the id, so the agent acts.
    expect(byKey["crm_forget:salesforce:person:0035g00000XyZab"]?.owner).toBe("agent");
    expect(ctx.emitted("problem.opened")).toHaveLength(4);

    // The same event again (a retry) opens nothing new.
    await handleForgottenLead(ctx, forgotten(LINKS));
    expect(await forgetProblems(ctx)).toHaveLength(4);
    expect(ctx.enqueued(CRM_FORGET_DELETE_JOB)).toHaveLength(0);
  });

  it("delete: queues deletes where the provider can, and a task everywhere else", async () => {
    const ctx = await setup({ on_forget: "delete" });
    expect(await handleForgottenLead(ctx, forgotten(LINKS))).toEqual({ tasks: 3, deletes: 1 });
    expect(ctx.enqueued(CRM_FORGET_DELETE_JOB)).toEqual([
      expect.objectContaining({
        payload: { provider: "hubspot", external_id: "c-1" },
        options: expect.objectContaining({
          singletonKey: `${CRM_FORGET_DELETE_JOB}:hubspot:c-1`,
        }),
      }),
    ]);
    expect((await forgetProblems(ctx)).map((row) => row.dedupe_key).sort()).toEqual([
      "crm_forget:hubspot:opportunity:d-9",
      "crm_forget:pipedrive:person:p-1",
      "crm_forget:salesforce:person:0035g00000XyZab",
    ]);

    // Outside built_in mode the engine never writes to a CRM, not even to delete.
    const agent = await setup({ on_forget: "delete", mode: "agent" });
    expect(await handleForgottenLead(agent, forgotten(LINKS))).toEqual({ tasks: 4, deletes: 0 });
  });

  it("nothing: does nothing", async () => {
    const ctx = await setup({ on_forget: "nothing", mode: "agent" });
    expect(await handleForgottenLead(ctx, forgotten(LINKS))).toEqual({ tasks: 0, deletes: 0 });
    expect(await handleForgottenLead(ctx, forgotten([]))).toEqual({ tasks: 0, deletes: 0 });
    expect(await forgetProblems(ctx)).toHaveLength(0);
  });

  it("agent mode without known ids: one problem asking the agent to find the person by hash", async () => {
    const ctx = await setup({ mode: "agent" });
    expect(await handleForgottenLead(ctx, forgotten([]))).toEqual({ tasks: 1, deletes: 0 });
    const [row] = await forgetProblems(ctx);
    expect(row).toMatchObject({
      owner: "agent",
      title: "Delete a forgotten person from your CRM",
      data: { email_sha256: HASH },
      dedupe_key: `crm_forget:agent:${HASH}`,
    });
    // The remedy carries the hash itself, so the agent needs no other tool to read it.
    expect(row?.remedy).toContain(`the SHA-256 ${HASH}`);

    const noHash = await setup({ mode: "agent" });
    await handleForgottenLead(noHash, forgotten([], null));
    const [plain] = await forgetProblems(noHash);
    expect(plain?.remedy).toContain("kept no email hash");
  });

  it("built_in mode without known ids: one task to search the configured CRMs by the hash", async () => {
    const ctx = await setup();
    expect(await handleForgottenLead(ctx, forgotten([]))).toEqual({ tasks: 1, deletes: 0 });
    const [row] = await forgetProblems(ctx);
    expect(row).toMatchObject({
      owner: "person",
      title: "Search your CRM for a forgotten person",
      data: { email_sha256: HASH, providers: ["hubspot", "pipedrive"] },
      dedupe_key: `crm_forget:built_in:${HASH}`,
    });
    expect(row?.remedy).toContain(
      `Search HubSpot and Pipedrive for the contact whose lowercase email has the SHA-256 ${HASH}`,
    );
    // Only the hash, never a name or address.
    expect(JSON.stringify(row)).not.toContain("@");

    // The same event again opens nothing new; delete mode cannot delete without an id either.
    await handleForgottenLead(ctx, forgotten([]));
    expect(await forgetProblems(ctx)).toHaveLength(1);
    const deleting = await setup({ on_forget: "delete" });
    expect(await handleForgottenLead(deleting, forgotten([]))).toEqual({ tasks: 1, deletes: 0 });

    // No CRM configured, no hash kept, or the CRM step off: nothing to search.
    const noCrm = await setup({}, []);
    expect(await handleForgottenLead(noCrm, forgotten([]))).toEqual({ tasks: 0, deletes: 0 });
    const noHash = await setup();
    expect(await handleForgottenLead(noHash, forgotten([], null))).toEqual({
      tasks: 0,
      deletes: 0,
    });
    const off = await setup({ mode: "off" });
    expect(await handleForgottenLead(off, forgotten([]))).toEqual({ tasks: 0, deletes: 0 });
    expect(await forgetProblems(noCrm)).toHaveLength(0);
  });

  it("runs from the lead.forgotten handler whatever the timing", async () => {
    const ctx = await setup({ timing: "daily" });
    await crmOnLeadForgotten.handler(ctx.jobContext(), {
      id: "evt_forget_1",
      type: "lead.forgotten",
      workspaceId: ctx.workspace.id,
      subject: null,
      data: forgotten([LINKS[0] as EventData["lead.forgotten"]["crm_links"][number]]),
      occurredAt: ctx.clock.now(),
    });
    expect(await forgetProblems(ctx)).toHaveLength(1);
  });
});

describe("deleteForgottenContact", () => {
  it("deletes the contact and resolves an earlier task for it", async () => {
    const crm = deletingCrm();
    const ctx = await setup({ on_forget: "delete" }, [crm]);
    crm.deleteContact.mockRejectedValueOnce(
      new OpenOutboundError("provider_error", "HubSpot rejected the token.", {
        details: { reason: "unauthorized" },
      }),
    );
    expect(await deleteForgottenContact(ctx, "hubspot", "c-1")).toEqual({ status: "failed" });
    const [task] = await forgetProblems(ctx);
    expect(task).toMatchObject({ status: "open", owner: "person" });
    expect(task?.reason).toContain("Deleting it automatically failed: HubSpot rejected the token.");

    expect(await deleteForgottenContact(ctx, "hubspot", "c-1")).toEqual({ status: "deleted" });
    expect(crm.deleteContact).toHaveBeenLastCalledWith("c-1");
    expect((await forgetProblems(ctx))[0]?.status).toBe("resolved");

    crm.deleteContact.mockResolvedValueOnce({ deleted: false });
    expect(await deleteForgottenContact(ctx, "hubspot", "c-2")).toEqual({
      status: "already_gone",
    });
  });

  it("retries temporary failures and hands the delete to a person after the last attempt", async () => {
    const crm = deletingCrm();
    const ctx = await setup({ on_forget: "delete" }, [crm]);
    crm.deleteContact.mockRejectedValue(new Error("socket hang up"));
    await expect(
      crmForgetDeleteJob.handler(ctx.jobContext({ attempt: 1, maxAttempts: 6 }), {
        provider: "hubspot",
        external_id: "c-1",
      }),
    ).rejects.toThrow("socket hang up");
    expect(await forgetProblems(ctx)).toHaveLength(0);
    await expect(
      crmForgetDeleteJob.handler(ctx.jobContext({ attempt: 6, maxAttempts: 6 }), {
        provider: "hubspot",
        external_id: "c-1",
      }),
    ).rejects.toThrow("socket hang up");
    expect(await forgetProblems(ctx)).toEqual([
      expect.objectContaining({ dedupe_key: "crm_forget:hubspot:person:c-1", status: "open" }),
    ]);
  });

  it("opens the task when the provider is gone or cannot delete", async () => {
    const ctx = await setup({ on_forget: "delete" }, [plainCrm()]);
    expect(await deleteForgottenContact(ctx, "hubspot", "c-1")).toEqual({ status: "task" });
    expect(await deleteForgottenContact(ctx, "pipedrive", "p-1")).toEqual({ status: "task" });
    const rows = await forgetProblems(ctx);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.reason).toContain("is no longer configured here, or cannot delete contacts.");
  });
});
