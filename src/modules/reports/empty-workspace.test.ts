import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../../testing/context.js";
import { getAttention } from "./operations/get-attention.js";
import { getReport } from "./operations/get-report.js";
import { REPORT_FORMATS, REPORT_TYPES } from "./schemas.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ principal: { workspaceId: null } });
});

afterAll(async () => {
  await ctx.close();
});

describe("reports on an empty workspace", () => {
  for (const type of REPORT_TYPES) {
    for (const format of REPORT_FORMATS) {
      it(`${type} as ${format} runs and parses`, async () => {
        const raw = await getReport.handler(ctx, getReport.input.parse({ type, format }));
        const output = getReport.output.parse(raw);
        expect(output.type).toBe(type);
        expect(output.format).toBe(format);
        if (format === "json") expect(output.data?.type).toBe(type);
        if (format === "markdown") expect(output.markdown).toContain("## ");
        if (format === "csv") expect(output.csv?.split("\r\n")[0]).toMatch(/^[a-z_]+,/);
        expect(output.definitions.rates).toBeDefined();
      });
    }
  }

  it("the attention queue runs and parses", async () => {
    const output = getAttention.output.parse(
      await getAttention.handler(ctx, getAttention.input.parse({})),
    );
    expect(output.counts.approvals).toBe(0);
    expect(output.setup.complete).toBe(false);
    expect(output.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(output.warnings[0]?.code).toBe("provider_missing");
    expect(output.next_step).toContain("brain");
  });
});
