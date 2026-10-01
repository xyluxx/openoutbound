/** A short reference of an opportunity for deal titles: the end of its id. */
export function opportunityRef(opportunityId: string): string {
  return opportunityId.slice(-8);
}

/**
 * Deal titles. The engine names new deals "Harbor Dental (OpenOutbound 5r6s7t8v)": the company,
 * else the contact, else "Opportunity", with a short reference of the opportunity. It looks for
 * that exact title before creating a deal, so a retry after a lost response finds the first one
 * instead of making a second, and a new opportunity of the same person never finds (and
 * reopens) the deal of an earlier one.
 */
export function crmDealTitle(who: string | null | undefined, opportunityId: string): string {
  return `${who?.trim() || "Opportunity"} (OpenOutbound ${opportunityRef(opportunityId)})`;
}

/**
 * Remembers display names of records a CRM instance just upserted, so `upsertDeal` can title a
 * new deal when the caller passes no title (callers that do not pass `options.title`).
 */
export class LabelCache {
  private readonly labels = new Map<string, string>();

  constructor(private readonly max = 1000) {}

  remember(id: string | undefined, label: string | null | undefined): void {
    if (!id || !label?.trim()) return;
    this.labels.delete(id);
    this.labels.set(id, label.trim());
    if (this.labels.size > this.max) {
      const oldest = this.labels.keys().next().value;
      if (oldest !== undefined) this.labels.delete(oldest);
    }
  }

  get(id: string | undefined): string | undefined {
    return id ? this.labels.get(id) : undefined;
  }

  /** Deal title from the company, else the contact, else the opportunity id. */
  dealTitle(links: { companyId?: string; contactId?: string }, opportunityId: string): string {
    return crmDealTitle(this.get(links.companyId) ?? this.get(links.contactId), opportunityId);
  }
}
