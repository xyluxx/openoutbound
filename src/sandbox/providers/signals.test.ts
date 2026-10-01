import { describe, expect, it } from "vitest";
import { WORLD } from "../world/index.js";
import { createSandboxSignals } from "./signals.js";

describe("sandbox signals provider", () => {
  it("is deterministic for the same company", async () => {
    const provider = createSandboxSignals();
    const world = WORLD.northwind;
    expect(world).toBeDefined();
    const withSignals = world?.companies.find((c) =>
      world.signals.some((s) => s.companyKey === c.key),
    );
    expect(withSignals).toBeDefined();
    if (!withSignals) return;
    const target = {
      company: { id: "co_test", name: withSignals.name, domain: withSignals.domain },
    };
    const a = await provider.collect(target);
    const b = await provider.collect(target);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("matches the world's pre-seeded signals for that company exactly", async () => {
    const provider = createSandboxSignals();
    const world = WORLD.brightsmile;
    expect(world).toBeDefined();
    const company = world?.companies.find((c) => world.signals.some((s) => s.companyKey === c.key));
    expect(company).toBeDefined();
    if (!world || !company) return;
    const expected = world.signals.filter((s) => s.companyKey === company.key).map((s) => s.raw);
    const result = await provider.collect({
      company: { id: "co_x", name: company.name, domain: company.domain },
    });
    expect(result).toEqual(expected);
  });

  it("filters by signalKeys", async () => {
    const provider = createSandboxSignals();
    const world = WORLD.northwind;
    const company = world?.companies.find(
      (c) => (world?.signals.filter((s) => s.companyKey === c.key).length ?? 0) > 0,
    );
    expect(company).toBeDefined();
    if (!company) return;
    const target = { company: { id: "co_y", name: company.name, domain: company.domain } };
    const all = await provider.collect(target);
    const key = all[0]?.definition_key;
    expect(key).toBeDefined();
    if (!key) return;
    const filtered = await provider.collect(target, { signalKeys: [key] });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((s) => s.definition_key === key)).toBe(true);
  });

  it("returns an empty array for a company not in the sandbox world", async () => {
    const provider = createSandboxSignals();
    const result = await provider.collect({
      company: { id: "co_z", name: "Unknown Co", domain: "unknown.example.com" },
    });
    expect(result).toEqual([]);
  });
});
