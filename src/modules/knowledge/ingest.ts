/**
 * Knowledge ingest: text, markdown, HTML, URL and PDF content -> knowledge item drafts ->
 * items. Text formats run inline; URL and PDF run as the `knowledge.ingest` job.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { OpContext } from "../../core/context.js";
import type { KnowledgeKind, KnowledgeSourceType } from "../../core/enums.js";
import { OpenOutboundError } from "../../core/errors.js";
import {
  htmlToDrafts,
  htmlToMarkdownText,
  type ItemDraft,
  markdownToDrafts,
  textToDrafts,
} from "./chunk.js";
import { type SourceWriteResult, writeSourceItems } from "./items.js";

export const INGEST_FORMATS = ["text", "markdown", "html", "url", "pdf"] as const;
export type IngestFormat = (typeof INGEST_FORMATS)[number];

/** PDFs (base64 or file) and fetched URLs are capped at 10 MB. */
export const MAX_INGEST_BYTES = 10 * 1024 * 1024;
/** Items created from one ingest at most (the rest is dropped with a warning). */
export const MAX_ITEMS_PER_INGEST = 200;

export interface IngestTarget {
  kind: KnowledgeKind;
  status: "active" | "suggested";
  tags: string[];
  title?: string | undefined;
  sourceRef?: string | undefined;
}

/** Drafts for inline text formats. */
export function draftsFor(format: "text" | "markdown" | "html", content: string, title?: string) {
  const options = title ? { title } : {};
  if (format === "markdown") return markdownToDrafts(content, options);
  if (format === "html") return htmlToDrafts(content, options);
  return textToDrafts(content, options);
}

export interface IngestResult extends Omit<SourceWriteResult, "items"> {
  items: SourceWriteResult["items"];
  source_ref: string | null;
  warnings: string[];
}

/** Writes drafts for one source and reports counts. */
export async function saveDrafts(
  ctx: OpContext,
  drafts: ItemDraft[],
  target: IngestTarget,
  sourceType: KnowledgeSourceType,
): Promise<IngestResult> {
  const warnings: string[] = [];
  let kept = drafts;
  if (drafts.length > MAX_ITEMS_PER_INGEST) {
    warnings.push(
      `Content produced ${drafts.length} items; kept the first ${MAX_ITEMS_PER_INGEST}. Split the source to ingest the rest.`,
    );
    kept = drafts.slice(0, MAX_ITEMS_PER_INGEST);
  }
  if (kept.length === 0) warnings.push("No readable text found; nothing was saved.");
  const result = await writeSourceItems(ctx, {
    drafts: kept,
    kind: target.kind,
    status: target.status,
    sourceType,
    sourceRef: target.sourceRef ?? null,
    tags: target.tags,
  });
  return { ...result, source_ref: target.sourceRef ?? null, warnings };
}

/** Reads a local file for the CLI door. Only the local CLI may pass paths (never HTTP or MCP). */
export async function readLocalFile(
  ctx: OpContext,
  filePath: string,
): Promise<{ bytes: Buffer; fileName: string }> {
  if (ctx.principal.via !== "cli") {
    throw new OpenOutboundError("forbidden", "file_path is only accepted from the local CLI.", {
      hint: "Send the content instead: `content` for text, markdown or html, `content_base64` for pdf.",
    });
  }
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    throw new OpenOutboundError("validation_failed", `Cannot read ${filePath}.`, {
      hint: "Check the path (relative paths resolve from the current directory).",
    });
  }
  if (size > MAX_INGEST_BYTES) throw tooLarge(size);
  return { bytes: await readFile(filePath), fileName: basename(filePath) };
}

/** Decodes base64 PDF content and checks size and the %PDF header. */
export function decodePdfBase64(contentBase64: string): Buffer {
  const clean = contentBase64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const approxBytes = Math.floor((clean.length * 3) / 4);
  if (approxBytes > MAX_INGEST_BYTES) throw tooLarge(approxBytes);
  const bytes = Buffer.from(clean, "base64");
  assertPdf(bytes);
  return bytes;
}

