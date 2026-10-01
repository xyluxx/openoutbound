import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { OpenOutboundError } from "../../core/errors.js";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { createTestDb, type TestDb } from "../../testing/db.js";
import { extractPdfText } from "./ingest.js";
import { ingestJob } from "./jobs.js";
import { ingestKnowledge } from "./operations/ingest.js";
import { listKnowledge } from "./operations/items.js";

/** Builds a small valid one-page PDF with the given lines (Helvetica, no compression). */
function makePdf(lines: string[]): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines
    .map((line) => `(${line.replace(/[()\\]/g, "\\$&")}) Tj T*`)
    .join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

let db: TestDb;
let tmp: string;
beforeAll(async () => {
  db = await createTestDb();
  tmp = await mkdtemp(join(tmpdir(), "oo-ingest-"));
});
afterAll(async () => {
  await db.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("knowledge.ingest (inline formats)", () => {
  it("splits markdown by headings and re-ingesting the same source_ref updates in place", async () => {
    const ctx = await createTestContext({ db });
    const first = await call(ingestKnowledge, ctx, {
      format: "markdown",
      content: "# Pilot\nA 30 day pilot.\n\n# Pricing\nFlat fee.\n\n# Support\nEmail only.",
      kind: "product",
      source_ref: "one-pager",
      tags: ["Sales"],
    });
    expect(first).toMatchObject({ status: "done", created: 3, updated: 0, archived: 0 });
    if (!("items" in first)) throw new Error("expected inline result");
    expect(first.items.map((i) => [i.title, i.kind, i.tags])).toEqual([
      ["Pilot", "product", ["sales"]],
      ["Pricing", "product", ["sales"]],
      ["Support", "product", ["sales"]],
    ]);

    const second = await call(ingestKnowledge, ctx, {
      format: "markdown",
      content: "# Pilot\nA 30 day pilot.\n\n# Pricing\nFlat fee per store.",
      kind: "product",
      source_ref: "one-pager",
    });
    expect(second).toMatchObject({ created: 0, updated: 1, unchanged: 1, archived: 1 });
    if (!("items" in second)) throw new Error("expected inline result");
    expect(second.items.map((i) => i.id)).toEqual(first.items.slice(0, 2).map((i) => i.id));

    const listed = await call(listKnowledge, ctx, {});
    expect(listed.items).toHaveLength(2);
  });

  it("dedupes identical text without a source_ref and ingests html without chrome", async () => {
    const ctx = await createTestContext({ db });
    const input = { format: "text", content: "We answer within one business day.", title: "SLA" };
    expect(await call(ingestKnowledge, ctx, input)).toMatchObject({ created: 1 });
    expect(await call(ingestKnowledge, ctx, input)).toMatchObject({ created: 0, unchanged: 1 });

    const html = await call(ingestKnowledge, ctx, {
      format: "html",
      content:
        "<nav>Menu</nav><h2>Guarantee</h2><p>Cancel any time.</p><script>x()</script><footer>(c)</footer>",
      kind: "faq",
    });
    if (!("items" in html)) throw new Error("expected inline result");
    expect(html.items.map((i) => [i.title, i.body])).toEqual([["Guarantee", "Cancel any time."]]);
  });

  it("explains what is missing and blocks file paths outside the CLI", async () => {
    const ctx = await createTestContext({ db });
    await expect(call(ingestKnowledge, ctx, { format: "markdown" })).rejects.toMatchObject({
      code: "validation_failed",
      details: { field: "content" },
    });
    await expect(call(ingestKnowledge, ctx, { format: "url" })).rejects.toMatchObject({
      details: { field: "url" },
    });
    const file = join(tmp, "notes.md");
    await writeFile(file, "# From file\nRead from disk.");
    const viaMcp = ctx.with({ principal: { via: "mcp" } });
    await expect(
      call(ingestKnowledge, viaMcp, { format: "markdown", file_path: file }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const viaCli = await call(ingestKnowledge, ctx, { format: "markdown", file_path: file });
    expect(viaCli).toMatchObject({ created: 1, source_ref: "file:notes.md" });
  });
});

describe("knowledge.ingest (url and pdf jobs)", () => {
  it("fetches a url in a job with robots respected and is idempotent", async () => {
    const ctx = await createTestContext({ db });
    const url = "https://northwind.example.com/customers/lumen-home";
    const handle = await call(ingestKnowledge, ctx, { format: "url", url, kind: "case_study" });
    expect(handle).toMatchObject({ status: "queued" });
    const [job] = ctx.enqueued("knowledge.ingest");
    expect(job?.payload).toMatchObject({ format: "url", url, source_ref: url });

    ctx.fetch.route(url, {
      headers: { "content-type": "text/html" },
      body: "<html><head><title>Lumen Home</title></head><body><h1>Lumen Home</h1><p>Cut stockouts by 31%.</p></body></html>",
    });
    const payload = ingestJob.payload?.parse(job?.payload);
    if (!payload) throw new Error("payload");
    const result = (await ingestJob.handler(ctx.jobContext(), payload)) as Record<string, unknown>;
    expect(result).toMatchObject({ created: 1, source_ref: url });
    expect(ctx.recorded.fetch[0]?.init?.respectRobots).toBe(true);
    const again = (await ingestJob.handler(ctx.jobContext(), payload)) as Record<string, unknown>;
    expect(again).toMatchObject({ created: 0, unchanged: 1 });
  });

  it("fails the job with an actionable error when robots.txt disallows the page", async () => {
    const ctx = await createTestContext({ db });
    const url = "https://private.example.com/secret";
    ctx.fetch.route(url, () => {
      throw new OpenOutboundError("forbidden", "robots.txt disallows this URL", {
        details: { reason: "robots_disallowed" },
      });
    });
    await expect(
      ingestJob.handler(ctx.jobContext(), {
        format: "url",
        url,
        kind: "other",
        status: "active",
        tags: [],
        source_ref: url,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("extracts PDF text into items, rejects non-PDF and oversized content", async () => {
    const ctx = await createTestContext({ db });
    const pdf = makePdf(["Forecast Pilot overview", "Plans start with a free pilot."]);
    expect((await extractPdfText(pdf)).text).toContain("Forecast Pilot overview");

    const handle = await call(ingestKnowledge, ctx, {
      format: "pdf",
      content_base64: pdf.toString("base64"),
      title: "Overview deck",
      kind: "product",
    });
    expect(handle).toMatchObject({ status: "queued" });
    const payload = ingestJob.payload?.parse(ctx.enqueued("knowledge.ingest")[0]?.payload);
    if (!payload) throw new Error("payload");
    expect(payload.source_ref).toMatch(/^sha256:/);
    const result = (await ingestJob.handler(ctx.jobContext(), payload)) as Record<string, unknown>;
    expect(result).toMatchObject({ created: 1, pages: 1, titles: ["Overview deck"] });

    await expect(
      call(ingestKnowledge, ctx, {
        format: "pdf",
        content_base64: Buffer.from("hello").toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      call(ingestKnowledge, ctx, { format: "pdf", content_base64: "A".repeat(14_500_000) }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});
