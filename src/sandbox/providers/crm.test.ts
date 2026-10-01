import { describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import type { Company, Opportunity, Person } from "../../db/schema/index.js";
import type { ProviderRuntime } from "../../providers/types.js";
import { createSandboxCrm } from "./crm.js";

const person = { id: "pe_test1" } as Person;
const company = { id: "co_test1" } as Company;
const opportunity = { id: "opp_test1" } as Opportunity;

function runtime(): ProviderRuntime {
  return {
    fetch: fetch,
    safeFetch: (() => {
      throw new Error("not used");
    }) as unknown as ProviderRuntime["safeFetch"],
    log: { info: () => {}, warn: () => {}, error: () => {} } as unknown as ProviderRuntime["log"],
    clock: fixedClock(),
    baseUrl: "http://localhost:7331",
    workspaceId: "ws_test",
    db: {} as ProviderRuntime["db"],
  };
}

describe("sandbox crm provider", () => {
  it("mints a new contact id, then reuses the given id on update", async () => {
    const crm = createSandboxCrm(runtime());
    const created = await crm.upsertContact(person, company);
    expect(created.contactId).toBeTruthy();
    const updated = await crm.upsertContact(person, company, { contactId: created.contactId });
    expect(updated.contactId).toBe(created.contactId);
  });

  it("mints a new deal id, then reuses the given id on update", async () => {
    const crm = createSandboxCrm(runtime());
    const created = await crm.upsertDeal(opportunity, {});
    expect(created.dealId).toBeTruthy();
    const updated = await crm.upsertDeal(opportunity, { dealId: created.dealId });
    expect(updated.dealId).toBe(created.dealId);
  });

  it("logNote resolves without throwing", async () => {
    const crm = createSandboxCrm(runtime());
    await expect(
      crm.logNote?.({ contactId: "sbx_contact_1", text: "Called, left voicemail." }),
    ).resolves.toBeUndefined();
  });

  it("keeps separate instances independent (in memory only, per instance)", async () => {
    const a = createSandboxCrm(runtime());
    const b = createSandboxCrm(runtime());
    const first = await a.upsertContact(person, company);
    const second = await b.upsertContact(person, company);
    expect(first.contactId).toBe(second.contactId); // both start their own counter at 1
  });
});
