import { describe, expect, it } from "vitest";
import { z } from "zod";
import { forbidden, notFound, OpenOutboundError, toOpenOutboundError } from "./errors.js";
import {
  awaitingApproval,
  awaitingApprovalOutput,
  backoffDelayMs,
  defineJob,
  defineOperation,
  defineTool,
  dryRun,
  dryRunOutput,
  isoDateTime,
  operationAnnotations,
  operationCliPath,
  operationScopes,
  paginated,
  paginationInput,
} from "./operation.js";

const listPeople = defineOperation({
  id: "leads.list_people",
  summary: "List people",
  description: "Lists people in the workspace.",
  effect: "read",
  input: paginationInput.extend({ status: z.string().optional() }),
  output: paginated(z.object({ id: z.string(), created_at: isoDateTime() })),
  dryRun: "none",
  idempotent: true,
  workspace: "required",
  examples: [{ title: "First page", input: { limit: 10 } }],
  handler: async () => ({
    items: [{ id: "pe_1", created_at: new Date("2026-09-19T12:00:00Z") }],
    next_cursor: null,
    has_more: false,
  }),
});

describe("defineOperation", () => {
  it("derives scopes, CLI path and annotations", () => {
    expect(operationScopes(listPeople)).toEqual(["read"]);
    expect(operationCliPath(listPeople)).toEqual(["leads", "list-people"]);
    expect(operationAnnotations(listPeople)).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(operationScopes({ effect: "destructive" })).toEqual(["write"]);
    expect(operationAnnotations({ effect: "send", idempotent: false }).openWorldHint).toBe(true);
  });

  it("parses outputs with isoDateTime into ISO strings", async () => {
    const raw = await listPeople.handler({} as never, listPeople.input.parse({}));
    expect(listPeople.output.parse(raw).items[0]?.created_at).toBe("2026-09-19T12:00:00.000Z");
    expect(listPeople.input.parse({})).toEqual({ limit: 25 });
  });

  it("rejects contract violations", () => {
    const base = {
      summary: "x",
      description: "x",
      effect: "write" as const,
      output: z.object({}),
      dryRun: "none" as const,
      idempotent: false,
      workspace: "required" as const,
      examples: [],
      handler: async () => ({}),
    };
    expect(() => defineOperation({ ...base, id: "Leads.Import", input: z.object({}) })).toThrow(
      /dotted/,
    );
    expect(() =>
      defineOperation({ ...base, id: "leads.import", input: z.object({ reason: z.string() }) }),
    ).toThrow(/executor/);
    expect(() =>
      defineOperation({ ...base, id: "leads.import", input: z.object({ listId: z.string() }) }),
    ).toThrow(/snake_case/);
    expect(() =>
      defineOperation({
        ...base,
        id: "leads.import",
        input: z.object({ rows: z.array(z.string()) }),
        examples: [{ title: "bad", input: { rows: "nope" as unknown as string[] } }],
      }),
    ).toThrow(/example "bad"/);
  });

  it("builds the standard result shapes", () => {
    expect(awaitingApprovalOutput.parse(awaitingApproval("apr_1", "Send 3 emails"))).toEqual({
      status: "awaiting_approval",
      approval_id: "apr_1",
      summary: "Send 3 emails",
    });
    const preview = dryRunOutput(z.object({ count: z.number() }));
    expect(
      preview.parse(
        dryRun({ count: 2 }, { warnings: ["2 suppressed"], estimatedCost: { credits: 4 } }),
      ),
    ).toEqual({
      dry_run: true,
      preview: { count: 2 },
      warnings: ["2 suppressed"],
      estimated_cost: { credits: 4 },
    });
  });
});

describe("defineTool and defineJob", () => {
  it("validates names", () => {
    expect(
      defineTool({
        name: "manage_knowledge",
        title: "Knowledge",
        description: "x",
        toolset: "core",
        actions: { list: "knowledge.list" },
      }),
    ).toBeTruthy();
    expect(() =>
      defineTool({
        name: "manage-knowledge",
        title: "x",
        description: "x",
        toolset: "core",
        operation: "a.b",
      }),
    ).toThrow();
    expect(() => defineJob({ name: "research", handler: async () => null })).toThrow(/dotted/);
  });

  it("computes backoff delays with jitter bounds", () => {
    const exp = { type: "exponential" as const, baseMs: 1000, maxMs: 5000 };
    expect(backoffDelayMs(exp, 1, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(exp, 3, () => 0.5)).toBe(4000);
    expect(backoffDelayMs(exp, 10, () => 0.5)).toBe(5000);
    expect(backoffDelayMs({ type: "fixed", delayMs: 100 }, 4, () => 0)).toBe(80);
  });
});

describe("errors", () => {
  it("carries code, status and hint", () => {
    const error = notFound("Person", "pe_1");
    expect(error.status).toBe(404);
    expect(error.toJSON()).toMatchObject({ code: "not_found", message: "Person pe_1 not found." });
    expect(forbidden("send").message).toContain('"send"');
    expect(
      new OpenOutboundError("limit_reached", "x", { retryAfterSeconds: 30 }).toJSON()
        .retry_after_seconds,
    ).toBe(30);
  });

  it("normalizes zod and unknown errors", () => {
    const zodError = z.object({ email: z.email() }).safeParse({ email: "nope" }).error;
    const converted = toOpenOutboundError(zodError);
    expect(converted.code).toBe("validation_failed");
    expect(converted.message).toContain("email");
    expect(toOpenOutboundError(new Error("boom")).code).toBe("internal");
    expect(toOpenOutboundError(new Error("boom")).message).not.toContain("boom");
  });
});
