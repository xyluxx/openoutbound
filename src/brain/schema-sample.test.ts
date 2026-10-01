import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isoDateTime } from "../core/operation.js";
import { sampleFromSchema } from "./schema-sample.js";

describe("sampleFromSchema", () => {
  it("builds the smallest valid object", () => {
    const schema = z.object({
      subject: z.string().min(3).max(80),
      body: z.string(),
      email: z.email(),
      site: z.url(),
      when: z.iso.datetime(),
      day: z.iso.date(),
      words: z.number().int().min(20).max(90),
      score: z.number().positive(),
      angle: z.enum(["signal", "pain", "peer"]),
      kind: z.literal("draft"),
      tags: z.array(z.string()).min(2),
      maybe: z.string().optional(),
      nothing: z.string().nullable(),
      language: z.string().default("en"),
      evidence: z.array(z.object({ url: z.url(), quote: z.string() })),
      meta: z.record(z.string(), z.number()),
      pair: z.tuple([z.number(), z.string()]),
      choice: z.union([z.number().min(5), z.string()]),
      created_at: isoDateTime(),
    });
    const value = sampleFromSchema(schema);
    expect(schema.safeParse(value).success).toBe(true);
    expect(value).toMatchObject({
      subject: "sample",
      email: "sample@example.com",
      words: 20,
      score: 1,
      angle: "signal",
      kind: "draft",
      tags: ["sample", "sample"],
      nothing: null,
      language: "en",
      evidence: [],
      choice: 5,
      created_at: "2026-09-19T12:00:00.000Z",
    });
    expect("maybe" in value).toBe(false);
  });

  it("handles discriminated unions, nested defaults and refinements", () => {
    const schema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("email"), max_words: z.number().default(90) }),
      z.object({ type: z.literal("wait") }),
    ]);
    expect(sampleFromSchema(schema)).toEqual({ type: "email", max_words: 90 });
    const nested = z.object({ settings: z.object({ on: z.boolean().default(true) }).prefault({}) });
    expect(sampleFromSchema(nested)).toEqual({ settings: { on: true } });
  });

  it("throws an actionable error when no sample fits", () => {
    const schema = z.object({ code: z.string().regex(/^[A-Z]{3}-\d{4}$/) });
    expect(() => sampleFromSchema(schema)).toThrow(/explicit fake output/);
  });
});
