import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "../mcp/catalog.js";
import { modules } from "../modules/index.js";
import { GROUP_DESCRIPTIONS, readJsonArgument } from "./operation-commands.js";
import { buildStaticRegistry } from "./static-registry.js";

describe("CLI command groups", () => {
  it("gives every group of the real modules a one-line description", () => {
    const catalog = buildCatalog(buildStaticRegistry(modules), "0.0.0");
    const groups = new Set<string>();
    for (const operation of catalog.operations) {
      for (let depth = 1; depth < operation.cli.length; depth++) {
        groups.add(operation.cli.slice(0, depth).join(" "));
      }
    }
    const missing = [...groups].filter((group) => !GROUP_DESCRIPTIONS[group]).sort();
    expect(missing).toEqual([]);
  });
});

describe("JSON from a file", () => {
  it("reads a file Windows PowerShell 5.1 wrote with Set-Content -Encoding UTF8 (a BOM first)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oo-json-"));
    try {
      const json = '{"company":{"postal_address":"12 Example Street, Zürich"}}';
      writeFileSync(join(dir, "settings.json"), `${String.fromCharCode(0xfeff)}${json}`, "utf8");
      writeFileSync(join(dir, "plain.json"), json, "utf8");
      const expected = { company: { postal_address: "12 Example Street, Zürich" } };
      expect(readJsonArgument("@settings.json", dir, "--settings")).toEqual(expected);
      expect(readJsonArgument("@plain.json", dir, "--settings")).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
