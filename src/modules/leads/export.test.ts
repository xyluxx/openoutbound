import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AnyZodObject, OperationDefinition } from "../../core/operation.js";
import { list_members, lists } from "../../db/schema/index.js";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { truncateAll } from "../../testing/db.js";
import { seedCompany, seedPerson, seedWorkspace } from "../../testing/factories.js";
import { csvCell, exportFileJob, exportToFile } from "./export.js";
import { exportLeads } from "./operations/export.js";

async function call<In extends AnyZodObject, Out extends z.ZodType>(
  op: OperationDefinition<In, Out>,
  ctx: TestContext,
  input: unknown,
): Promise<z.output<Out>> {
  return op.output.parse(await op.handler(ctx, op.input.parse(input))) as z.output<Out>;
}

// biome-ignore lint/suspicious/noExplicitAny: test results are checked with expect
type Any = any;

let ctx: TestContext;
const stateDir = mkdtempSync(join(tmpdir(), "oo-export-"));

beforeAll(async () => {
  ctx = await createTestContext({ config: { stateDir } });
});
afterAll(async () => {
  await ctx.close();
  rmSync(stateDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  ctx = ctx.with({ workspace: await seedWorkspace(ctx.db, { settings: {} }) });
  ctx.recorded.jobs.length = 0;
});

describe("csvCell", () => {
  it("quotes separators and neutralizes formulas", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
    expect(csvCell('Rivers, "Dana"')).toBe('"Rivers, ""Dana"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1 512 555 0101")).toBe("'+1 512 555 0101");
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });
});

describe("leads.export", () => {
  it("exports a list as CSV with the chosen fields", async () => {
    const company = await seedCompany(ctx, {
      name: "Brightsmile Dental",
      domain: "brightsmile.example.com",
    });
    const dana = await seedPerson(ctx, {
      company_id: company.id,
      full_name: "Dana Rivers",
      email: "dana@brightsmile.example.com",
      title: "=cmd|' /C calc'!A0",
    });
    await seedPerson(ctx, { full_name: "Not In List" });
    const [list] = await ctx.db
      .insert(lists)
      .values({ workspace_id: ctx.workspace.id, name: "Export me", kind: "static" })
      .returning();
    await ctx.db.insert(list_members).values({ list_id: list?.id as string, person_id: dana.id });

    const result: Any = await call(exportLeads, ctx, {
      list_id: list?.id,
      fields: ["full_name", "title", "email", "company_name", "company_domain"],
    });
    expect(result).toMatchObject({ format: "csv", rows: 1, untrusted: true });
    expect(result.content).toBe(
      "full_name,title,email,company_name,company_domain\r\n" +
        "Dana Rivers,'=cmd|' /C calc'!A0,dana@brightsmile.example.com,Brightsmile Dental,brightsmile.example.com\r\n",
    );
  });

  it("exports JSON with default fields and needs a selection", async () => {
    await seedPerson(ctx, { full_name: "Dana Rivers", fit_score: 81, tags: ["vip", "dental"] });
    const result: Any = await call(exportLeads, ctx, {
      filter: {},
      format: "json",
      fields: ["full_name", "fit_score", "tags"],
    });
    expect(JSON.parse(result.content)).toEqual([
      { full_name: "Dana Rivers", fit_score: 81, tags: "vip; dental" },
    ]);
    const defaults: Any = await call(exportLeads, ctx, { filter: {} });
    expect(defaults.fields).toContain("email");
    await expect(call(exportLeads, ctx, {})).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("streams large exports to a file under the state directory", async () => {
    for (let i = 0; i < 3; i++) await seedPerson(ctx, { full_name: `Person ${i}` });
    const csv = await exportToFile(ctx, { filter: {} }, "csv", ["full_name"], "people.csv");
    expect(csv).toEqual({ path: join(stateDir, "exports", "people.csv"), rows: 3 });
    expect(readFileSync(csv.path, "utf8").split("\r\n").filter(Boolean)).toHaveLength(4);

    const job: Any = await exportFileJob.handler(ctx.jobContext({ name: "leads.export_file" }), {
      selector: { filter: {} },
      format: "json",
      fields: ["full_name"],
      file_name: "people.json",
    });
    expect(job.rows).toBe(3);
    expect(JSON.parse(readFileSync(job.path, "utf8"))).toHaveLength(3);
  });
});
