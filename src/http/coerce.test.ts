import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isOpenOutboundError } from "../core/errors.js";
import { toJsonSchema } from "../mcp/json-schema.js";
import { coerceField, coerceQuery, coerceScalar, fieldsOf } from "./coerce.js";

const schema = toJsonSchema(
  z.object({
    name: z.string().describe("Name"),
    limit: z.number().int().default(25),
    ratio: z.number().optional(),
    active: z.boolean().optional(),
    status: z.enum(["open", "done"]).optional(),
    tags: z.array(z.string()).optional(),
    ids: z.array(z.number().int()).optional(),
    rows: z.array(z.object({ a: z.string() })).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    note: z.string().nullable().optional(),
    anything: z.unknown(),
  }),
);

describe("fieldsOf", () => {
  it("describes kinds, enums, arrays and required fields", () => {
    const fields = Object.fromEntries(fieldsOf(schema).map((field) => [field.name, field]));
    expect(fields.name).toMatchObject({ kind: "string", required: true, description: "Name" });
    expect(fields.limit).toMatchObject({ kind: "integer", required: false });
    expect(fields.ratio?.kind).toBe("number");
    expect(fields.active?.kind).toBe("boolean");
    expect(fields.status).toMatchObject({ kind: "string", enum: ["open", "done"] });
    expect(fields.tags).toMatchObject({ kind: "array", itemKind: "string" });
    expect(fields.ids).toMatchObject({ kind: "array", itemKind: "integer" });
    expect(fields.rows).toMatchObject({ kind: "array", itemKind: "object" });
    expect(fields.meta?.kind).toBe("object");
    expect(fields.note?.kind).toBe("string");
    expect(fields.anything?.kind).toBe("any");
  });
});

describe("coercion", () => {
  it("converts scalars and rejects bad values with the field name", () => {
    expect(coerceScalar("42", "integer", "limit")).toBe(42);
    expect(coerceScalar("0.5", "number", "ratio")).toBe(0.5);
    expect(coerceScalar("no", "boolean", "active")).toBe(false);
    expect(coerceScalar("", "boolean", "active")).toBe(true);
    expect(coerceScalar('{"a":1}', "object", "meta")).toEqual({ a: 1 });
    expect(coerceScalar("[1]", "any", "anything")).toEqual([1]);
    expect(coerceScalar("plain", "any", "anything")).toBe("plain");
    for (const [raw, kind] of [
      ["1.5", "integer"],
      ["abc", "number"],
      ["", "number"],
      ["maybe", "boolean"],
      ["{", "object"],
    ] as const) {
      try {
        coerceScalar(raw, kind, "field_x");
        throw new Error("expected failure");
      } catch (error) {
        expect(isOpenOutboundError(error) && error.code).toBe("validation_failed");
        expect((error as Error).message).toContain("field_x");
      }
    }
  });

  it("names the file form when PowerShell 5.1 stripped the quotes of a JSON flag", () => {
    // What Windows PowerShell 5.1 hands node for --settings '{"company":{"postal_address":"x"}}'.
    const failure = (raw: string, kind: "object" | "array", name: string) => {
      try {
        coerceScalar(raw, kind, name);
      } catch (error) {
        if (isOpenOutboundError(error)) return error;
      }
      throw new Error("expected a validation error");
    };
    const stripped = failure("{company:{postal_address:x}}", "object", "settings");
    expect(stripped.code).toBe("validation_failed");
    expect(stripped.hint).toContain("Windows PowerShell 5.1");
    expect(stripped.hint).toContain("--settings '@settings.json'");
    expect(stripped.hint).toContain("docs/getting-started/install.md");
    expect(failure("[a,b]", "array", "tags").hint).toContain("--tags '@tags.json'");
    expect(failure("{api_key:x}", "object", "--secrets").hint).toContain(
      "--secrets '@secrets.json'",
    );
    expect(failure("{api_key:x}", "object", "provider_config").hint).toContain(
      "--provider-config '@provider_config.json'",
    );
    // Broken JSON that still has its quotes keeps the plain hint.
    expect(failure('{"company":', "object", "settings").hint).toBe(
      "Pass settings as a JSON object.",
    );
  });

  it("builds arrays from repeats, comma lists and JSON arrays", () => {
    const fields = Object.fromEntries(fieldsOf(schema).map((field) => [field.name, field]));
    expect(coerceField(["a,b", "c"], fields.tags as never)).toEqual(["a", "b", "c"]);
    expect(coerceField(["1,2", "3"], fields.ids as never)).toEqual([1, 2, 3]);
    expect(coerceField(['["x","y"]'], fields.tags as never)).toEqual(["x", "y"]);
    expect(coerceField(['{"a":"1"}', '{"a":"2"}'], fields.rows as never)).toEqual([
      { a: "1" },
      { a: "2" },
    ]);
    expect(coerceField([" , "], fields.tags as never)).toEqual([]);
  });

  it("maps query parameters and passes unknown ones through", () => {
    expect(
      coerceQuery({ limit: ["5"], tags: ["a", "b"], active: ["true"], extra: ["x"] }, schema),
    ).toEqual({ limit: 5, tags: ["a", "b"], active: true, extra: "x" });
  });
});
