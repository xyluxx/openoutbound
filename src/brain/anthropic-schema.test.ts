import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toAnthropicJsonSchema } from "./anthropic-schema.js";
import { outputJsonSchema, UnsupportedSchemaError } from "./json-schema.js";

describe("toAnthropicJsonSchema", () => {
  it("closes objects, keeps optional fields optional and moves unsupported constraints", () => {
    const schema = z.object({
      subject: z.string().min(3).max(80).describe("Subject line"),
      site: z.url(),
      email: z.email(),
      words: z.number().int().min(20).max(90),
      tags: z.array(z.string()).min(2).max(5),
      one: z.array(z.string()).min(1),
      angle: z.enum(["signal", "pain"]),
      kind: z.literal("draft"),
      note: z.string().optional(),
      language: z.string().default("en"),
      code: z.string().regex(/^[A-Z]{3}$/),
    });
    const out = toAnthropicJsonSchema(outputJsonSchema(schema));
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual([
      "subject",
      "site",
      "email",
      "words",
      "tags",
      "one",
      "angle",
      "kind",
      "code",
    ]);
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.subject).toEqual({
      type: "string",
      description: "Subject line (minLength=3, maxLength=80)",
    });
    expect(props.site).toEqual({ type: "string", format: "uri" });
    expect(props.email).toEqual({ type: "string", format: "email" });
    expect(props.words).toEqual({ type: "integer", description: "(minimum=20, maximum=90)" });
    expect(props.tags).toEqual({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "(minItems=2, maxItems=5)",
    });
    expect(props.one).toEqual({ type: "array", items: { type: "string" }, minItems: 1 });
    expect(props.angle).toEqual({ type: "string", enum: ["signal", "pain"] });
    expect(props.kind).toEqual({ type: "string", const: "draft" });
    expect(props.language).toEqual({ type: "string", default: "en" });
    expect(props.code).toEqual({ type: "string", description: "(pattern=^[A-Z]{3}$)" });
  });

  it("turns oneOf into anyOf and closes nested objects", () => {
    const schema = z.object({
      step: z.discriminatedUnion("type", [
        z.object({ type: z.literal("email") }),
        z.object({ type: z.literal("wait"), days: z.number() }),
      ]),
    });
    const out = toAnthropicJsonSchema(outputJsonSchema(schema));
    const step = (out.properties as Record<string, Record<string, unknown>>).step;
    expect(step?.anyOf).toHaveLength(2);
    for (const variant of (step?.anyOf ?? []) as Array<Record<string, unknown>>) {
      expect(variant.additionalProperties).toBe(false);
    }
  });

  it("rejects recursion, records, open values and too many optional or union fields", () => {
    const node: z.ZodType<{ name: string; children: unknown[] }> = z.object({
      name: z.string(),
      get children() {
        return z.array(node);
      },
    });
    const manyOptional = z.object(
      Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, z.string().optional()])),
    );
    const manyUnions = z.object(
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, z.string().nullable()])),
    );
    const cases: Array<[string, z.ZodType]> = [
      ["recursive", z.object({ tree: node })],
      ["record", z.object({ meta: z.record(z.string(), z.string()) })],
      ["unknown", z.object({ raw: z.unknown() })],
      ["tuple", z.object({ pair: z.tuple([z.string(), z.string()]) })],
      ["optional limit", manyOptional],
      ["union limit", manyUnions],
    ];
    for (const [label, schema] of cases) {
      expect(() => toAnthropicJsonSchema(outputJsonSchema(schema)), label).toThrow(
        UnsupportedSchemaError,
      );
    }
  });
});
