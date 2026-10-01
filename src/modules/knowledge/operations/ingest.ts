import { z } from "zod";
import { requireWorkspace } from "../../../core/context.js";
import { KNOWLEDGE_KINDS } from "../../../core/enums.js";
import { OpenOutboundError } from "../../../core/errors.js";
import { defineOperation, jobHandleOutput } from "../../../core/operation.js";
import { homeUrlFor, MAX_CRAWL_PAGES } from "../crawl.js";
import {
  assertPdf,
  canonicalUrl,
  decodePdfBase64,
  draftsFor,
  INGEST_FORMATS,
  pdfSourceRef,
  readLocalFile,
  saveDrafts,
} from "../ingest.js";
import { itemView, knowledgeItemOutput } from "../shapes.js";

/** Jobs started by this module. */
export const INGEST_JOB = "knowledge.ingest";
export const BOOTSTRAP_JOB = "knowledge.bootstrap";

export const ingestJobPayload = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("url"),
    url: z.string(),
    title: z.string().optional(),
    kind: z.enum(KNOWLEDGE_KINDS),
    status: z.enum(["active", "suggested"]),
    tags: z.array(z.string()),
    source_ref: z.string(),
  }),
  z.object({
    format: z.literal("pdf"),
    content_base64: z.string(),
    file_name: z.string().nullable(),
    title: z.string().optional(),
    kind: z.enum(KNOWLEDGE_KINDS),
    status: z.enum(["active", "suggested"]),
    tags: z.array(z.string()),
    source_ref: z.string(),
  }),
]);
export type IngestJobPayload = z.infer<typeof ingestJobPayload>;

const ingestDone = z.object({
  status: z.literal("done"),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  archived: z.number().int().describe("Old items of the same source_ref that were retired"),
  source_ref: z.string().nullable(),
  items: z.array(knowledgeItemOutput),
  warnings: z.array(z.string()),
});

export const ingestKnowledge = defineOperation({
  id: "knowledge.ingest",
  summary: "Import a document, page or PDF into knowledge",
  description:
    "Turns content about your own company into knowledge items of about 1,500 characters each: text, markdown (split by headings), html (navigation and scripts dropped), url (fetched in the background, robots.txt respected) or pdf (content_base64, max 10 MB; file_path from the local CLI). Text formats return the items at once; url and pdf return a job handle to poll with get_job. Re-ingesting the same source (same URL, file or source_ref) updates its items instead of duplicating them. For one short fact use knowledge.create; to draft a whole base from a website use knowledge.bootstrap.",
  effect: "write",
  input: z.object({
    format: z.enum(INGEST_FORMATS),
    content: z
      .string()
      .max(2_000_000)
      .optional()
      .describe("The text, markdown or HTML (formats text, markdown, html)"),
    url: z.string().url().optional().describe("Page or PDF to fetch (format url)"),
    content_base64: z.string().optional().describe("PDF bytes as base64, max 10 MB (format pdf)"),
    file_path: z
      .string()
      .optional()
      .describe("Local file to read; only accepted from the local CLI"),
    title: z.string().max(200).optional().describe("Title for content before the first heading"),
    kind: z.enum(KNOWLEDGE_KINDS).default("other").describe("Kind for every created item"),
    status: z
      .enum(["active", "suggested"])
      .default("active")
      .describe("suggested = keep out of prompts until approved"),
    tags: z.array(z.string().min(1).max(60)).max(20).default([]),
    source_ref: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Stable name of the source; ingesting the same source_ref again replaces its items",
      ),
  }),
  output: z.union([ingestDone, jobHandleOutput.extend({ message: z.string() })]),
  http: { method: "POST", path: "/v1/knowledge/ingest" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [
    {
      title: "Ingest a markdown one-pager",
      input: {
        format: "markdown",
        content: "# Forecast Pilot\nA 30 day pilot...\n\n## Pricing\nFlat monthly fee...",
        kind: "product",
        source_ref: "one-pager-v2",
      },
    },
    {
      title: "Ingest a case study page",
      input: {
        format: "url",
        url: "https://northwind.example.com/customers/lumen-home",
        kind: "case_study",
      },
    },
  ],
  handler: async (ctx, input) => {
    requireWorkspace(ctx);
    const target = {
      kind: input.kind,
      status: input.status,
      tags: input.tags,
      title: input.title,
    };

    if (input.format === "url") {
      if (!input.url) throw missing("url", "the page address");
      const payload: IngestJobPayload = {
        format: "url",
        url: input.url,
        ...(input.title ? { title: input.title } : {}),
        kind: input.kind,
        status: input.status,
        tags: input.tags,
        source_ref: input.source_ref ?? canonicalUrl(input.url),
      };
      const job = await ctx.jobs.enqueue(INGEST_JOB, payload, {
        maxAttempts: 3,
        singletonKey: `knowledge.ingest:${ctx.workspace?.id}:${payload.source_ref}`,
      });
      return {
        job_id: job.job_id,
        status: job.status,
        message: "Fetching in the background. Poll get_job with job_id for the created items.",
      };
    }

    if (input.format === "pdf") {
      let bytes: Buffer;
      let fileName: string | null = null;
      if (input.content_base64) bytes = decodePdfBase64(input.content_base64);
      else if (input.file_path) {
        ({ bytes, fileName } = await readLocalFile(ctx, input.file_path));
        assertPdf(bytes);
      } else throw missing("content_base64", "the PDF bytes as base64");
      const sourceRef = input.source_ref ?? pdfSourceRef(bytes, fileName);
      const payload: IngestJobPayload = {
        format: "pdf",
        content_base64: bytes.toString("base64"),
        file_name: fileName,
        ...(input.title ? { title: input.title } : {}),
        kind: input.kind,
        status: input.status,
        tags: input.tags,
        source_ref: sourceRef,
      };
      const job = await ctx.jobs.enqueue(INGEST_JOB, payload, {
        maxAttempts: 3,
        singletonKey: `knowledge.ingest:${ctx.workspace?.id}:${sourceRef}`,
      });
      return {
        job_id: job.job_id,
        status: job.status,
        message:
          "Reading the PDF in the background. Poll get_job with job_id for the created items.",
      };
    }

    let content = input.content;
    let sourceRef = input.source_ref;
    let sourceType: "manual" | "file" = "manual";
    if (content === undefined && input.file_path) {
      const file = await readLocalFile(ctx, input.file_path);
      content = file.bytes.toString("utf8");
      sourceRef ??= `file:${file.fileName}`;
      sourceType = "file";
    }
    if (content === undefined || !content.trim()) throw missing("content", `the ${input.format}`);
    const drafts = draftsFor(input.format, content, input.title);
    const result = await saveDrafts(
      ctx,
      drafts,
      { ...target, ...(sourceRef ? { sourceRef } : {}) },
      sourceType,
    );
    return {
      status: "done" as const,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      archived: result.archived,
      source_ref: result.source_ref,
      items: result.items.map((item) => itemView(item, ctx.request.responseFormat)),
      warnings: result.warnings,
    };
  },
});