export function assertPdf(bytes: Uint8Array): void {
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    throw new OpenOutboundError("validation_failed", "The content is not a PDF file.", {
      hint: "Pass the raw PDF bytes as base64 in content_base64 (the file must start with %PDF-).",
    });
  }
}

function tooLarge(bytes: number): OpenOutboundError {
  return new OpenOutboundError(
    "validation_failed",
    `The file is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB.`,
    { hint: "Split the document or ingest the relevant sections as markdown." },
  );
}

/** Default source ref for PDF bytes: the file name, else a content hash. */
export function pdfSourceRef(bytes: Uint8Array, fileName?: string | null): string {
  if (fileName) return `file:${fileName}`;
  return `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;
}

/** Text of every page (pages separated by blank lines), via unpdf. */
export async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  assertPdf(bytes);
  const { extractText, getDocumentProxy } = await import("unpdf");
  let pages: string[];
  let total: number;
  try {
    const document = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(document, { mergePages: false });
    pages = result.text;
    total = result.totalPages;
  } catch (error) {
    throw new OpenOutboundError("validation_failed", "The PDF could not be read.", {
      hint: "Check that the file is a valid, unencrypted PDF with selectable text (scanned PDFs need OCR first).",
      cause: error,
    });
  }
  const text = pages
    .map((page) => page.replace(/[ \t]+\n/g, "\n").trim())
    .filter(Boolean)
    .join("\n\n");
  return { text, pages: total };
}

/** Fetches a URL (robots respected) and turns it into drafts by content type. */
export async function draftsFromUrl(
  ctx: OpContext,
  url: string,
  title?: string,
): Promise<{ drafts: ItemDraft[]; finalUrl: string; contentType: string }> {
  const response = await ctx.fetch(url, {
    respectRobots: true,
    maxBytes: MAX_INGEST_BYTES,
    headers: { accept: "text/html,application/xhtml+xml,text/markdown,text/plain,application/pdf" },
  });
  if (!response.ok) {
    throw new OpenOutboundError(
      "provider_error",
      `Fetching ${url} returned HTTP ${response.status}.`,
      {
        hint: "Check that the page is public (no login) and the URL is right, then ingest again.",
        details: { status: response.status },
      },
    );
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const finalUrl = response.url || url;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const head = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
  if (contentType.includes("application/pdf") || head === "%PDF-") {
    const { text } = await extractPdfText(bytes);
    return {
      drafts: textToDrafts(text, { title: title ?? titleFromUrl(finalUrl) }),
      finalUrl,
      contentType: "application/pdf",
    };
  }
  const body = new TextDecoder("utf-8").decode(bytes);
  const looksHtml = contentType.includes("html") || /<(html|body|head|p|div)[\s>]/i.test(body);
  if (contentType.includes("markdown") || /\.(md|markdown)$/i.test(new URL(finalUrl).pathname)) {
    return { drafts: markdownToDrafts(body, title ? { title } : {}), finalUrl, contentType };
  }
  if (looksHtml) {
    const { title: pageTitle, text } = htmlToMarkdownText(body);
    const fallback = title ?? pageTitle ?? titleFromUrl(finalUrl);
    return { drafts: markdownToDrafts(text, { title: fallback }), finalUrl, contentType };
  }
  if (contentType.startsWith("text/") || contentType === "") {
    return {
      drafts: textToDrafts(body, { title: title ?? titleFromUrl(finalUrl) }),
      finalUrl,
      contentType,
    };
  }
  throw new OpenOutboundError("unsupported", `Cannot ingest content of type ${contentType}.`, {
    hint: "Ingest HTML pages, markdown, plain text or PDF files.",
  });
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).at(-1);
    return last ? `${parsed.hostname}: ${decodeURIComponent(last)}` : parsed.hostname;
  } catch {
    return url;
  }
}

/** Canonical form of a URL used as source ref (no fragment, no trailing slash). */
export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const text = parsed.toString();
    return parsed.pathname === "/" && !parsed.search ? text.replace(/\/$/, "") : text;
  } catch {
    return url;
  }
}
