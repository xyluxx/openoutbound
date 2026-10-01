import { describe, expect, it } from "vitest";
import { ID_PREFIX, idSchema, idTimestamp, isId, newId } from "./ids.js";

describe("newId", () => {
  it("has the prefix and 26 Crockford base32 chars", () => {
    const id = newId("pe");
    expect(id).toMatch(/^pe_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(isId(id, "pe")).toBe(true);
    expect(isId(id, "co")).toBe(false);
  });

  it("is unique and strictly increasing within a process", () => {
    const ids = Array.from({ length: 10_000 }, () => newId("msg"));
    expect(new Set(ids).size).toBe(ids.length);
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it("sorts by creation time and encodes the timestamp", () => {
    const early = newId("job", new Date("2026-01-01T00:00:00Z"));
    const late = newId("job", new Date("2026-09-19T12:00:00Z"));
    expect(early < late).toBe(true);
    expect(idTimestamp(late).toISOString()).toBe("2026-09-19T12:00:00.000Z");
  });

  it("defines a prefix for every table with an id", () => {
    const prefixes = Object.values(ID_PREFIX);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(ID_PREFIX.workspace).toBe("ws");
    expect(ID_PREFIX.pageSnapshot).toBe("snap");
  });

  it("idSchema validates the prefix with an actionable message", () => {
    const schema = idSchema("pe");
    expect(schema.safeParse(newId("pe")).success).toBe(true);
    const bad = schema.safeParse("co_123");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toContain("pe_");
  });
});
