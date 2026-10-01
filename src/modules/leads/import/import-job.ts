/** Background job for large imports: batches with progress and a resumable checkpoint. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineJob } from "../../../core/operation.js";
import { imports } from "../../../db/schema/index.js";
import type { MergePolicy } from "../dedupe.js";
import { loadIcp } from "../icp/apply.js";
import { IMPORT_JOB, importResult } from "./import-leads.js";
import type { NormalizedRow } from "./rows.js";
import {
  completeImport,
  emptyTally,
  finishRows,
  type ImportRunOptions,
  type ImportTally,
  processRows,
  type SeenKeys,
  SKIP_REASONS,
  tallyErrors,
  tallyFromStats,
  tallyStats,
} from "./run.js";

const BATCH_SIZE = 200;

function addInto(total: ImportTally, batch: ImportTally): void {
  total.total += batch.total;
  total.created += batch.created;
  total.updated += batch.updated;
  total.merged += batch.merged;
  total.failed += batch.failed;
  total.companies_created += batch.companies_created;
  total.companies_updated += batch.companies_updated;
  for (const reason of SKIP_REASONS) total.skipped[reason] += batch.skipped[reason];
  total.outcomes.push(...batch.outcomes.slice(0, Math.max(0, 1000 - total.outcomes.length)));
}

export const importRunJob = defineJob({
  name: IMPORT_JOB,
  payload: z.object({ import_id: z.string() }),
  maxAttempts: 3,
  timeoutMs: 30 * 60_000,
  handler: async (ctx, payload) => {
    const workspaceId = ctx.workspace?.id;
    if (!workspaceId) return { skipped: "no_workspace" };
    const [row] = await ctx.db
      .select()
      .from(imports)
      .where(and(eq(imports.id, payload.import_id), eq(imports.workspace_id, workspaceId)));
    if (row?.status !== "running") return { skipped: "not_running" };
    const rows = (row.options.rows ?? []) as NormalizedRow[];
    let processed = Number(row.options.processed ?? 0);
    const previousErrors = processed > 0 ? (row.errors ?? []) : [];
    const tally = processed > 0 ? tallyFromStats(row.stats) : emptyTally();
    const icpId = typeof row.options.icp_id === "string" ? row.options.icp_id : null;
    const icp = icpId ? await loadIcp(ctx, icpId).catch(() => null) : null;
    const options: ImportRunOptions = {
      source: row.source,
      mergePolicy: (row.options.merge_policy as MergePolicy | undefined) ?? "fill_empty",
      listId: row.list_id,
      icp,
      includeConsentCountries: row.options.include_consent_countries === true,
      importId: row.id,
    };
    const seen: SeenKeys = new Map();
    for (let start = processed; start < rows.length; start += BATCH_SIZE) {
      ctx.job.signal.throwIfAborted();
      const batch = await processRows(
        ctx,
        rows.slice(start, start + BATCH_SIZE),
        options,
        true,
        emptyTally(),
        seen,
      );
      await finishRows(ctx, batch, options);
      addInto(tally, batch);
      processed = Math.min(rows.length, start + BATCH_SIZE);
      await ctx.db
        .update(imports)
        .set({
          stats: tallyStats(tally, processed),
          errors: [...previousErrors, ...tallyErrors(tally)].slice(0, 1000),
          options: { ...row.options, processed },
        })
        .where(eq(imports.id, row.id));
      await ctx.setProgress({
        done: processed,
        total: rows.length,
        stage: "importing",
        message: `${processed} of ${rows.length} rows`,
      });
    }
    const [current] = await ctx.db.select().from(imports).where(eq(imports.id, row.id));
    await completeImport(ctx, current ?? row, tally, "completed", previousErrors);
    return importResult(row.id, tally, row.list_id);
  },
});
