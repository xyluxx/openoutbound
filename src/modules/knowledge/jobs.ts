import { z } from "zod";
import { defineJob } from "../../core/operation.js";
import { type BootstrapPayload, runBootstrap } from "./bootstrap.js";
import { textToDrafts } from "./chunk.js";
import { MAX_CRAWL_PAGES } from "./crawl.js";
import { draftsFromUrl, extractPdfText, saveDrafts } from "./ingest.js";
import {
  BOOTSTRAP_JOB,
  INGEST_JOB,
  type IngestJobPayload,
  ingestJobPayload,
} from "./operations/ingest.js";

/** `knowledge.ingest`: fetches a URL or reads a PDF, then writes the items of that source. */
export const ingestJob = defineJob<IngestJobPayload>({
  name: INGEST_JOB,
  payload: ingestJobPayload,
  maxAttempts: 3,
  timeoutMs: 3 * 60_000,
  handler: async (ctx, payload) => {
    const target = {
      kind: payload.kind,
      status: payload.status,
      tags: payload.tags,
      title: payload.title,
      sourceRef: payload.source_ref,
    };
    if (payload.format === "url") {
      await ctx.setProgress({ stage: "fetching", message: payload.url });
      const { drafts, finalUrl } = await draftsFromUrl(ctx, payload.url, payload.title);
      await ctx.setProgress({ stage: "saving", message: `${drafts.length} items` });
      const result = await saveDrafts(ctx, drafts, target, "url");
      return summary(result, { url: finalUrl });
    }
    await ctx.setProgress({ stage: "reading", message: payload.file_name ?? "PDF" });
    const bytes = Buffer.from(payload.content_base64, "base64");
    const { text, pages } = await extractPdfText(bytes);
    const title = payload.title ?? payload.file_name?.replace(/\.pdf$/i, "") ?? undefined;
    const drafts = textToDrafts(text, title ? { title } : {});
    const result = await saveDrafts(ctx, drafts, target, "file");
    return summary(result, { pages });
  },
});

function summary(
  result: Awaited<ReturnType<typeof saveDrafts>>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extra,
    source_ref: result.source_ref,
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    archived: result.archived,
    item_ids: result.items.map((item) => item.id),
    titles: result.items.slice(0, 20).map((item) => item.title),
    warnings: result.warnings,
  };
}

const bootstrapPayload = z.object({
  website: z.string().min(3),
  max_pages: z.number().int().min(1).max(MAX_CRAWL_PAGES).optional(),
});

/** `knowledge.bootstrap`: crawl + one brain call + suggestions (see bootstrap.ts). */
export const bootstrapJob = defineJob<BootstrapPayload>({
  name: BOOTSTRAP_JOB,
  payload: bootstrapPayload,
  maxAttempts: 3,
  timeoutMs: 5 * 60_000,
  handler: (ctx, payload) => runBootstrap(ctx, payload),
});
