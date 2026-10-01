/**
 * Sandbox CRM provider: records calls in memory (no external CRM, nothing persists past this
 * provider instance's lifetime).
 */
import type { CrmProvider, ProviderRuntime } from "../../providers/types.js";

export interface RecordedCrmCall {
  kind: "contact" | "deal" | "note";
  at: number;
  data: unknown;
}

export function createSandboxCrm(ctx: ProviderRuntime): CrmProvider {
  let contactSeq = 0;
  let dealSeq = 0;
  const calls: RecordedCrmCall[] = [];

  return {
    id: "sandbox",
    async upsertContact(person, _company, existing) {
      const contactId = existing?.contactId ?? `sbx_contact_${++contactSeq}`;
      calls.push({
        kind: "contact",
        at: ctx.clock.now().getTime(),
        data: { personId: person.id, contactId },
      });
      return { contactId, companyId: existing?.companyId };
    },
    async upsertDeal(opportunity, links) {
      const dealId = links.dealId ?? `sbx_deal_${++dealSeq}`;
      calls.push({
        kind: "deal",
        at: ctx.clock.now().getTime(),
        data: { opportunityId: opportunity.id, dealId },
      });
      return { dealId };
    },
    async logNote(input) {
      calls.push({ kind: "note", at: ctx.clock.now().getTime(), data: input });
    },
  };
}
