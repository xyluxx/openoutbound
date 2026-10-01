import { describe, expect, it } from "vitest";
import type { EmailStatus } from "../../core/enums.js";
import { WORLD } from "../world/index.js";
import { createSandboxEmailVerifier } from "./email-verifier.js";

describe("sandbox email_verifier provider", () => {
  it("is deterministic for the same input", async () => {
    const verifier = createSandboxEmailVerifier();
    const a = await verifier.verify("dana.reyes@lumenhome.example.com");
    const b = await verifier.verify("dana.reyes@lumenhome.example.com");
    expect(a).toEqual(b);
  });

  it("returns every status across a large sample of addresses", async () => {
    const verifier = createSandboxEmailVerifier();
    const seen = new Set<EmailStatus>();
    for (let i = 0; i < 300; i++) {
      const result = await verifier.verify(`person${i}@brand${i}.example.com`);
      seen.add(result.status);
    }
    expect(seen.has("valid")).toBe(true);
    expect(seen.has("invalid")).toBe(true);
    expect(seen.has("risky")).toBe(true);
    expect(seen.has("catch_all")).toBe(true);
  });

  it("always classifies the world's designated catch-all domain as catch_all", async () => {
    const verifier = createSandboxEmailVerifier();
    const domain = WORLD.northwind?.catchAllDomain;
    expect(domain).toBeTruthy();
    for (const local of ["alice", "bob", "random.person", "z"]) {
      const result = await verifier.verify(`${local}@${domain}`);
      expect(result.status).toBe("catch_all");
    }
  });
});
