import { describe, expect, it } from "vitest";
import { z } from "zod";
import { outputJsonSchema, UnsupportedSchemaError } from "./json-schema.js";
import { stripNullOptionals } from "./output.js";
import { toStrictJsonSchema } from "./strict-schema.js";

const emailDraft = z.object({
  subject: z.string().min(3).max(80).describe("Subject line"),
  body: z.string(),
  angle: z.enum(["signal", "pain", "peer"]),
  kind: z.literal("draft"),
  signals_used: z.array(z.string()).max(3),
  facts_used: z.array(z.object({ text: z.string(), source: z.url() })),
  confidence: z.number().min(0).max(1),
  follow_up_days: z.number().int().optional(),
  ps: z.string().nullable(),
  language: z.string().default("en"),
  sent_at: z.iso.datetime().optional(),
  code: z.string().regex(/^[A-Z]{3}$/),
});

describe("toStrictJsonSchema", () => {
  it("closes objects, requires every property and makes optional ones nullable", () => {
    const strict = toStrictJsonSchema(outputJsonSchema(emailDraft));
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(Object.keys(emailDraft.shape));
    const props = strict.properties as Record<string, Record<string, unknown>>;
    expect(props.subject).toEqual({
      type: "string",
      description: "Subject line (minLength=3, maxLength=80)",
    });
    expect(props.angle).toEqual({ type: "string", enum: ["signal", "pain", "peer"] });
    expect(props.kind).toEqual({ type: "string", enum: ["draft"] });
    expect(props.signals_used).toEqual({ type: "array", items: { type: "string" }, maxItems: 3 });
    expect(props.facts_used).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          source: { type: "string", description: "(format=uri)" },
        },
        required: ["text", "source"],
        additionalProperties: false,
      },
    });
    expect(props.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
    expect(props.follow_up_days).toEqual({ type: ["integer", "null"] });
    expect(props.ps).toEqual({ type: ["string", "null"] });
    expect(props.language).toEqual({ type: ["string", "null"], description: '(default="en")' });
    // A supported format keeps the format and drops zod's regex for it.
    expect(props.sent_at).toEqual({ type: ["string", "null"], format: "date-time" });
    expect(props.code).toEqual({ type: "string", description: "(pattern=^[A-Z]{3}$)" });
  });

  it("round trips: strict answers with nulls parse after stripping", () => {
    const jsonSchema = outputJsonSchema(emailDraft);
    const answer = {
      subject: "Quick idea",
      body: "Hi",
      angle: "pain",
      kind: "draft",
      signals_used: [],
      facts_used: [],
      confidence: 0.8,
      follow_up_days: null,
      ps: null,
      language: null,
      sent_at: null,
      code: "ABC",
    };
    const parsed = emailDraft.parse(stripNullOptionals(answer, jsonSchema));
    expect(parsed).toMatchObject({ language: "en", ps: null });
    expect("follow_up_days" in parsed).toBe(false);
  });

  it("converts unions: oneOf to anyOf, nullable objects and refs", () => {
    const schema = z.object({
      step: z.discriminatedUnion("type", [
        z.object({ type: z.literal("email"), max_words: z.number() }),
        z.object({ type: z.literal("wait") }),
      ]),
      owner: z.object({ name: z.string() }).optional(),
      value: z.union([z.string(), z.number()]).optional(),
    });
    const strict = toStrictJsonSchema(outputJsonSchema(schema));
    const props = strict.properties as Record<string, Record<string, unknown>>;
    expect(props.step?.anyOf).toHaveLength(2);
    expect(((props.step?.anyOf ?? []) as Array<Record<string, unknown>>)[1]).toEqual({
      type: "object",
      properties: { type: { type: "string", enum: ["wait"] } },
      required: ["type"],
      additionalProperties: false,
    });
    expect(props.owner).toEqual({
      anyOf: [
        {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    });
    expect(props.value).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
    });
  });

  it("keeps recursive definitions as refs", () => {
    const node: z.ZodType<{ name: string; children: unknown[] }> = z.object({
      name: z.string(),
      get children() {
        return z.array(node);
      },
    });
    const strict = toStrictJsonSchema(outputJsonSchema(z.object({ tree: node })));
    expect(JSON.stringify(strict)).toContain('"$ref"');
    expect(strict.$defs).toBeDefined();
  });

  it("rejects shapes strict mode cannot express", () => {
    const cases: Array<[string, z.ZodType]> = [
      ["record", z.object({ meta: z.record(z.string(), z.number()) })],
      ["tuple", z.object({ pair: z.tuple([z.string(), z.number()]) })],
      ["any", z.object({ raw: z.unknown() })],
      ["any items", z.object({ list: z.array(z.any()) })],
      ["root array", z.array(z.string())],
      ["root union", z.union([z.object({ a: z.string() }), z.object({ b: z.string() })])],
    ];
    for (const [label, schema] of cases) {
      expect(() => toStrictJsonSchema(outputJsonSchema(schema)), label).toThrow(
        UnsupportedSchemaError,
      );
    }
    const allOf = {
      type: "object",
      properties: { both: { allOf: [{ type: "string" }, { minLength: 2 }] } },
    };
    expect(() => toStrictJsonSchema(allOf)).toThrow(/allOf/);
  });

  it("drops zod's safe-integer bounds on int fields", () => {
    const strict = toStrictJsonSchema(outputJsonSchema(z.object({ n: z.number().int().min(1) })));
    expect((strict.properties as Record<string, unknown>).n).toEqual({
      type: "integer",
      minimum: 1,
    });
  });

  it("rejects objects nested more than 10 levels", () => {
    let deep: z.ZodType = z.object({ leaf: z.string() });
    for (let i = 0; i < 11; i++) deep = z.object({ next: deep });
    expect(() => toStrictJsonSchema(outputJsonSchema(deep))).toThrow(/nested too deeply/);
  });

  it("accepts empty closed objects and enums of primitives only", () => {
    expect(toStrictJsonSchema(outputJsonSchema(z.object({})))).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(() =>
      toStrictJsonSchema({ type: "object", properties: { x: { enum: [{ a: 1 }] } } }),
    ).toThrow(/enum values/);
  });
});
