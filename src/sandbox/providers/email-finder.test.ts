import { describe, expect, it } from "vitest";
import { createSandboxEmailFinder } from "./email-finder.js";

describe("sandbox email_finder provider", () => {
  it("is deterministic for the same input", async () => {
    const finder = createSandboxEmailFinder();
    const input = { first_name: "Dana", last_name: "Reyes", domain: "lumenhome.example.com" };
    const a = await finder.findEmail(input);
    const b = await finder.findEmail(input);
    expect(a).toEqual(b);
  });

  it("finds most people and misses some, deterministically", async () => {
    const finder = createSandboxEmailFinder();
    let found = 0;
    let missed = 0;
    for (let i = 0; i < 200; i++) {
      const result = await finder.findEmail({
        first_name: `First${i}`,
        last_name: `Last${i}`,
        domain: `brand${i}.example.com`,
      });
      if (result.email) found++;
      else missed++;
    }
    expect(found).toBeGreaterThan(missed);
    expect(missed).toBeGreaterThan(0);
    // Roughly 80% found: allow a wide tolerance since this is a hash-based sample, not a draw.
    expect(found / (found + missed)).toBeGreaterThan(0.6);
    expect(found / (found + missed)).toBeLessThan(0.95);
  });

  it("builds a first.last@domain address when found", async () => {
    const finder = createSandboxEmailFinder();
    for (let i = 0; i < 50; i++) {
      const result = await finder.findEmail({
        first_name: `Test${i}`,
        last_name: `Person${i}`,
        domain: "example.com",
      });
      if (result.email) {
        expect(result.email).toBe(`test${i}.person${i}@example.com`);
        return;
      }
    }
    throw new Error("expected at least one match in 50 tries");
  });

  it("returns not found without a domain", async () => {
    const finder = createSandboxEmailFinder();
    const result = await finder.findEmail({ first_name: "Dana", last_name: "Reyes" });
    expect(result.email).toBeNull();
  });
});
