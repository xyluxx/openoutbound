import { describe, expect, it } from "vitest";
import { createFakeEngine } from "../../tests/e2e/fake-engine.js";
import { renderReference } from "./reference.js";

describe("renderReference", () => {
  const registry = createFakeEngine().registry;
  const files = renderReference(registry, "1.2.3");

  it("writes the four reference files", () => {
    expect(Object.keys(files).sort()).toEqual([
      "cli.md",
      "mcp-tools.md",
      "openapi.json",
      "rest-api.md",
    ]);
    expect(JSON.parse(files["openapi.json"] as string).info.version).toBe("1.2.3");
  });

  it("documents MCP tools per toolset with actions and fields", () => {
    const text = files["mcp-tools.md"] as string;
    expect(text).toContain("## Toolset `core`");
    expect(text).toContain("### `manage_items`: Items");
    expect(text).toContain("| `list` | `demo.list_items` | read | List demo items |");
    expect(text).toContain("| `item_id` | string | no | Used by: get, delete. Item id |");
    expect(text).toContain("### `send_item`: Send item");
    expect(text).toContain("Operation: `demo.send_item` (send): Send a demo item.");
    expect(text).toContain("Annotations: destructive, open world.");
    expect(text).not.toContain("| `reason` |");
    expect(text).toContain("| `dry_run` |");
  });

  it("documents CLI commands with flags", () => {
    const text = files["cli.md"] as string;
    expect(text).toContain("#### `openoutbound demo list-items`");
    expect(text).toContain("| `--min-score` | integer | no | Minimum score |");
    expect(text).toContain("| `--urgent / --no-urgent` | boolean | no | Mark as urgent |");
    expect(text).toContain("| `--status` | `open` \\| `done` | no |");
    expect(text).not.toContain("| `--workspace`");
  });

  it("documents REST routes, including RPC routes for operations without one", () => {
    const text = files["rest-api.md"] as string;
    expect(text).toContain(
      "| GET | `/v1/demo/items/:item_id` | `demo.get_item` | read | read | Get one demo item |",
    );
    expect(text).toContain(
      "| POST | `/v1/ops/demo.start_job` | `demo.start_job` | spend | spend |",
    );
  });

  it("is deterministic", () => {
    expect(renderReference(registry, "1.2.3")).toEqual(files);
  });
});