function missing(field: string, what: string): OpenOutboundError {
  return new OpenOutboundError("validation_failed", `Pass ${field} with ${what}.`, {
    hint: `Add the ${field} field for this format, or pick the format that matches what you have.`,
    details: { field },
  });
}

export const bootstrapKnowledge = defineOperation({
  id: "knowledge.bootstrap",
  summary: "Draft the knowledge base from your website",
  description:
    "Reads up to 8 pages of your own website (home, about, products or services, pricing, customers, blog; robots.txt respected) and drafts about, products, proof, objections with answers, voice notes and 1-3 offers, all saved as suggestions for review, plus ICP and signal suggestions in the job result (each ICP suggestion is manage_icp create input, exclusions included, to pass as is). Use it once when setting up a workspace, then review and approve with knowledge.approve. It runs as a job: poll get_job for the summary. Re-running for the same website updates the pending suggestions instead of duplicating them.",
  effect: "write",
  input: z.object({
    website: z
      .string()
      .min(3)
      .max(300)
      .describe("Your company's website, e.g. northwind.example.com"),
    max_pages: z.number().int().min(1).max(MAX_CRAWL_PAGES).default(MAX_CRAWL_PAGES),
  }),
  output: jobHandleOutput.extend({
    website: z.string(),
    deduplicated: z.boolean(),
    message: z.string(),
  }),
  http: { method: "POST", path: "/v1/knowledge/bootstrap" },
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "Bootstrap from the website", input: { website: "northwind.example.com" } }],
  handler: async (ctx, input) => {
    const workspace = requireWorkspace(ctx);
    const { homeUrl, domain } = homeUrlFor(input.website);
    const job = await ctx.jobs.enqueue(
      BOOTSTRAP_JOB,
      { website: input.website, max_pages: input.max_pages },
      { maxAttempts: 3, singletonKey: `knowledge.bootstrap:${workspace.id}:${domain}` },
    );
    return {
      job_id: job.job_id,
      status: job.status,
      website: homeUrl,
      deduplicated: job.deduplicated ?? false,
      message:
        "Reading the website in the background (usually under 2 minutes). Poll get_job with job_id; the result lists the suggestions and next steps.",
    };
  },
});
