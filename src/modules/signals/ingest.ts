/**
 * Shared ingest path for the signals.ingest operation and the inbound webhook: records each
 * signal on its own (one bad item never fails the batch) and reports what happened per item.
 */
import type { OpContext } from "../../core/context.js";
import { isOpenOutboundError } from "../../core/errors.js";
import type { RawSignal } from "../../providers/types.js";
import { storeSignal } from "./service.js";

export interface IngestItemResult {
  index: number;
  status: "created" | "duplicate" | "skipped";
  signal_id?: string;
  company_id?: string | null;
  person_id?: string | null;
  /** Why the item was skipped (validation, unknown company, disabled key). */
  reason?: string;
}

export interface IngestResult {
  received: number;
  created: number;
  duplicates: number;
  skipped: number;
  companies_created: number;
  items: IngestItemResult[];
}

export async function ingestSignals(
  ctx: OpContext,
  input: {
    items: Array<{ index: number; signal: RawSignal }>;
    invalid?: Array<{ index: number; message: string }>;
    /** Create a company from company.domain when none matches. */
    createCompanies: boolean;
  },
): Promise<IngestResult> {
  const result: IngestResult = {
    received: input.items.length + (input.invalid?.length ?? 0),
    created: 0,
    duplicates: 0,
    skipped: 0,
    companies_created: 0,
    items: [],
  };
  for (const invalid of input.invalid ?? []) {
    result.skipped += 1;
    result.items.push({ index: invalid.index, status: "skipped", reason: invalid.message });
  }
  for (const { index, signal } of input.items) {
    try {
      const stored = await storeSignal(ctx, signal, {
        createCompanies: input.createCompanies,
        // A job change is about the person moving: never credit their old company.
        linkPersonCompany: signal.definition_key !== "job_change",
      });
      if (stored.createdCompany) result.companies_created += 1;
      if (stored.created) result.created += 1;
      else result.duplicates += 1;
      result.items.push({
        index,
        status: stored.created ? "created" : "duplicate",
        signal_id: stored.id,
        company_id: stored.companyId,
        person_id: stored.personId,
      });
    } catch (error) {
      if (!isOpenOutboundError(error)) throw error;
      result.skipped += 1;
      result.items.push({
        index,
        status: "skipped",
        reason: error.hint ? `${error.message} ${error.hint}` : error.message,
      });
    }
  }
  result.items.sort((a, b) => a.index - b.index);
  return result;
}
