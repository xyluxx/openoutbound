import { describe, expect, it } from "vitest";
import { z } from "zod";
import { outputJsonSchema } from "./json-schema.js";
import { describeIssues, parseJsonReply, stripNullOptionals } from "./output.js";

describe("parseJsonReply", () => {
  it("parses plain JSON, fenced JSON and JSON inside prose", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonReply('Here you go:\n```\n{"a":3}\n```\nThanks')).toEqual({ a: 3 });
    expect(parseJsonReply('Sure! {"a": {"b": [1, 2]}} Hope it helps.')).toEqual({
      a: { b: [1, 2] },
    });
    expect(parseJsonReply("[1, 2]")).toEqual([1, 2]);
    expect(parseJsonReply(`${String.fromCharCode(0xfeff)} null `)).toBeNull();
  });

  it("returns undefined for replies without JSON", () => {
    expect(parseJsonReply("I cannot help with that.")).toBeUndefined();
    expect(parseJsonReply('{"a": 1')).toBeUndefined();
    expect(parseJsonReply("")).toBeUndefined();
    expect(parseJsonReply(undefined)).toBeUndefined();
  });
});

describe("stripNullOptionals", () => {
  const schema = z.object({
    title: z.string(),
    note: z.string().optional(),
    maybe: z.string().nullable().optional(),
    count: z.number().default(3),
    items: z.array(z.object({ url: z.string(), label: z.string().optional() })),
    step: z.discriminatedUnion("type", [
      z.object({ type: z.literal("email"), subject: z.string().optional() }),
      z.object({ type: z.literal("wait"), days: z.number().optional() }),
    ]),
  });
  const jsonSchema = outputJsonSchema(schema);

  it("drops nulls only where the property is optional and not nullable", () => {
    const value = {
      title: "Hi",
      note: null,
      maybe: null,
      count: null,
      items: [{ url: "https://example.com", label: null }],
      step: { type: "wait", days: null },
      extra: null,
    };
    const stripped = stripNullOptionals(value, jsonSchema);
    expect(stripped).toEqual({
      title: "Hi",
      maybe: null,
      items: [{ url: "https://example.com" }],
      step: { type: "wait" },
      extra: null,
    });
    expect(schema.parse(stripped)).toMatchObject({ count: 3, maybe: null });
  });

  it("keeps nulls on required properties so validation can report them", () => {
    expect(stripNullOptionals({ title: null }, jsonSchema)).toEqual({ title: null });
    expect(stripNullOptionals("text", jsonSchema)).toBe("text");
  });
});

describe("describeIssues", () => {
  it("lists paths and messages with a cap", () => {
    const result = z
      .object({ a: z.string(), b: z.array(z.number()) })
      .safeParse({ a: 1, b: ["x", "y"] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const lines = describeIssues(result.error.issues, 2);
    expect(lines[0]).toMatch(/^a: /);
    expect(lines[1]).toMatch(/^b\.0: /);
    expect(lines[2]).toBe("(and 1 more problems)");
  });
});
